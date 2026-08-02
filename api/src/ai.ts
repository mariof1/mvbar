import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { allowedLibrariesForUser } from './access.js';
import { db } from './db.js';

const DEFAULT_AUDIOMUSE_URL = 'http://127.0.0.1:8000';
const MAX_QUERY_LENGTH = 500;
const MAX_REQUESTS_PER_MINUTE = 10;
const MAX_AUDIOMUSE_RESULTS = 500;

export type MusicIntentAction = 'play' | 'queue' | 'search';

export type AudioMuseCommand = {
  action: MusicIntentAction;
  originalQuery: string;
  searchText: string;
  trackCount: number;
  minDurationMinutes: number | null;
  maxDurationMinutes: number | null;
};

export type AudioMuseSearchResult = {
  item_id: string | number;
  title?: string | null;
  author?: string | null;
  album?: string | null;
  similarity?: number | null;
};

export type AiTrack = {
  id: number;
  title: string | null;
  artist: string | null;
  albumArtist: string | null;
  displayArtist: string | null;
  album: string | null;
  path: string;
  ext: string;
  durationMs: number | null;
};

type RateWindow = { startedAt: number; count: number };
const rateWindows = new Map<string, RateWindow>();

function cleanText(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function durationInMinutes(value: string, unit: string): number {
  const amount = Number(value);
  if (/^h(?:our|ours|r|rs)?$/i.test(unit)) return amount * 60;
  if (/^s(?:ec|ecs|econd|econds)?$/i.test(unit)) return amount / 60;
  return amount;
}

function boundedMinutes(value: number): number {
  return Math.round(Math.max(0.25, Math.min(1_440, value)) * 100) / 100;
}

function parseQuantityAndDuration(query: string): {
  trackCount: number;
  minDurationMinutes: number | null;
  maxDurationMinutes: number | null;
  matchedText: string[];
} {
  const matchedText: string[] = [];
  const exactCountMatch = query.match(/\b(\d{1,3})\s*(?:songs?|tracks?)\b/i);
  const decoratedCountMatch = query.match(/\b(\d{1,3})\s+(?:(?:[a-z][\w-]*)\s+){1,4}(?:songs?|tracks?)\b/i);
  const countMatch = exactCountMatch || decoratedCountMatch;
  const trackCount = countMatch ? Math.max(1, Math.min(100, Number(countMatch[1]))) : 24;
  if (exactCountMatch) matchedText.push(exactCountMatch[0]);
  else if (decoratedCountMatch) matchedText.push(decoratedCountMatch[1]);

  const number = '(\\d+(?:\\.\\d+)?)';
  const unit = '(hours?|hrs?|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)';
  const range = new RegExp(`\\b(?:between\\s+)?${number}\\s*(?:and|to|-)\\s*${number}\\s*${unit}\\b`, 'i');
  const minimumPrefix = new RegExp(`\\b(?:at\\s+least|minimum(?:\\s+of)?|over|more\\s+than|longer\\s+than)\\s+${number}\\s*${unit}\\b`, 'i');
  const minimumSuffix = new RegExp(`\\b${number}\\s*${unit}\\s*(?:or\\s+(?:over|more|longer)|and\\s+(?:over|up)|minimum|\\+)`, 'i');
  const maximumPrefix = new RegExp(`\\b(?:under|less\\s+than|shorter\\s+than|no\\s+more\\s+than|up\\s+to|at\\s+most)\\s+${number}\\s*${unit}\\b`, 'i');
  const maximumSuffix = new RegExp(`\\b${number}\\s*${unit}\\s*(?:or\\s+(?:under|less|shorter)|and\\s+(?:under|down)|maximum)`, 'i');

  let minDurationMinutes: number | null = null;
  let maxDurationMinutes: number | null = null;
  const rangeMatch = query.match(range);
  if (rangeMatch) {
    const first = durationInMinutes(rangeMatch[1], rangeMatch[3]);
    const second = durationInMinutes(rangeMatch[2], rangeMatch[3]);
    minDurationMinutes = boundedMinutes(Math.min(first, second));
    maxDurationMinutes = boundedMinutes(Math.max(first, second));
    matchedText.push(rangeMatch[0]);
  } else {
    const minMatch = query.match(minimumPrefix) || query.match(minimumSuffix);
    const maxMatch = query.match(maximumPrefix) || query.match(maximumSuffix);
    if (minMatch) {
      minDurationMinutes = boundedMinutes(durationInMinutes(minMatch[1], minMatch[2]));
      matchedText.push(minMatch[0]);
    }
    if (maxMatch) {
      maxDurationMinutes = boundedMinutes(durationInMinutes(maxMatch[1], maxMatch[2]));
      matchedText.push(maxMatch[0]);
    }
  }

  return { trackCount, minDurationMinutes, maxDurationMinutes, matchedText };
}

export function parseAudioMuseCommand(rawQuery: string): AudioMuseCommand {
  const originalQuery = cleanText(rawQuery, MAX_QUERY_LENGTH);
  const quantity = parseQuantityAndDuration(originalQuery);
  const action: MusicIntentAction = /\b(?:queue|add)\b/i.test(originalQuery)
    ? 'queue'
    : /\b(?:play|put\s+on|start|give\s+me)\b/i.test(originalQuery)
      ? 'play'
      : 'search';

  let searchText = originalQuery
    .replace(/^\s*(?:please\s+)?(?:play|queue|add|find|search(?:\s+for)?|put\s+on|start|give\s+me)\b\s*/i, '');
  for (const matched of quantity.matchedText) {
    searchText = searchText.replace(new RegExp(matched.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
  }
  searchText = searchText
    .replace(/\b(?:songs?|tracks?|music)\b/gi, ' ')
    .replace(/\b(?:each|per\s+track|per\s+song)\b/gi, ' ')
    .replace(/\b(?:and\s+similar|or\s+similar|and\s+related)\b/gi, ' ');
  searchText = cleanText(searchText.replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, ''), 300);

  return {
    action,
    originalQuery,
    searchText,
    trackCount: quantity.trackCount,
    minDurationMinutes: quantity.minDurationMinutes,
    maxDurationMinutes: quantity.maxDurationMinutes,
  };
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export function normalizeAudioMuseUrl(value: string): string {
  const cleaned = cleanText(value || DEFAULT_AUDIOMUSE_URL, 500);
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch {
    throw new Error('AudioMuse-AI URL must be a valid HTTP address.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('AudioMuse-AI URL must be an HTTP address without embedded credentials.');
  }
  const allowRemote = process.env.AUDIOMUSE_ALLOW_REMOTE?.trim().toLowerCase() === 'true';
  if (!allowRemote && !isLoopbackHost(parsed.hostname)) {
    throw new Error('AudioMuse-AI must use localhost unless AUDIOMUSE_ALLOW_REMOTE=true is set by the server administrator.');
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

function audioMuseEndpoint(baseUrl: string, path: string): string {
  return `${normalizeAudioMuseUrl(baseUrl)}${path}`;
}

function audioMuseHeaders(apiToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
  };
}

function audioMuseError(status: number, payload?: { error?: unknown }): Error & { status: number } {
  let message: string;
  switch (status) {
    case 401:
      message = 'AudioMuse-AI rejected the API token. Update it in Settings → Integrations.';
      break;
    case 503:
      message = 'AudioMuse-AI has not loaded its CLAP index yet. Run song analysis in AudioMuse-AI first.';
      break;
    default:
      message = typeof payload?.error === 'string' && payload.error
        ? `AudioMuse-AI: ${cleanText(payload.error, 300)}`
        : 'AudioMuse-AI could not complete the sonic search.';
  }
  return Object.assign(new Error(message), { status: status >= 500 ? 502 : status });
}

export async function requestAudioMuseSearch(
  baseUrl: string,
  apiToken: string,
  query: string,
  limit: number,
  signal: AbortSignal
): Promise<AudioMuseSearchResult[]> {
  let response: Response;
  try {
    response = await fetch(audioMuseEndpoint(baseUrl, '/api/clap/search'), {
      method: 'POST',
      headers: audioMuseHeaders(apiToken),
      body: JSON.stringify({ query, limit: Math.max(1, Math.min(MAX_AUDIOMUSE_RESULTS, Math.round(limit))) }),
      redirect: 'error',
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw Object.assign(new Error('AudioMuse-AI is not reachable. Start its native app and check the URL in Settings.'), { status: 502 });
  }

  const payload = await response.json().catch(() => ({})) as { results?: unknown; error?: unknown };
  if (!response.ok) throw audioMuseError(response.status, payload);
  if (!Array.isArray(payload.results)) {
    throw Object.assign(new Error('AudioMuse-AI returned an invalid sonic-search response.'), { status: 502 });
  }
  return payload.results.filter((item): item is AudioMuseSearchResult => Boolean(item && typeof item === 'object'));
}

export function selectConfidentAudioMuseIds(results: AudioMuseSearchResult[]): {
  ids: number[];
  confidenceFloor: number | null;
} {
  const ranked = results
    .map((result) => ({
      id: Number(result.item_id),
      similarity: Number(result.similarity),
    }))
    .filter((result) => Number.isSafeInteger(result.id) && result.id > 0 && Number.isFinite(result.similarity))
    .sort((a, b) => b.similarity - a.similarity);
  if (ranked.length === 0) return { ids: [], confidenceFloor: null };

  const top = ranked[0].similarity;
  const confidenceFloor = top - Math.max(0.06, Math.abs(top) * 0.25);
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const result of ranked) {
    if (result.similarity < confidenceFloor || seen.has(result.id)) continue;
    seen.add(result.id);
    ids.push(result.id);
  }
  return { ids, confidenceFloor };
}

export function hasNumericAudioMuseTrackId(results: AudioMuseSearchResult[]): boolean {
  return results.some((result) => {
    const id = Number(result.item_id);
    return Number.isSafeInteger(id) && id > 0;
  });
}

function consumeRateLimit(userId: string): boolean {
  const now = Date.now();
  const window = rateWindows.get(userId);
  if (!window || now - window.startedAt >= 60_000) {
    rateWindows.set(userId, { startedAt: now, count: 1 });
    return true;
  }
  if (window.count >= MAX_REQUESTS_PER_MINUTE) return false;
  window.count += 1;
  return true;
}

async function loadAudioMuseTracks(
  userId: string,
  allowed: number[] | null,
  ids: number[],
  command: AudioMuseCommand
): Promise<AiTrack[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (ids.length > 0) {
    params.push(ids);
    where.push(`t.id = any($${params.length}::bigint[])`);
  }
  if (allowed !== null) {
    params.push(allowed);
    where.push(`t.library_id = any($${params.length}::bigint[])`);
  }
  if (command.minDurationMinutes !== null) {
    params.push(Math.round(command.minDurationMinutes * 60_000));
    where.push(`t.duration_ms >= $${params.length}`);
  }
  if (command.maxDurationMinutes !== null) {
    params.push(Math.round(command.maxDurationMinutes * 60_000));
    where.push(`t.duration_ms <= $${params.length}`);
  }

  let orderBy: string;
  if (ids.length > 0) {
    orderBy = 'array_position($1::bigint[], t.id)';
  } else {
    params.push(`${userId}:${command.originalQuery}`);
    orderBy = `md5(t.id::text || $${params.length})`;
  }

  const result = await db().query<{
    id: number;
    title: string | null;
    artist: string | null;
    album_artist: string | null;
    album: string | null;
    path: string;
    ext: string;
    duration_ms: number | null;
  }>(
    `select t.id::int, t.title, t.artist, t.album_artist, t.album, t.path, t.ext, t.duration_ms
     from active_tracks t
     ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
     order by ${orderBy}
     limit ${Math.max(command.trackCount * 8, command.trackCount)}`,
    params
  );

  const rows = result.rows.map((row) => {
    const albumArtist = row.album_artist?.split(/[;|]/)[0]?.trim() || null;
    const firstArtist = row.artist?.split(/[;|]/)[0]?.trim() || null;
    return {
      id: Number(row.id),
      title: row.title,
      artist: row.artist,
      albumArtist,
      displayArtist: albumArtist || firstArtist || 'Unknown Artist',
      album: row.album,
      path: row.path,
      ext: row.ext,
      durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    } satisfies AiTrack;
  });

  const selected: AiTrack[] = [];
  const overflow: AiTrack[] = [];
  const artistCounts = new Map<string, number>();
  for (const track of rows) {
    const artist = (track.displayArtist || '').toLowerCase();
    if (artist && (artistCounts.get(artist) || 0) >= 3) {
      overflow.push(track);
      continue;
    }
    selected.push(track);
    artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
    if (selected.length >= command.trackCount) break;
  }
  for (const track of overflow) {
    if (selected.length >= command.trackCount) break;
    selected.push(track);
  }
  return selected;
}

async function loadAudioMusePreferences(userId: string): Promise<{ url: string; token: string } | null> {
  const result = await db().query<{ audiomuse_url: string | null; audiomuse_api_token: string | null }>(
    'select audiomuse_url, audiomuse_api_token from user_preferences where user_id = $1',
    [userId]
  );
  const url = result.rows[0]?.audiomuse_url?.trim();
  if (!url) return null;
  return { url: normalizeAudioMuseUrl(url), token: result.rows[0]?.audiomuse_api_token?.trim() || '' };
}

export const aiPlugin: FastifyPluginAsync = fp(async (app) => {
  app.get('/api/ai/status', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const prefs = await loadAudioMusePreferences(req.user.userId);
    if (!prefs) return { ok: true, configured: false, reachable: false, ready: false, analyzedTracks: 0 };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(audioMuseEndpoint(prefs.url, '/api/clap/stats'), {
        headers: audioMuseHeaders(prefs.token),
        redirect: 'error',
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({})) as {
        loaded?: unknown;
        clap_enabled?: unknown;
        song_count?: unknown;
        num_embeddings?: unknown;
        error?: unknown;
      };
      if (!response.ok) throw audioMuseError(response.status, payload);
      const analyzedTracks = Number(payload.song_count ?? payload.num_embeddings ?? 0);
      return {
        ok: true,
        configured: true,
        reachable: true,
        ready: payload.clap_enabled !== false && (payload.loaded === true || analyzedTracks > 0),
        analyzedTracks: Number.isFinite(analyzedTracks) ? analyzedTracks : 0,
      };
    } catch (error) {
      return {
        ok: true,
        configured: true,
        reachable: false,
        ready: false,
        analyzedTracks: 0,
        error: error instanceof Error ? error.message : 'AudioMuse-AI is not reachable.',
      };
    } finally {
      clearTimeout(timeout);
    }
  });

  app.post('/api/ai/intent', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const rawQuery = (req.body as { query?: unknown } | null)?.query;
    if (typeof rawQuery !== 'string' || !rawQuery.trim()) {
      return reply.code(400).send({ ok: false, error: 'A music request is required.' });
    }
    if (rawQuery.trim().length > MAX_QUERY_LENGTH) {
      return reply.code(400).send({ ok: false, error: `Music requests are limited to ${MAX_QUERY_LENGTH} characters.` });
    }
    const prefs = await loadAudioMusePreferences(req.user.userId);
    if (!prefs) {
      return reply.code(400).send({
        ok: false,
        error: 'AudioMuse-AI is not configured. Connect its native app in Settings → Integrations.',
      });
    }
    if (!consumeRateLimit(req.user.userId)) {
      reply.header('Retry-After', '60');
      return reply.code(429).send({ ok: false, error: 'Too many sonic searches. Please wait a minute and try again.' });
    }

    const command = parseAudioMuseCommand(rawQuery);
    const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);

    try {
      let candidateIds: number[] = [];
      let confidenceFloor: number | null = null;
      let analyzedCandidateCount = 0;
      if (command.searchText) {
        const requestedLimit = Math.min(
          MAX_AUDIOMUSE_RESULTS,
          Math.max(command.trackCount * 10, 100)
        );
        const sonicResults = await requestAudioMuseSearch(
          prefs.url,
          prefs.token,
          command.searchText,
          requestedLimit,
          controller.signal
        );
        analyzedCandidateCount = sonicResults.length;
        if (sonicResults.length > 0 && !hasNumericAudioMuseTrackId(sonicResults)) {
          throw Object.assign(new Error(
            'AudioMuse-AI returned tracks from a different music server. Make MVBar its selected/default Navidrome/OpenSubsonic server, then analyze the library again.'
          ), { status: 400 });
        }
        const selected = selectConfidentAudioMuseIds(sonicResults);
        candidateIds = selected.ids;
        confidenceFloor = selected.confidenceFloor;
      }

      const tracks = command.searchText && candidateIds.length === 0
        ? []
        : await loadAudioMuseTracks(req.user.userId, allowed, candidateIds, command);
      const explanation = command.searchText
        ? `AudioMuse-AI matched the actual sound of your tracks to “${command.searchText}” using local CLAP embeddings.`
        : 'MVBar applied the requested quantity and per-track duration directly; no sonic interpretation was needed.';
      return {
        ok: true,
        provider: 'audiomuse',
        model: 'AudioMuse-AI DCLAP',
        originalQuery: command.originalQuery,
        action: command.action,
        requestedTrackCount: command.trackCount,
        searchQuery: command.searchText,
        explanation,
        sonicAnalysis: {
          query: command.searchText,
          candidateCount: analyzedCandidateCount,
          confidenceFloor,
          minDurationMinutes: command.minDurationMinutes,
          maxDurationMinutes: command.maxDurationMinutes,
        },
        tracks,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return reply.code(504).send({ ok: false, error: 'AudioMuse-AI sonic search timed out.' });
      }
      const status = error instanceof Error && 'status' in error
        ? Number((error as Error & { status: number }).status)
        : 502;
      if (status >= 500) app.log.error({ err: error }, 'AudioMuse-AI search failed');
      return reply.code(status).send({
        ok: false,
        error: error instanceof Error ? error.message : 'AudioMuse-AI could not be reached.',
      });
    } finally {
      clearTimeout(timeout);
    }
  });
});
