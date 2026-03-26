/**
 * AI Chat API — proxies user messages to OpenRouter with library-aware tool calling.
 */

import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { db } from './db.js';
import { meili } from './meili.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface AiChatBody {
  messages: { role: 'user' | 'assistant'; content: string }[];
}

// Build a summary of the user's library for the system prompt
async function buildLibraryContext(userId: string): Promise<string> {
  const [trackCount, genres, artistGenres, moods] = await Promise.all([
    db().query<{ count: string }>('SELECT count(*) FROM active_tracks'),
    db().query<{ genre: string; cnt: string }>(
      `SELECT genre, count(*) as cnt FROM track_genres
       GROUP BY genre ORDER BY cnt DESC LIMIT 20`
    ),
    // Get artists with their genres for smarter recommendations
    db().query<{ artist: string; genres: string; cnt: string }>(
      `SELECT t.artist, 
              string_agg(DISTINCT tg.genre, ', ') as genres,
              count(DISTINCT t.id)::text as cnt
       FROM active_tracks t
       LEFT JOIN track_genres tg ON tg.track_id = t.id
       WHERE t.artist IS NOT NULL
       GROUP BY t.artist ORDER BY count(DISTINCT t.id) DESC LIMIT 30`
    ),
    db().query<{ mood: string; cnt: string }>(
      `SELECT mood, count(*) as cnt FROM active_tracks
       WHERE mood IS NOT NULL AND mood != ''
       GROUP BY mood ORDER BY cnt DESC LIMIT 15`
    ),
  ]);

  const total = trackCount.rows[0]?.count ?? '0';
  const topGenres = genres.rows.map(r => r.genre).join(', ') || 'unknown';
  const artistList = artistGenres.rows
    .map(r => `${r.artist} (${r.cnt} tracks, ${r.genres || 'untagged'})`)
    .join('\n  - ') || 'unknown';
  const topMoods = moods.rows.map(r => r.mood).join(', ') || 'none tagged';

  return `The user's music library has ${total} tracks.
Genres: ${topGenres}
Moods: ${topMoods}
Artists in library:
  - ${artistList}
IMPORTANT: Only these artists exist in the library. You MUST use your world knowledge about each artist's actual musical style to match requests accurately.`;
}

const TOOL_DEFS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_tracks',
      description: 'Search the user\'s LOCAL music library using fuzzy matching. Handles partial names and misspellings. Search for specific artist names, song titles, or album names — not abstract concepts like "chill" or "Polish". Make multiple calls with different artist names to gather enough tracks.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Artist name, song title, or album name to search for' },
          genre: { type: 'string', description: 'Optional genre filter (exact match, e.g. "Rock", "Rap", "Electronic")' },
          artist: { type: 'string', description: 'Optional artist name filter' },
          limit: { type: 'number', description: 'Max results (default 10, max 50)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'play_tracks',
      description: 'Play specific tracks immediately. Use this when the user wants to listen to music now. Returns the track list for the client player.',
      parameters: {
        type: 'object',
        properties: {
          track_ids: { type: 'array', items: { type: 'number' }, description: 'Array of track IDs to play' },
        },
        required: ['track_ids'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'queue_tracks',
      description: 'Add tracks to the playback queue without interrupting current playback.',
      parameters: {
        type: 'object',
        properties: {
          track_ids: { type: 'array', items: { type: 'number' }, description: 'Array of track IDs to queue' },
        },
        required: ['track_ids'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_playlist',
      description: 'Create a new playlist with the given tracks.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Playlist name' },
          track_ids: { type: 'array', items: { type: 'number' }, description: 'Track IDs to add' },
        },
        required: ['name', 'track_ids'],
      },
    },
  },
];

