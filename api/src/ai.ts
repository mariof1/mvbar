/**
 * AI Chat API — proxies user messages to OpenRouter with library-aware tool calling.
 */

import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { db } from './db.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'openrouter/auto';

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
  const [trackCount, genres, artists, moods] = await Promise.all([
    db().query<{ count: string }>('SELECT count(*) FROM active_tracks'),
    db().query<{ genre: string; cnt: string }>(
      `SELECT genre, count(*) as cnt FROM track_genres
       GROUP BY genre ORDER BY cnt DESC LIMIT 20`
    ),
    db().query<{ name: string; cnt: string }>(
      `SELECT a.name, count(t.id) as cnt FROM artists a
       JOIN active_tracks t ON t.artist = a.name
       GROUP BY a.name ORDER BY cnt DESC LIMIT 30`
    ),
    db().query<{ mood: string; cnt: string }>(
      `SELECT mood, count(*) as cnt FROM active_tracks
       WHERE mood IS NOT NULL AND mood != ''
       GROUP BY mood ORDER BY cnt DESC LIMIT 15`
    ),
  ]);

  const total = trackCount.rows[0]?.count ?? '0';
  const topGenres = genres.rows.map(r => r.genre).join(', ') || 'unknown';
  const topArtists = artists.rows.map(r => `${r.name} (${r.cnt} tracks)`).join(', ') || 'unknown';
  const topMoods = moods.rows.map(r => r.mood).join(', ') || 'none tagged';

  return `The user's music library has ${total} tracks.
Top genres: ${topGenres}
Artists in library: ${topArtists}
Top moods: ${topMoods}
IMPORTANT: Only these artists/tracks exist in the library. Search for these exact names.`;
}

const TOOL_DEFS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_tracks',
      description: 'Search the music library for tracks matching a query. Returns track IDs, titles, artists, albums, genres, and durations.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text search query (song title, artist, album, etc.)' },
          genre: { type: 'string', description: 'Filter by genre' },
          mood: { type: 'string', description: 'Filter by mood' },
          artist: { type: 'string', description: 'Filter by artist name' },
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

      // Build SQL search against active_tracks (Meilisearch may not be available from API context)
      const conditions: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (q) {
        conditions.push(`(lower(title) LIKE $${idx} OR lower(artist) LIKE $${idx} OR lower(album) LIKE $${idx})`);
        params.push(`%${q.toLowerCase()}%`);
        idx++;
      }
      if (args.genre) {
        conditions.push(`lower(genre) LIKE $${idx}`);
        params.push(`%${(args.genre as string).toLowerCase()}%`);
        idx++;
      }
      if (args.mood) {
        conditions.push(`lower(mood) LIKE $${idx}`);
        params.push(`%${(args.mood as string).toLowerCase()}%`);
        idx++;
      }
      if (args.artist) {
        conditions.push(`lower(artist) LIKE $${idx}`);
        params.push(`%${(args.artist as string).toLowerCase()}%`);
        idx++;
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const r = await db().query<{
        id: number; title: string; artist: string; album: string; genre: string; mood: string; duration_ms: number;
      }>(
        `SELECT id, title, artist, album, genre, mood, duration_ms
         FROM active_tracks ${where}
         ORDER BY random() LIMIT $${idx}`,
        [...params, limit]
      );
      return { tracks: r.rows };
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

IMPORTANT search guidelines:
- The search_tracks tool searches the user's LOCAL library only (not the internet).
- The query field does full-text search on title, artist, and album fields.
- The genre field filters by genre tag (e.g. "Rock", "Rap", "Electronic").
- When the user asks for music by category (e.g. "Polish hip hop", "chill jazz", "90s rock"):
  1. Use your knowledge to identify actual artist names or song titles that fit the category.
  2. Search for those specific artists/titles — NOT abstract descriptions like "polish" or "chill".
  3. You can make MULTIPLE search_tracks calls in parallel to find different artists.
  4. Example: "play Polish hip hop" → search for "Taco Hemingway", "Bedoes", "Quebonafide", etc.
- When a search returns 0 results, try searching for related artists or broader terms.
- ALWAYS use play_tracks after finding tracks if the user asked to play/listen. Don't just list results.
- When asked to queue songs, search first then use queue_tracks.
- When asked to create a playlist, search for tracks and then use create_playlist.
- Keep responses concise and musical. Use emoji sparingly.
- You can combine multiple tool calls in a single response.
- Always tell the user what you found and what you're doing.`;
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
