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

interface NowPlaying {
  id: number;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
}

interface AiChatBody {
  messages: { role: 'user' | 'assistant'; content: string }[];
  nowPlaying?: NowPlaying | null;
}

// Build a summary of the user's library for the system prompt
async function buildLibraryContext(userId: string): Promise<string> {
  const [trackCount, genres, artistGenres, moods] = await Promise.all([
    db().query<{ count: string }>('SELECT count(*) FROM active_tracks'),
    db().query<{ genre: string; cnt: string }>(
      `SELECT genre, count(*) as cnt FROM track_genres
       GROUP BY genre ORDER BY cnt DESC LIMIT 20`
    ),
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

async function loadUserMemories(userId: string): Promise<string> {
  const r = await db().query<{ fact: string }>(
    'SELECT fact FROM ai_memory WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30',
    [userId]
  );
  if (r.rows.length === 0) return '';
  return '\nTHINGS YOU REMEMBER ABOUT THIS USER:\n' +
    r.rows.map(r => `- ${r.fact}`).join('\n');
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
      description: 'Play specific tracks immediately. Use this when the user wants to listen to music now.',
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
  {
    type: 'function' as const,
    function: {
      name: 'get_unplayed_tracks',
      description: 'Get tracks the user has NEVER played. Great for discovering forgotten music in the library.',
      parameters: {
        type: 'object',
        properties: {
          genre: { type: 'string', description: 'Optional genre filter (e.g. "Rock", "Rap")' },
          artist: { type: 'string', description: 'Optional artist name filter' },
          limit: { type: 'number', description: 'Max results (default 20, max 50)' },
          order: { type: 'string', enum: ['random', 'newest'], description: 'Order: "random" (default) for discovery, "newest" for recently added' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_listening_stats',
      description: 'Get the user\'s listening statistics. Use for "what do I listen to most?", "my top artists", "recently played", etc.',
      parameters: {
        type: 'object',
        properties: {
          stat_type: {
            type: 'string',
            enum: ['top_tracks', 'recently_played', 'least_played', 'top_artists', 'top_genres'],
            description: 'Type of stats to retrieve',
          },
          limit: { type: 'number', description: 'Max results (default 20, max 50)' },
          period: { type: 'string', enum: ['today', 'week', 'month', 'all_time'], description: 'Time period filter (default: all_time). Only applies to top_tracks, top_artists, top_genres.' },
        },
        required: ['stat_type'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'smart_mix',
      description: 'Create a smart mix that blends the user\'s favorites/top tracks with unplayed or rarely played tracks. Perfect for "mix my favorites with something new" or "surprise me with a blend".',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'Total number of tracks in the mix (default 20, max 50)' },
          favorites_ratio: { type: 'number', description: 'Ratio of favorites to new tracks, 0.0 to 1.0 (default 0.5 = 50% favorites, 50% new)' },
          genre: { type: 'string', description: 'Optional genre filter for the whole mix' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_favorites',
      description: 'Get the user\'s favorite/liked tracks. Use when user asks "play my favorites", "what songs have I liked?", etc.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max results (default 20, max 50)' },
          artist: { type: 'string', description: 'Optional artist filter' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'toggle_favorite',
      description: 'Add or remove tracks from the user\'s favorites. Use when user says "I love this", "like this song", "unlike this", etc.',
      parameters: {
        type: 'object',
        properties: {
          track_ids: { type: 'array', items: { type: 'number' }, description: 'Track IDs to toggle favorite status' },
          action: { type: 'string', enum: ['add', 'remove'], description: 'Whether to add or remove from favorites' },
        },
        required: ['track_ids', 'action'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'manage_playlist',
      description: 'Manage playlists: list all playlists, add tracks to an existing playlist, or remove tracks from a playlist.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'add_tracks', 'remove_tracks'], description: 'Action to perform' },
          playlist_id: { type: 'number', description: 'Playlist ID (required for add_tracks/remove_tracks)' },
          playlist_name: { type: 'string', description: 'Playlist name to search for (alternative to playlist_id)' },
          track_ids: { type: 'array', items: { type: 'number' }, description: 'Track IDs to add/remove' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'control_playback',
      description: 'Control the music player: skip to next track, go back, shuffle the queue, or clear the queue.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['next', 'prev', 'shuffle', 'clear_queue'], description: 'Playback control action' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_library_info',
      description: 'Get library statistics: total tracks, artists, albums, genres, total size, recently added tracks, and recent scan info.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'save_memory',
      description: 'Remember something about the user\'s preferences for future conversations. Use this when the user explicitly shares a preference, e.g. "I like chill music for working", "I prefer Polish rap", "I don\'t like metal". Only save genuine, lasting preferences — not temporary requests.',
      parameters: {
        type: 'object',
        properties: {
          fact: { type: 'string', description: 'The preference or fact to remember about the user' },
        },
        required: ['fact'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_similar',
      description: 'Find tracks similar to a given track or artist. Uses genre, mood, and artist relationships to find related music in the library.',
      parameters: {
        type: 'object',
        properties: {
          track_id: { type: 'number', description: 'Find tracks similar to this track' },
          artist: { type: 'string', description: 'Find tracks similar to this artist\'s style' },
          limit: { type: 'number', description: 'Max results (default 15, max 50)' },
        },
        required: [],
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

      try {
        const index = meili().index('tracks');
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

      const conditions: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (q) {
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
        `SELECT id, title, artist, album, duration_ms FROM active_tracks WHERE id = ANY($1)`,
        [ids]
      );
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

    case 'get_unplayed_tracks': {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
      const order = (args.order as string) === 'newest' ? 't.id DESC' : 'random()';

      const conditions: string[] = [];
      const params: unknown[] = [userId];
      let idx = 2;

      if (args.genre) {
        conditions.push(`EXISTS (SELECT 1 FROM track_genres tg WHERE tg.track_id = t.id AND tg.genre ILIKE $${idx})`);
        params.push(`%${args.genre as string}%`);
        idx++;
      }
      if (args.artist) {
        conditions.push(`t.artist ILIKE $${idx}`);
        params.push(`%${args.artist as string}%`);
        idx++;
      }

      const where = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

      const r = await db().query<{
        id: number; title: string; artist: string; album: string; genre: string; duration_ms: number;
      }>(
        `SELECT t.id, t.title, t.artist, t.album, t.genre, t.duration_ms
         FROM active_tracks t
         WHERE NOT EXISTS (
           SELECT 1 FROM user_track_stats uts
           WHERE uts.track_id = t.id AND uts.user_id = $1 AND uts.play_count > 0
         )
         ${where}
         ORDER BY ${order} LIMIT $${idx}`,
        [...params, limit]
      );
      return { tracks: r.rows, total_unplayed: r.rows.length };
    }

    case 'get_listening_stats': {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
      const statType = args.stat_type as string;
      const period = args.period as string || 'all_time';

      // Build date filter for time-based queries
      let dateFilter = '';
      const dateParam: string[] = [];
      if (period !== 'all_time') {
        const intervals: Record<string, string> = { today: '1 day', week: '7 days', month: '30 days' };
        const interval = intervals[period] || '7 days';
        dateFilter = `AND ph.played_at >= now() - interval '${interval}'`;
      }

      switch (statType) {
        case 'top_tracks': {
          if (period !== 'all_time') {
            // Time-filtered: aggregate from play_history
            const r = await db().query<{
              id: number; title: string; artist: string; album: string;
              play_count: string; last_played_at: string;
            }>(
              `SELECT t.id, t.title, t.artist, t.album,
                      COUNT(*)::text as play_count, MAX(ph.played_at)::text as last_played_at
               FROM play_history ph
               JOIN active_tracks t ON t.id = ph.track_id
               WHERE ph.user_id = $1 ${dateFilter}
               GROUP BY t.id, t.title, t.artist, t.album
               ORDER BY COUNT(*) DESC
               LIMIT $2`,
              [userId, limit]
            );
            return { stat_type: 'top_tracks', period, tracks: r.rows };
          }
          const r = await db().query<{
            id: number; title: string; artist: string; album: string;
            play_count: number; skip_count: number; last_played_at: string;
          }>(
            `SELECT t.id, t.title, t.artist, t.album,
                    uts.play_count, uts.skip_count, uts.last_played_at
             FROM user_track_stats uts
             JOIN active_tracks t ON t.id = uts.track_id
             WHERE uts.user_id = $1 AND uts.play_count > 0
             ORDER BY uts.play_count DESC, uts.last_played_at DESC
             LIMIT $2`,
            [userId, limit]
          );
          return { stat_type: 'top_tracks', tracks: r.rows };
        }

        case 'recently_played': {
          const r = await db().query<{
            id: number; title: string; artist: string; album: string; played_at: string;
          }>(
            `SELECT DISTINCT ON (t.id) t.id, t.title, t.artist, t.album, ph.played_at
             FROM play_history ph
             JOIN active_tracks t ON t.id = ph.track_id
             WHERE ph.user_id = $1
             ORDER BY t.id, ph.played_at DESC`,
            [userId]
          );
          // Re-sort by played_at desc and limit
          r.rows.sort((a, b) => new Date(b.played_at).getTime() - new Date(a.played_at).getTime());
          return { stat_type: 'recently_played', tracks: r.rows.slice(0, limit) };
        }

        case 'least_played': {
          const r = await db().query<{
            id: number; title: string; artist: string; album: string;
            play_count: number; last_played_at: string;
          }>(
            `SELECT t.id, t.title, t.artist, t.album,
                    COALESCE(uts.play_count, 0) as play_count,
                    uts.last_played_at
             FROM active_tracks t
             LEFT JOIN user_track_stats uts ON uts.track_id = t.id AND uts.user_id = $1
             ORDER BY COALESCE(uts.play_count, 0) ASC, random()
             LIMIT $2`,
            [userId, limit]
          );
          return { stat_type: 'least_played', tracks: r.rows };
        }

        case 'top_artists': {
          if (period !== 'all_time') {
            const r = await db().query<{
              artist: string; total_plays: string; track_count: string;
            }>(
              `SELECT t.artist, COUNT(*)::text as total_plays,
                      COUNT(DISTINCT t.id)::text as track_count
               FROM play_history ph
               JOIN active_tracks t ON t.id = ph.track_id
               WHERE ph.user_id = $1 AND t.artist IS NOT NULL ${dateFilter}
               GROUP BY t.artist
               ORDER BY COUNT(*) DESC
               LIMIT $2`,
              [userId, limit]
            );
            return { stat_type: 'top_artists', period, artists: r.rows };
          }
          const r = await db().query<{
            artist: string; total_plays: string; track_count: string;
          }>(
            `SELECT t.artist, SUM(uts.play_count)::text as total_plays,
                    COUNT(DISTINCT t.id)::text as track_count
             FROM user_track_stats uts
             JOIN active_tracks t ON t.id = uts.track_id
             WHERE uts.user_id = $1 AND uts.play_count > 0 AND t.artist IS NOT NULL
             GROUP BY t.artist
             ORDER BY SUM(uts.play_count) DESC
             LIMIT $2`,
            [userId, limit]
          );
          return { stat_type: 'top_artists', artists: r.rows };
        }

        case 'top_genres': {
          if (period !== 'all_time') {
            const r = await db().query<{
              genre: string; total_plays: string;
            }>(
              `SELECT tg.genre, COUNT(*)::text as total_plays
               FROM play_history ph
               JOIN track_genres tg ON tg.track_id = ph.track_id
               WHERE ph.user_id = $1 ${dateFilter}
               GROUP BY tg.genre
               ORDER BY COUNT(*) DESC
               LIMIT $2`,
              [userId, limit]
            );
            return { stat_type: 'top_genres', period, genres: r.rows };
          }
          const r = await db().query<{
            genre: string; total_plays: string;
          }>(
            `SELECT tg.genre, SUM(uts.play_count)::text as total_plays
             FROM user_track_stats uts
             JOIN track_genres tg ON tg.track_id = uts.track_id
             WHERE uts.user_id = $1 AND uts.play_count > 0
             GROUP BY tg.genre
             ORDER BY SUM(uts.play_count) DESC
             LIMIT $2`,
            [userId, limit]
          );
          return { stat_type: 'top_genres', genres: r.rows };
        }

        default:
          return { error: `Unknown stat_type: ${statType}` };
      }
    }

    case 'smart_mix': {
      const count = Math.min(Math.max(Number(args.count) || 20, 1), 50);
      const ratio = Math.min(Math.max(Number(args.favorites_ratio) ?? 0.5, 0), 1);
      const favCount = Math.round(count * ratio);
      const newCount = count - favCount;

      const genreFilter = args.genre ? `AND EXISTS (SELECT 1 FROM track_genres tg WHERE tg.track_id = t.id AND tg.genre ILIKE '%${(args.genre as string).replace(/'/g, "''")}%')` : '';

      // Get favorites / top played
      const favs = await db().query<{
        id: number; title: string; artist: string; album: string; duration_ms: number;
      }>(
        `SELECT t.id, t.title, t.artist, t.album, t.duration_ms
         FROM active_tracks t
         LEFT JOIN favorite_tracks ft ON ft.track_id = t.id AND ft.user_id = $1
         LEFT JOIN user_track_stats uts ON uts.track_id = t.id AND uts.user_id = $1
         WHERE (ft.user_id IS NOT NULL OR COALESCE(uts.play_count, 0) > 2) ${genreFilter}
         ORDER BY random() LIMIT $2`,
        [userId, favCount]
      );

      // Get unplayed / rarely played
      const fresh = await db().query<{
        id: number; title: string; artist: string; album: string; duration_ms: number;
      }>(
        `SELECT t.id, t.title, t.artist, t.album, t.duration_ms
         FROM active_tracks t
         LEFT JOIN user_track_stats uts ON uts.track_id = t.id AND uts.user_id = $1
         WHERE COALESCE(uts.play_count, 0) <= 1 ${genreFilter}
         AND t.id NOT IN (SELECT unnest($2::bigint[]))
         ORDER BY random() LIMIT $3`,
        [userId, favs.rows.map(t => t.id), newCount]
      );

      // Interleave: alternate between favorites and new tracks
      const mixed: typeof favs.rows = [];
      const f = [...favs.rows], n = [...fresh.rows];
      while (f.length > 0 || n.length > 0) {
        if (f.length > 0) mixed.push(f.shift()!);
        if (n.length > 0) mixed.push(n.shift()!);
      }

      return {
        tracks: mixed,
        breakdown: { favorites: favs.rows.length, new_tracks: fresh.rows.length },
      };
    }

    case 'get_favorites': {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
      const conditions: string[] = [];
      const params: unknown[] = [userId];
      let idx = 2;

      if (args.artist) {
        conditions.push(`t.artist ILIKE $${idx}`);
        params.push(`%${args.artist as string}%`);
        idx++;
      }

      const where = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

      const r = await db().query<{
        id: number; title: string; artist: string; album: string; duration_ms: number; added_at: string;
      }>(
        `SELECT t.id, t.title, t.artist, t.album, t.duration_ms, ft.added_at
         FROM favorite_tracks ft
         JOIN active_tracks t ON t.id = ft.track_id
         WHERE ft.user_id = $1 ${where}
         ORDER BY ft.added_at DESC LIMIT $${idx}`,
        [...params, limit]
      );
      return { tracks: r.rows, total_favorites: r.rows.length };
    }

    case 'toggle_favorite': {
      const ids = (args.track_ids as number[]) || [];
      const action = (args.action as string) || 'add';

      for (const trackId of ids) {
        if (action === 'add') {
          await db().query(
            'INSERT INTO favorite_tracks(user_id, track_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [userId, trackId]
          );
        } else {
          await db().query(
            'DELETE FROM favorite_tracks WHERE user_id = $1 AND track_id = $2',
            [userId, trackId]
          );
        }
      }

      return { action: 'favorite_toggled', favorite_action: action, count: ids.length, track_ids: ids };
    }

    case 'manage_playlist': {
      const plAction = args.action as string;

      if (plAction === 'list') {
        const r = await db().query<{
          id: number; name: string; created_at: string; track_count: string;
        }>(
          `SELECT p.id, p.name, p.created_at,
                  (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id)::text as track_count
           FROM playlists p WHERE p.user_id = $1 ORDER BY p.created_at DESC`,
          [userId]
        );
        return { playlists: r.rows };
      }

      // Resolve playlist ID from name if needed
      let playlistId = Number(args.playlist_id) || 0;
      if (!playlistId && args.playlist_name) {
        const r = await db().query<{ id: number }>(
          'SELECT id FROM playlists WHERE user_id = $1 AND name ILIKE $2 LIMIT 1',
          [userId, `%${args.playlist_name as string}%`]
        );
        playlistId = r.rows[0]?.id || 0;
      }
      if (!playlistId) return { error: 'Playlist not found. Use manage_playlist with action "list" to see available playlists.' };

      const trackIds = (args.track_ids as number[]) || [];

      if (plAction === 'add_tracks') {
        // Get current max position
        const posR = await db().query<{ max_pos: number }>(
          'SELECT COALESCE(MAX(position), -1) as max_pos FROM playlist_items WHERE playlist_id = $1',
          [playlistId]
        );
        let pos = (posR.rows[0]?.max_pos ?? -1) + 1;
        for (const tid of trackIds) {
          await db().query(
            'INSERT INTO playlist_items(playlist_id, track_id, position) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [playlistId, tid, pos++]
          );
        }
        return { action: 'tracks_added', playlist_id: playlistId, added: trackIds.length };
      }

      if (plAction === 'remove_tracks') {
        for (const tid of trackIds) {
          await db().query(
            'DELETE FROM playlist_items WHERE playlist_id = $1 AND track_id = $2',
            [playlistId, tid]
          );
        }
        return { action: 'tracks_removed', playlist_id: playlistId, removed: trackIds.length };
      }

      return { error: `Unknown playlist action: ${plAction}` };
    }

    case 'control_playback': {
      const action = args.action as string;
      return { action: `playback_${action}` };
    }

    case 'get_library_info': {
      const [stats, recent, lastScan] = await Promise.all([
        db().query<{
          tracks: string; artists: string; albums: string; genres: string;
          total_bytes: string;
        }>(
          `SELECT
             COUNT(*)::text as tracks,
             COUNT(DISTINCT artist)::text as artists,
             COUNT(DISTINCT album)::text as albums,
             (SELECT COUNT(DISTINCT genre) FROM track_genres)::text as genres,
             COALESCE(SUM(size_bytes), 0)::text as total_bytes
           FROM active_tracks`
        ),
        db().query<{ id: number; title: string; artist: string; album: string }>(
          `SELECT id, title, artist, album FROM active_tracks ORDER BY id DESC LIMIT 10`
        ),
        db().query<{ scanned_at: string }>(
          `SELECT MAX(scanned_at)::text as scanned_at FROM libraries`
        ),
      ]);

      const s = stats.rows[0]!;
      const bytes = Number(s.total_bytes);
      const sizeStr = bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;

      return {
        library: {
          tracks: s.tracks,
          artists: s.artists,
          albums: s.albums,
          genres: s.genres,
          total_size: sizeStr,
          last_scan: lastScan.rows[0]?.scanned_at || 'never',
        },
        recently_added: recent.rows,
      };
    }

    case 'save_memory': {
      const fact = (args.fact as string || '').trim();
      if (!fact) return { error: 'No fact provided' };

      // Limit to 50 memories per user
      await db().query(
        `DELETE FROM ai_memory WHERE id IN (
           SELECT id FROM ai_memory WHERE user_id = $1 ORDER BY created_at ASC
           LIMIT GREATEST(0, (SELECT COUNT(*) FROM ai_memory WHERE user_id = $1) - 49)
         )`,
        [userId]
      );

      await db().query(
        'INSERT INTO ai_memory(user_id, fact) VALUES ($1, $2)',
        [userId, fact]
      );
      return { saved: true, fact };
    }

    case 'find_similar': {
      const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 50);
      let targetGenres: string[] = [];
      let targetArtist = (args.artist as string) || '';
      let excludeId = 0;

      if (args.track_id) {
        excludeId = Number(args.track_id);
        // Get the target track's genres and artist
        const tgt = await db().query<{ artist: string; genre: string }>(
          `SELECT t.artist, string_agg(DISTINCT tg.genre, ',') as genre
           FROM active_tracks t
           LEFT JOIN track_genres tg ON tg.track_id = t.id
           WHERE t.id = $1
           GROUP BY t.artist`,
          [excludeId]
        );
        if (tgt.rows[0]) {
          targetArtist = targetArtist || tgt.rows[0].artist || '';
          targetGenres = (tgt.rows[0].genre || '').split(',').filter(Boolean);
        }
      }

      if (targetArtist && !args.track_id) {
        // Get genres for the artist
        const ag = await db().query<{ genre: string }>(
          `SELECT DISTINCT tg.genre FROM active_tracks t
           JOIN track_genres tg ON tg.track_id = t.id
           WHERE t.artist ILIKE $1`,
          [`%${targetArtist}%`]
        );
        targetGenres = ag.rows.map(r => r.genre);
      }

      if (targetGenres.length === 0 && !targetArtist) {
        return { tracks: [], message: 'Need a track_id or artist to find similar tracks' };
      }

      // Find tracks with matching genres, excluding the source artist for variety
      const genreCondition = targetGenres.length > 0
        ? `AND EXISTS (SELECT 1 FROM track_genres tg WHERE tg.track_id = t.id AND tg.genre = ANY($2))`
        : '';

      const params: unknown[] = [excludeId];
      if (targetGenres.length > 0) params.push(targetGenres);

      const r = await db().query<{
        id: number; title: string; artist: string; album: string; duration_ms: number; genre: string;
      }>(
        `SELECT t.id, t.title, t.artist, t.album, t.duration_ms, t.genre
         FROM active_tracks t
         WHERE t.id != $1 ${genreCondition}
         ORDER BY
           CASE WHEN t.artist ILIKE '%' || $${params.length + 1} || '%' THEN 1 ELSE 0 END DESC,
           random()
         LIMIT $${params.length + 2}`,
        [...params, targetArtist, limit]
      );

      return { tracks: r.rows, based_on: { artist: targetArtist, genres: targetGenres } };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

function buildSystemPrompt(libraryContext: string, nowPlaying: NowPlaying | null | undefined, memories: string): string {
  const now = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dayStr = now.toLocaleDateString('en-US', { weekday: 'long' });
  const timeContext = `Current time: ${timeStr}, ${dayStr}`;

  const hour = now.getHours();
  let timeHint = '';
  if (hour >= 5 && hour < 9) timeHint = 'Early morning — consider calm, energizing music.';
  else if (hour >= 9 && hour < 12) timeHint = 'Morning — upbeat, productive vibes work well.';
  else if (hour >= 12 && hour < 14) timeHint = 'Lunchtime — relaxed, easy-listening fits.';
  else if (hour >= 14 && hour < 17) timeHint = 'Afternoon — moderate energy, focus music.';
  else if (hour >= 17 && hour < 20) timeHint = 'Evening — wind-down or social music.';
  else if (hour >= 20 && hour < 23) timeHint = 'Night — mellow, atmospheric, or party music depending on context.';
  else timeHint = 'Late night — ambient, chill, or introspective music.';

  const nowPlayingStr = nowPlaying
    ? `\nCURRENTLY PLAYING: "${nowPlaying.title || 'Unknown'}" by ${nowPlaying.artist || 'Unknown'}${nowPlaying.album ? ` (from "${nowPlaying.album}")` : ''} [Track ID: ${nowPlaying.id}]`
    : '\nNOTHING IS CURRENTLY PLAYING.';

  return `You are an AI music assistant for mvbar, a self-hosted music streaming app.
You help users discover, play, and organize their music library through natural conversation.
You have personality — be warm, enthusiastic about music, and conversational.

${timeContext}
${timeHint}
${nowPlayingStr}

${libraryContext}
${memories}

HOW TO HANDLE REQUESTS:
1. The user's library is LOCAL — only the artists listed above are available.
2. When the user requests a mood/vibe/genre (e.g. "romantic music", "chill night drive"):
   - Use YOUR WORLD KNOWLEDGE about each artist's actual discography and musical style.
   - Only select artists whose music GENUINELY fits the request.
   - For example: Eminem is NOT romantic music. Metallica is NOT chill. Be accurate.
   - If no artists in the library truly match the requested mood, be HONEST and say so.
   - Suggest the closest match and explain why.
3. You can also search by song title — some individual songs may fit even if the artist generally doesn't.
4. Make MULTIPLE search_tracks calls for different matching artists to gather enough tracks.
5. After finding tracks, ALWAYS call play_tracks (if user said "play") or queue_tracks (if "queue").
6. If the user asks for a specific number of tracks, try to get at least that many.
7. When creating playlists, search for tracks first, then call create_playlist with the found track IDs.
8. Keep responses concise but friendly. Tell the user what you're playing and why it fits.
9. Be honest when the library doesn't have great matches — don't force bad recommendations.

PLAYBACK AWARENESS:
10. If the user says "what's playing?", "who is this?", "play more like this", or "I love this" — use the CURRENTLY PLAYING info above.
11. For "more like this" or "similar to this", use find_similar with the current track_id.
12. For "I love this" / "like this song", use toggle_favorite with the current track_id.
13. For "skip", "next", "previous", "shuffle", "clear queue" — use control_playback.

DISCOVERY & HISTORY:
14. Use get_unplayed_tracks for "songs I haven't heard", "surprise me", "something new".
15. Use get_listening_stats for "what do I listen to most?", "my top artists", "recently played".
16. Use the period parameter for time-based questions: "what did I listen to this week?", "today's plays".
17. Use smart_mix for "mix favorites with new stuff", "blend old and new", "discovery mix".
18. Use get_favorites for "play my favorites", "liked songs", "my best tracks".

CHARTS & EXTERNAL KNOWLEDGE:
19. For "top 50 in UK", "Polish chart hits", "Billboard" — use world knowledge, then search local library.
20. For country-specific requests — use your knowledge of artists from that country/scene.

PLAYLISTS & ORGANIZATION:
21. Use manage_playlist with action "list" to see existing playlists before adding tracks.
22. Use manage_playlist with action "add_tracks" to add to existing playlists.

LIBRARY INFO:
23. Use get_library_info for "how big is my library?", "any new additions?", "library stats".

MEMORY:
24. Use save_memory when the user shares a lasting preference (e.g. "I like chill music for coding").
25. Check the THINGS YOU REMEMBER section above to personalize recommendations.
26. Use memories to make proactive suggestions — if you remember they like Polish rap, suggest it.

TIME AWARENESS:
27. Consider the time of day when making suggestions. If someone asks "play something nice" at midnight, lean toward chill/ambient. In the morning, lean toward upbeat.
28. You can mention the time context naturally: "It's late — how about some chill tracks?"

ACTIVITY PRESETS:
29. For activity requests like "workout music", "study music", "cooking playlist", "road trip", "party":
    - Use your knowledge of what music fits each activity
    - Match with available artists in the library
    - Consider tempo, energy, and mood appropriateness`;
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

    // Build system prompt with library context, now playing, and memories
    const [libraryContext, memories] = await Promise.all([
      buildLibraryContext(req.user.userId),
      loadUserMemories(req.user.userId),
    ]);
    const systemPrompt = buildSystemPrompt(libraryContext, body.nowPlaying, memories);

    const trimmedMessages = body.messages.slice(-10);

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...trimmedMessages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    try {
      let finalResponse = '';
      const toolResults: unknown[] = [];
      let rounds = 0;
      const MAX_ROUNDS = 4;

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

        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          finalResponse = msg.content || (toolResults.length > 0
            ? 'Here are the results!'
            : 'I couldn\'t generate a response. Please try rephrasing your request.');
          break;
        }

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