// Execute a tool call against the local database / search
async function executeTool(name: string, args: Record<string, unknown>, userId: string): Promise<unknown> {
  switch (name) {
    case 'search_tracks': {
      const q = (args.query as string) || '';
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);

      // Use Meilisearch for fuzzy full-text search (handles typos, partial matches, etc.)
      try {
        const index = meili().index('tracks');

        // Build filter array for Meilisearch
        const filters: string[] = [];
        if (args.genre) filters.push(`genre = "${(args.genre as string).replace(/"/g, '\\"')}"`);
        if (args.artist) filters.push(`artist = "${(args.artist as string).replace(/"/g, '\\"')}"`);

        const res = await index.search(q, {
          limit,
          filter: filters.length > 0 ? filters.join(' AND ') : undefined,
          attributesToRetrieve: ['id', 'title', 'artist', 'album', 'genre', 'country', 'duration_ms'],
        });

        if (res.hits.length > 0) {
          return { tracks: res.hits, source: 'meilisearch' };
        }

        // If filtered search returned nothing, retry without filters (broader match)
        if (filters.length > 0) {
          const broader = await index.search(q, {
            limit,
            attributesToRetrieve: ['id', 'title', 'artist', 'album', 'genre', 'country', 'duration_ms'],
          });
          if (broader.hits.length > 0) {
            return { tracks: broader.hits, source: 'meilisearch_broad' };
          }
        }
      } catch {
        // Meilisearch unavailable, fall back to SQL
      }

      // SQL fallback with ILIKE for broader matching
      const conditions: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (q) {
        // Split query into words for broader matching
        const words = q.split(/\s+/).filter(w => w.length > 1);
        if (words.length > 0) {
          const wordConditions = words.map(() => {
            const p = `$${idx++}`;
            return `(title ILIKE ${p} OR artist ILIKE ${p} OR album ILIKE ${p} OR genre ILIKE ${p})`;
          });
          conditions.push(`(${wordConditions.join(' OR ')})`);
          params.push(...words.map(w => `%${w}%`));
        }
      }
      if (args.artist) {
        conditions.push(`artist ILIKE $${idx}`);
        params.push(`%${args.artist as string}%`);
        idx++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const r = await db().query<{
        id: number; title: string; artist: string; album: string; genre: string; duration_ms: number;
      }>(
        `SELECT id, title, artist, album, genre, duration_ms
         FROM active_tracks ${where}
         ORDER BY random() LIMIT $${idx}`,
        [...params, limit]
      );
      return { tracks: r.rows, source: 'sql' };
    }

    case 'play_tracks':
    case 'queue_tracks': {
      const ids = (args.track_ids as number[]) || [];
      if (ids.length === 0) return { tracks: [] };

      const r = await db().query<{
        id: number; title: string; artist: string; album: string; duration_ms: number;
      }>(
        `SELECT id, title, artist, album, duration_ms FROM active_tracks
         WHERE id = ANY($1)`,
        [ids]
      );
      // Preserve requested order
      const byId = new Map(r.rows.map(t => [t.id, t]));
      const ordered = ids.map(id => byId.get(id)).filter(Boolean);
      return { action: name === 'play_tracks' ? 'play' : 'queue', tracks: ordered };
    }

    case 'create_playlist': {
      const plName = (args.name as string) || 'AI Playlist';
      const ids = (args.track_ids as number[]) || [];

      const plR = await db().query<{ id: number }>(
        'INSERT INTO playlists(user_id, name) VALUES ($1, $2) RETURNING id',
        [userId, plName]
      );
      const plId = plR.rows[0]!.id;

      for (let i = 0; i < ids.length; i++) {
        await db().query(
          'INSERT INTO playlist_items(playlist_id, track_id, position) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [plId, ids[i], i]
        );
      }

      return { action: 'created_playlist', playlist: { id: plId, name: plName, track_count: ids.length } };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function buildSystemPrompt(libraryContext: string): string {
  return `You are an AI music assistant for mvbar, a self-hosted music streaming app.
You help users discover, play, and organize their music library through natural conversation.

${libraryContext}

HOW TO HANDLE REQUESTS:
1. The user's library is LOCAL — only the artists listed above are available.
2. When the user requests a mood/vibe/genre (e.g. "romantic music", "chill night drive"):
   - Use YOUR WORLD KNOWLEDGE about each artist's actual discography and musical style.
   - Only select artists whose music GENUINELY fits the request.
   - For example: Eminem is NOT romantic music. Metallica is NOT chill. Be accurate.
   - If no artists in the library truly match the requested mood, be HONEST and say so.
   - Suggest the closest match and explain why, e.g. "Your library is mostly rap and metal. The closest to romantic might be Dawid Podsiadło's pop tracks."
3. You can also search by song title — some individual songs may fit even if the artist generally doesn't.
   - Example: "Love The Way You Lie" by Eminem could work for an emotional playlist even though Eminem isn't typically "romantic".
4. Make MULTIPLE search_tracks calls for different matching artists to gather enough tracks.
5. After finding tracks, ALWAYS call play_tracks (if user said "play") or queue_tracks (if "queue").
6. If the user asks for a specific number of tracks, try to get at least that many.
7. When creating playlists, search for tracks first, then call create_playlist with the found track IDs.
8. Keep responses concise. Tell the user what you're playing and why it fits their request.
9. Be honest when the library doesn't have great matches — don't force bad recommendations.`;
}

export const aiPlugin: FastifyPluginAsync = fp(async (app) => {
  app.post('/api/ai/chat', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const body = req.body as AiChatBody;
    if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      return reply.code(400).send({ ok: false, error: 'messages required' });
    }

    // Get user's OpenRouter API key
    const keyR = await db().query<{ openrouter_api_key: string }>(
      'SELECT openrouter_api_key FROM user_preferences WHERE user_id = $1',
      [req.user.userId]
    );
    const apiKey = keyR.rows[0]?.openrouter_api_key;
    if (!apiKey) {
      return reply.code(400).send({ ok: false, error: 'OpenRouter API key not configured. Set it in Settings → Integrations.' });
    }

    // Build system prompt with library context
    const libraryContext = await buildLibraryContext(req.user.userId);
    const systemPrompt = buildSystemPrompt(libraryContext);

    // Trim conversation to last 10 messages to stay within token limits
    const trimmedMessages = body.messages.slice(-10);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...trimmedMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    try {
      // Call OpenRouter (may require multiple rounds for tool calls)
      let finalResponse = '';
      const toolResults: unknown[] = [];
      let rounds = 0;
      const MAX_ROUNDS = 3;

      while (rounds < MAX_ROUNDS) {
        rounds++;

        const orResponse = await fetch(OPENROUTER_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://github.com/mariof1/mvbar',
            'X-Title': 'mvbar Music Assistant',
          },
          body: JSON.stringify({
            model: DEFAULT_MODEL,
            messages,
            tools: TOOL_DEFS,
            route: 'fallback',
            provider: { allow_fallbacks: true },
          }),
        });

        if (!orResponse.ok) {
          const errText = await orResponse.text();
          app.log.error(`OpenRouter error ${orResponse.status}: ${errText}`);
          return reply.code(502).send({
            ok: false,
            error: orResponse.status === 401
              ? 'Invalid OpenRouter API key. Please update it in Settings → Integrations.'
              : `AI service error (${orResponse.status})`,
          });
        }

        const data = await orResponse.json() as {
          choices: Array<{
            message: {
              content?: string;
              tool_calls?: ToolCall[];
              role: string;
            };
            finish_reason: string;
          }>;
        };

        const choice = data.choices?.[0];
        if (!choice) {
          app.log.error(`OpenRouter empty choices: ${JSON.stringify(data)}`);
          return reply.code(502).send({ ok: false, error: 'Empty response from AI service' });
        }

        const msg = choice.message;
        app.log.info(`[ai] Round ${rounds}: finish=${choice.finish_reason} tool_calls=${msg.tool_calls?.length ?? 0} content_len=${(msg.content || '').length}`);

        // If no tool calls, we have our final answer
        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          finalResponse = msg.content || (toolResults.length > 0
            ? 'Here are the results!'
            : 'I couldn\'t generate a response. Please try rephrasing your request.');
          break;
        }

        // Execute tool calls
        messages.push({
          role: 'assistant',
          content: msg.content || '',
          tool_calls: msg.tool_calls,
        });

        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            args = {};
          }

          const result = await executeTool(tc.function.name, args, req.user.userId);
          toolResults.push({ tool: tc.function.name, args, result });

          messages.push({
            role: 'tool',
            content: JSON.stringify(result),
            tool_call_id: tc.id,
          });
        }

        // If this was the last allowed round, break
        if (rounds >= MAX_ROUNDS) {
          finalResponse = msg.content || 'I found some results for you!';
          break;
        }
      }

      return {
        ok: true,
        response: finalResponse,
        toolResults,
      };
    } catch (err) {
      app.log.error(`AI chat error: ${err}`);
      return reply.code(500).send({ ok: false, error: 'Failed to process AI request' });
    }
  });
});
