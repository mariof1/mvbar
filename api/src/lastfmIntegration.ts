import crypto from 'crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { allowedLibrariesForUser } from './access.js';
import { artistNamesFromValue } from './artistDisplay.js';
import { audit, db } from './db.js';
import { addFavorites } from './favoritesRepo.js';
import { getAdminLastfmStatus, getLastfmServerConfig } from './lastfm.js';
import logger from './logger.js';
import { invalidateRecommendationCache } from './recommendationCache.js';
import { broadcastToUser } from './websocket.js';

const LASTFM_API_URL = 'https://ws.audioscrobbler.com/2.0/';
const LASTFM_AUTH_URL = 'https://www.last.fm/api/auth/';
const AUTH_REQUEST_LIFETIME_MINUTES = 60;
const LOVED_TRACKS_PAGE_SIZE = 200;
const MAX_LOVED_TRACK_PAGES = 100;
const TRACK_LOVE_COALESCE_MS = 150;
const RECENT_LOCAL_LOVE_OVERRIDE_MINUTES = 5;

interface UserLastfmConfig {
  sessionKey: string;
  username: string;
}

interface LastfmResponse {
  error?: number;
  message?: string;
  session?: {
    name?: string;
    key?: string;
  };
  scrobbles?: {
    '@attr'?: { accepted?: string; ignored?: string };
  };
  lovedtracks?: {
    track?: LastfmLovedTrackResponse[] | LastfmLovedTrackResponse;
    '@attr'?: { page?: string; perPage?: string; totalPages?: string; total?: string };
  };
}

interface LastfmLovedTrackResponse {
  name?: string;
  artist?: { name?: string } | string;
}

interface TrackRow {
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
}

interface LovedTrack {
  title: string;
  artist: string;
}

interface LocalTrackCandidate extends LovedTrack {
  id: number;
  album: string | null;
  creditedArtists: string[];
}

type TrackLoveResult = { submitted: boolean; reason?: string };
type TrackLoveSubmitter = (
  userId: string,
  track: Pick<TrackRow, 'title' | 'artist'>,
  loved: boolean,
) => Promise<TrackLoveResult>;

interface PendingTrackLoveMutation {
  desired: boolean;
  track: Pick<TrackRow, 'title' | 'artist'>;
  submitter: TrackLoveSubmitter;
  promise: Promise<TrackLoveResult>;
}

const pendingTrackLoveMutations = new Map<string, PendingTrackLoveMutation>();

export function lastfmApiSignature(params: Record<string, string>, sharedSecret: string): string {
  const source = Object.entries(params)
    .filter(([name]) => name !== 'format' && name !== 'callback')
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => `${name}${value}`)
    .join('');
  return crypto.createHash('md5').update(`${source}${sharedSecret}`, 'utf8').digest('hex');
}

async function signedLastfmRequest(
  method: string,
  params: Record<string, string>,
  apiKey: string,
  sharedSecret: string,
): Promise<LastfmResponse> {
  const signedParams = { api_key: apiKey, method, ...params };
  const body = new URLSearchParams({
    ...signedParams,
    api_sig: lastfmApiSignature(signedParams, sharedSecret),
    format: 'json',
  });

  const response = await fetch(LASTFM_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'mvbar/1.0',
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  const data = await response.json().catch(() => ({})) as LastfmResponse;
  if (!response.ok || data.error) {
    const error = new Error(data.message || `Last.fm returned HTTP ${response.status}`) as Error & { lastfmCode?: number };
    error.lastfmCode = data.error;
    throw error;
  }
  return data;
}

async function publicLastfmRequest(
  method: string,
  params: Record<string, string>,
  apiKey: string,
): Promise<LastfmResponse> {
  const url = new URL(LASTFM_API_URL);
  for (const [name, value] of Object.entries({ method, ...params, api_key: apiKey, format: 'json' })) {
    url.searchParams.set(name, value);
  }

  const response = await fetch(url, {
    headers: { 'User-Agent': 'mvbar/1.0' },
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json().catch(() => ({})) as LastfmResponse;
  if (!response.ok || data.error) {
    const error = new Error(data.message || `Last.fm returned HTTP ${response.status}`) as Error & { lastfmCode?: number };
    error.lastfmCode = data.error;
    throw error;
  }
  return data;
}

function normalizeLastfmMatchText(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function foldLastfmMatchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[łŁ]/g, 'l')
    .replace(/ß/g, 'ss')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const TRAILING_CREDIT_SUFFIX = /\s*[([{][^\])}]*(?:prod(?:uced)?(?:\s+by)?|cuts?|feat(?:uring)?|ft\.?|with|w\/|\+)[^\])}]*[\])}]\s*$/i;
const BARE_TRAILING_CREDIT_SUFFIX = /\s+(?:feat(?:uring)?\.?|ft\.?|with|w\/)\s+.+$/i;

function lastfmTitleVariants(value: string): string[] {
  const variants = new Set<string>();
  let current = value.trim();
  while (current) {
    const folded = foldLastfmMatchText(current);
    if (folded) variants.add(folded);
    const withoutCredit = current
      .replace(TRAILING_CREDIT_SUFFIX, '')
      .replace(BARE_TRAILING_CREDIT_SUFFIX, '')
      .trim();
    if (!withoutCredit || withoutCredit === current) break;
    current = withoutCredit;
  }
  return [...variants];
}

const LASTFM_ARTIST_SEPARATOR = /\s*(?:;|•|\||,|\s+&\s+|\s+\/\s+|\s+feat(?:uring)?\.?\s+|\s+ft\.?\s+|\s+mit\s+|\s+w\/\s+|\s+and\s+)\s*/i;

function lastfmArtistParts(value: string): string[] {
  const seen = new Set<string>();
  for (const name of value.split(LASTFM_ARTIST_SEPARATOR)) {
    const folded = foldLastfmMatchText(name);
    if (folded) seen.add(folded);
  }
  return [...seen];
}

function candidateArtistNames(candidate: LocalTrackCandidate): Set<string> {
  const names = new Set<string>();
  for (const name of [candidate.artist, ...artistNamesFromValue(candidate.artist), ...candidate.creditedArtists]) {
    const folded = foldLastfmMatchText(name);
    if (folded) names.add(folded);
  }
  return names;
}

function artistMatchRank(
  lovedArtist: string,
  candidate: LocalTrackCandidate,
  allowPartialName: boolean,
): number {
  const localNames = candidateArtistNames(candidate);
  const lovedFull = foldLastfmMatchText(lovedArtist);
  if (localNames.has(lovedFull)) return 2;

  const parts = lastfmArtistParts(lovedArtist);
  if (parts.length === 0) return 0;
  const matched = parts.filter(part => localNames.has(part)).length;
  if (matched > 0) return matched / parts.length;

  // Last.fm sometimes stores a collaboration or a full personal name while
  // the file tag contains one exact component (for example Pezet-Noon vs
  // Pezet, or Sebastian Fabijański vs Fabijański). Restrict this fallback to
  // exact-title matches so a loose artist component cannot select another
  // similarly named song.
  if (allowPartialName) {
    const lovedTokens = lovedFull.split(' ').filter(Boolean);
    for (const localName of localNames) {
      const localTokens = localName.split(' ').filter(Boolean);
      if (localTokens.length === 0 || localTokens.length >= lovedTokens.length) continue;
      const contiguous = lovedTokens.some((_, start) => (
        lovedTokens.slice(start, start + localTokens.length).join(' ') === localName
      ));
      if (contiguous) return 0.25 * (localTokens.length / lovedTokens.length);
    }
  }
  return 0;
}

function lastfmArtistName(track: LastfmLovedTrackResponse): string {
  return typeof track.artist === 'string' ? track.artist : track.artist?.name || '';
}

export function lastfmSubmissionArtist(value: string): string {
  return artistNamesFromValue(value)[0] || value.trim();
}

async function fetchLovedTracks(username: string, apiKey: string): Promise<{ tracks: LovedTrack[]; truncated: boolean }> {
  const tracks: LovedTrack[] = [];
  let truncated = false;

  for (let page = 1; page <= MAX_LOVED_TRACK_PAGES; page += 1) {
    const response = await publicLastfmRequest('user.getLovedTracks', {
      user: username,
      limit: String(LOVED_TRACKS_PAGE_SIZE),
      page: String(page),
    }, apiKey);
    const rawTracks = response.lovedtracks?.track;
    const pageTracks = Array.isArray(rawTracks) ? rawTracks : rawTracks ? [rawTracks] : [];
    for (const track of pageTracks) {
      const title = track.name?.trim() || '';
      const artist = lastfmArtistName(track).trim();
      if (title && artist) tracks.push({ title, artist });
    }

    const advertisedPages = Number(response.lovedtracks?.['@attr']?.totalPages || 0);
    if (pageTracks.length < LOVED_TRACKS_PAGE_SIZE || (advertisedPages > 0 && page >= advertisedPages)) break;
    if (page === MAX_LOVED_TRACK_PAGES) truncated = advertisedPages > page || pageTracks.length === LOVED_TRACKS_PAGE_SIZE;
  }

  const unique = new Map<string, LovedTrack>();
  for (const track of tracks) {
    const key = `${normalizeLastfmMatchText(track.title)}\u0000${normalizeLastfmMatchText(track.artist)}`;
    if (!unique.has(key)) unique.set(key, track);
  }
  return { tracks: [...unique.values()], truncated };
}

export function matchLovedTracks(
  lovedTracks: LovedTrack[],
  candidates: LocalTrackCandidate[],
): { trackIds: number[]; matched: number } {
  const candidatesByTitle = new Map<string, LocalTrackCandidate[]>();
  for (const candidate of candidates) {
    for (const title of lastfmTitleVariants(candidate.title)) {
      const existing = candidatesByTitle.get(title) || [];
      existing.push(candidate);
      candidatesByTitle.set(title, existing);
    }
  }

  const matchedIds = new Set<number>();
  let matched = 0;
  for (const loved of lovedTracks) {
    const fullTitle = foldLastfmMatchText(loved.title);
    const candidatesForTitle = new Map<number, LocalTrackCandidate>();
    for (const title of lastfmTitleVariants(loved.title)) {
      for (const candidate of candidatesByTitle.get(title) || []) candidatesForTitle.set(candidate.id, candidate);
    }
    const matches = [...candidatesForTitle.values()]
      .map(candidate => ({
        candidate,
        titleRank: foldLastfmMatchText(candidate.title) === fullTitle ? 2 : 1,
        artistRank: artistMatchRank(
          loved.artist,
          candidate,
          foldLastfmMatchText(candidate.title) === fullTitle,
        ),
      }))
      .filter(match => match.artistRank > 0)
      .sort((left, right) => {
        if (left.titleRank !== right.titleRank) return right.titleRank - left.titleRank;
        if (left.artistRank !== right.artistRank) return right.artistRank - left.artistRank;
        const leftHasAlbum = Boolean(left.candidate.album?.trim());
        const rightHasAlbum = Boolean(right.candidate.album?.trim());
        if (leftHasAlbum !== rightHasAlbum) return leftHasAlbum ? -1 : 1;
        return left.candidate.id - right.candidate.id;
      });
    if (matches[0]) {
      matched += 1;
      matchedIds.add(matches[0].candidate.id);
    }
  }
  return { trackIds: [...matchedIds], matched };
}

export function selectLovedTrackMatches(lovedTracks: LovedTrack[], candidates: LocalTrackCandidate[]): number[] {
  return matchLovedTracks(lovedTracks, candidates).trackIds;
}

async function localMatchesForLovedTracks(
  lovedTracks: LovedTrack[],
  allowedLibraries: number[] | null,
): Promise<{ trackIds: number[]; matched: number }> {
  if (lovedTracks.length === 0 || allowedLibraries?.length === 0) return { trackIds: [], matched: 0 };
  const libraryClause = allowedLibraries === null ? '' : 'where t.library_id = any($1::bigint[])';
  const result = await db().query<{
    id: string | number;
    title: string;
    artist: string;
    album: string | null;
    credited_artists: string[];
  }>(
    `select t.id, t.title, t.artist, t.album,
            coalesce(
              array_agg(a.name order by ta.position)
                filter (where ta.role = 'artist' and a.name is not null),
              '{}'::text[]
            ) as credited_artists
       from active_tracks t
       left join track_artists ta on ta.track_id = t.id and ta.role = 'artist'
       left join artists a on a.id = ta.artist_id
       ${libraryClause}
      group by t.id, t.title, t.artist, t.album`,
    allowedLibraries === null ? [] : [allowedLibraries],
  );
  const candidates = result.rows.map(row => ({
    id: Number(row.id),
    title: row.title,
    artist: row.artist || '',
    album: row.album,
    creditedArtists: row.credited_artists || [],
  }));

  return matchLovedTracks(lovedTracks, candidates);
}

async function recentlyUnlovedTrackIds(userId: string, trackIds: number[]): Promise<Set<number>> {
  if (trackIds.length === 0) return new Set();
  const result = await db().query<{ track_id: string }>(
    `select latest.track_id
       from (
         select distinct on (meta->>'trackId')
                meta->>'trackId' as track_id,
                event
           from audit_events
          where event in ('favorite_added', 'favorite_removed')
            and meta->>'by' = $1
            and meta->>'trackId' = any($2::text[])
            and ts >= now() - ($3 * interval '1 minute')
          order by meta->>'trackId', ts desc, id desc
       ) latest
      where latest.event = 'favorite_removed'`,
    [userId, trackIds.map(String), RECENT_LOCAL_LOVE_OVERRIDE_MINUTES],
  );
  return new Set(result.rows.map(row => Number(row.track_id)));
}

function configuredPublicOrigin(request: FastifyRequest): string {
  const configured = process.env.APP_DOMAIN?.trim();
  if (configured) {
    try {
      return new URL(configured.includes('://') ? configured : `https://${configured}`).origin;
    } catch {
      // Fall through to the request origin when APP_DOMAIN is malformed.
    }
  }

  const forwardedProtocol = String(request.headers['x-forwarded-proto'] || '').split(',')[0]?.trim();
  const forwardedHost = String(request.headers['x-forwarded-host'] || '').split(',')[0]?.trim();
  const protocol = forwardedProtocol || request.protocol || 'http';
  const host = forwardedHost || request.headers.host || 'localhost';
  return `${protocol}://${host}`;
}

function settingsRedirect(request: FastifyRequest, result: 'connected' | 'error'): string {
  return `${configuredPublicOrigin(request)}/?lastfm=${result}#/settings`;
}

async function userLastfmConfig(userId: string): Promise<UserLastfmConfig | null> {
  const result = await db().query<{ lastfm_session_key: string | null; lastfm_username: string | null }>(
    'select lastfm_session_key, lastfm_username from users where id = $1',
    [userId],
  );
  const sessionKey = result.rows[0]?.lastfm_session_key?.trim();
  if (!sessionKey) return null;
  return {
    sessionKey,
    username: result.rows[0]?.lastfm_username?.trim() || '',
  };
}

async function trackForSubmission(trackId: number): Promise<TrackRow | null> {
  const result = await db().query<TrackRow>(
    'select title, artist, album, duration_ms from active_tracks where id = $1',
    [trackId],
  );
  return result.rows[0] || null;
}

async function clearInvalidSession(userId: string): Promise<void> {
  await db().query(
    'update users set lastfm_session_key = null, lastfm_username = null where id = $1',
    [userId],
  );
}

async function submitUserTrack(
  userId: string,
  method: 'track.updateNowPlaying' | 'track.scrobble',
  track: TrackRow,
  listenedAt?: number,
): Promise<{ submitted: boolean; reason?: string }> {
  const [server, user] = await Promise.all([
    getLastfmServerConfig(),
    userLastfmConfig(userId),
  ]);
  if (!user) return { submitted: false, reason: 'not_connected' };
  if (!server.apiKey || !server.sharedSecret) return { submitted: false, reason: 'server_not_configured' };

  const params: Record<string, string> = {
    artist: track.artist,
    track: track.title,
    sk: user.sessionKey,
  };
  if (track.album) params.album = track.album;
  if (track.duration_ms && track.duration_ms > 0) {
    params.duration = String(Math.max(1, Math.round(track.duration_ms / 1000)));
  }
  if (method === 'track.scrobble') {
    const durationSeconds = Math.max(0, Math.round((track.duration_ms || 0) / 1000));
    params.timestamp = String(
      Number.isFinite(listenedAt) && Number(listenedAt) > 0
        ? Math.floor(Number(listenedAt))
        : Math.floor(Date.now() / 1000) - durationSeconds,
    );
    params.chosenByUser = '1';
  }

  try {
    const response = await signedLastfmRequest(method, params, server.apiKey, server.sharedSecret);
    if (method === 'track.scrobble' && response.scrobbles?.['@attr']?.accepted === '0') {
      return { submitted: false, reason: 'ignored' };
    }
    return { submitted: true };
  } catch (error) {
    if ((error as Error & { lastfmCode?: number }).lastfmCode === 9) {
      await clearInvalidSession(userId);
      return { submitted: false, reason: 'session_expired' };
    }
    logger.error('lastfm', `${method} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return { submitted: false, reason: 'lastfm_error' };
  }
}

export async function setUserTrackLoved(
  userId: string,
  track: Pick<TrackRow, 'title' | 'artist'>,
  loved: boolean,
): Promise<{ submitted: boolean; reason?: string }> {
  if (!track.title?.trim() || !track.artist?.trim()) {
    return { submitted: false, reason: 'missing_metadata' };
  }
  const [server, user] = await Promise.all([
    getLastfmServerConfig(),
    userLastfmConfig(userId),
  ]);
  if (!user) return { submitted: false, reason: 'not_connected' };
  if (!server.apiKey || !server.sharedSecret) return { submitted: false, reason: 'server_not_configured' };

  const method = loved ? 'track.love' : 'track.unlove';
  const primaryArtist = lastfmSubmissionArtist(track.artist);
  try {
    await signedLastfmRequest(method, {
      artist: primaryArtist,
      track: track.title,
      sk: user.sessionKey,
    }, server.apiKey, server.sharedSecret);
    return { submitted: true };
  } catch (error) {
    if ((error as Error & { lastfmCode?: number }).lastfmCode === 9) {
      await clearInvalidSession(userId);
      return { submitted: false, reason: 'session_expired' };
    }
    logger.error('lastfm', `${method} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    return { submitted: false, reason: 'lastfm_error' };
  }
}

export function syncUserTrackLoved(
  userId: string,
  trackId: number,
  track: Pick<TrackRow, 'title' | 'artist'>,
  loved: boolean,
  submitter: TrackLoveSubmitter = setUserTrackLoved,
): Promise<TrackLoveResult> {
  const key = `${userId}:${trackId}`;
  const existing = pendingTrackLoveMutations.get(key);
  if (existing) {
    existing.desired = loved;
    existing.track = track;
    existing.submitter = submitter;
    return existing.promise;
  }

  const pending: PendingTrackLoveMutation = {
    desired: loved,
    track,
    submitter,
    promise: Promise.resolve({ submitted: false }),
  };
  pending.promise = (async () => {
    while (true) {
      await new Promise(resolve => setTimeout(resolve, TRACK_LOVE_COALESCE_MS));
      const desired = pending.desired;
      const currentTrack = pending.track;
      const currentSubmitter = pending.submitter;
      const result = await currentSubmitter(userId, currentTrack, desired);
      if (pending.desired === desired) return result;
    }
  })().finally(() => {
    if (pendingTrackLoveMutations.get(key) === pending) pendingTrackLoveMutations.delete(key);
  });
  pendingTrackLoveMutations.set(key, pending);
  return pending.promise;
}

export const lastfmIntegrationPlugin: FastifyPluginAsync = fp(async (app) => {
  app.get('/api/admin/lastfm/settings', async (request, reply) => {
    if (request.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    return { ok: true, ...(await getAdminLastfmStatus()) };
  });

  app.put('/api/admin/lastfm/settings', async (request, reply) => {
    if (request.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const body = (request.body || {}) as {
      apiKey?: unknown;
      sharedSecret?: unknown;
      clearApiKey?: unknown;
      clearSharedSecret?: unknown;
    };

    if (body.apiKey !== undefined && typeof body.apiKey !== 'string') {
      return reply.code(400).send({ ok: false, error: 'API key must be text.' });
    }
    if (body.sharedSecret !== undefined && typeof body.sharedSecret !== 'string') {
      return reply.code(400).send({ ok: false, error: 'Shared secret must be text.' });
    }

    const suppliedApiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    const suppliedSecret = typeof body.sharedSecret === 'string' ? body.sharedSecret.trim() : '';
    if (suppliedApiKey && !/^[a-f\d]{32}$/i.test(suppliedApiKey)) {
      return reply.code(400).send({ ok: false, error: 'Last.fm API keys must contain 32 hexadecimal characters.' });
    }
    if (suppliedSecret && !/^[a-f\d]{32}$/i.test(suppliedSecret)) {
      return reply.code(400).send({ ok: false, error: 'Last.fm shared secrets must contain 32 hexadecimal characters.' });
    }

    const previous = await db().query<{ api_key: string | null; shared_secret: string | null }>(
      'select api_key, shared_secret from lastfm_settings where id = 1',
    );
    const apiKey = body.clearApiKey === true ? null : suppliedApiKey || previous.rows[0]?.api_key || null;
    const sharedSecret = body.clearSharedSecret === true ? null : suppliedSecret || previous.rows[0]?.shared_secret || null;

    await db().query(
      `insert into lastfm_settings(id, api_key, shared_secret, updated_by, updated_at)
       values (1, $1, $2, $3, now())
       on conflict (id) do update
       set api_key = excluded.api_key,
           shared_secret = excluded.shared_secret,
           updated_by = excluded.updated_by,
           updated_at = now()`,
      [apiKey, sharedSecret, request.user.userId],
    );
    await audit('lastfm_server_settings_updated', {
      by: request.user.userId,
      apiKeyConfigured: Boolean(apiKey),
      sharedSecretConfigured: Boolean(sharedSecret),
    });
    return { ok: true, ...(await getAdminLastfmStatus()) };
  });

  app.get('/api/lastfm/settings', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ ok: false });
    const [server, user] = await Promise.all([
      getLastfmServerConfig(),
      userLastfmConfig(request.user.userId),
    ]);
    return {
      ok: true,
      available: Boolean(server.apiKey && server.sharedSecret),
      connected: Boolean(user),
      username: user?.username || null,
    };
  });

  app.post('/api/lastfm/connect', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ ok: false });
    const server = await getLastfmServerConfig();
    if (!server.apiKey || !server.sharedSecret) {
      return reply.code(409).send({
        ok: false,
        error: 'The server administrator must configure a Last.fm API key and shared secret first.',
      });
    }

    const state = crypto.randomBytes(24).toString('hex');
    await db().query(
      `delete from lastfm_auth_requests
        where created_at < now() - ($1 * interval '1 minute')`,
      [AUTH_REQUEST_LIFETIME_MINUTES],
    );
    await db().query(
      'insert into lastfm_auth_requests(state, user_id) values ($1, $2)',
      [state, request.user.userId],
    );

    const callback = new URL('/api/lastfm/callback', configuredPublicOrigin(request));
    callback.searchParams.set('state', state);
    const authorization = new URL(LASTFM_AUTH_URL);
    authorization.searchParams.set('api_key', server.apiKey);
    authorization.searchParams.set('cb', callback.toString());
    return { ok: true, authorizationUrl: authorization.toString() };
  });

  app.get('/api/lastfm/callback', async (request, reply) => {
    const query = request.query as { token?: string; state?: string };
    const token = query.token?.trim();
    const state = query.state?.trim();
    if (!token || !state) return reply.redirect(settingsRedirect(request, 'error'));

    const authRequest = await db().query<{ user_id: string }>(
      `delete from lastfm_auth_requests
        where state = $1
          and created_at >= now() - ($2 * interval '1 minute')
      returning user_id`,
      [state, AUTH_REQUEST_LIFETIME_MINUTES],
    );
    const userId = authRequest.rows[0]?.user_id;
    if (!userId) return reply.redirect(settingsRedirect(request, 'error'));

    const server = await getLastfmServerConfig();
    if (!server.apiKey || !server.sharedSecret) return reply.redirect(settingsRedirect(request, 'error'));

    try {
      const response = await signedLastfmRequest(
        'auth.getSession',
        { token },
        server.apiKey,
        server.sharedSecret,
      );
      const sessionKey = response.session?.key?.trim();
      const username = response.session?.name?.trim();
      if (!sessionKey || !username) throw new Error('Last.fm did not return a user session.');

      await db().query(
        'update users set lastfm_session_key = $1, lastfm_username = $2 where id = $3',
        [sessionKey, username, userId],
      );
      await audit('lastfm_connected', { by: userId, username });
      return reply.redirect(settingsRedirect(request, 'connected'));
    } catch (error) {
      logger.error('lastfm', `Connection failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return reply.redirect(settingsRedirect(request, 'error'));
    }
  });

  app.post('/api/lastfm/disconnect', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ ok: false });
    await clearInvalidSession(request.user.userId);
    await audit('lastfm_disconnected', { by: request.user.userId });
    return { ok: true };
  });

  app.post('/api/lastfm/loved/sync', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ ok: false });
    const [server, user] = await Promise.all([
      getLastfmServerConfig(),
      userLastfmConfig(request.user.userId),
    ]);
    if (!user) {
      return reply.code(409).send({ ok: false, error: 'Connect your Last.fm account before syncing loved tracks.' });
    }
    if (!server.apiKey) {
      return reply.code(409).send({ ok: false, error: 'The Last.fm server integration is not configured.' });
    }

    try {
      const [{ tracks, truncated }, allowedLibraries] = await Promise.all([
        fetchLovedTracks(user.username, server.apiKey),
        allowedLibrariesForUser(request.user.userId, request.user.role),
      ]);
      const matches = await localMatchesForLovedTracks(tracks, allowedLibraries);
      // Last.fm's loved-track list can lag a successful unlove for several
      // seconds. Preserve the user's latest local action during that window so
      // a manual sync cannot immediately restore the track they just removed.
      const recentUnloved = await recentlyUnlovedTrackIds(request.user.userId, matches.trackIds);
      const importedTrackIds = await addFavorites(
        request.user.userId,
        matches.trackIds.filter(trackId => !recentUnloved.has(trackId)),
      );

      if (importedTrackIds.length > 0) {
        await invalidateRecommendationCache(request.user.userId);
        broadcastToUser(request.user.userId, 'favorite:synced', { trackIds: importedTrackIds });
      }
      await audit('lastfm_loved_tracks_synced', {
        by: request.user.userId,
        username: user.username,
        total: tracks.length,
        matched: matches.matched,
        imported: importedTrackIds.length,
        deferred: recentUnloved.size,
        truncated,
      });
      return {
        ok: true,
        total: tracks.length,
        matched: matches.matched,
        imported: importedTrackIds.length,
        deferred: recentUnloved.size,
        unmatched: Math.max(0, tracks.length - matches.matched),
        truncated,
      };
    } catch (error) {
      const lastfmCode = (error as Error & { lastfmCode?: number }).lastfmCode;
      logger.error('lastfm', `Loved-track sync failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      return reply.code(lastfmCode === 29 ? 429 : 502).send({
        ok: false,
        error: lastfmCode === 29
          ? 'Last.fm is rate limiting requests. Please try the sync again in a few minutes.'
          : 'Could not load loved tracks from Last.fm. Please try again.',
      });
    }
  });

  app.post('/api/lastfm/now-playing', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ ok: false });
    const trackId = Number((request.body as { trackId?: unknown } | undefined)?.trackId);
    if (!Number.isInteger(trackId) || trackId <= 0) return reply.code(400).send({ ok: false });
    const track = await trackForSubmission(trackId);
    if (!track) return reply.code(404).send({ ok: false });
    const result = await submitUserTrack(request.user.userId, 'track.updateNowPlaying', track);
    return { ok: true, ...result };
  });

  app.post('/api/lastfm/scrobble', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ ok: false });
    const body = (request.body || {}) as { trackId?: unknown; listenedAt?: unknown };
    const trackId = Number(body.trackId);
    const listenedAt = body.listenedAt === undefined ? undefined : Number(body.listenedAt);
    if (!Number.isInteger(trackId) || trackId <= 0) return reply.code(400).send({ ok: false });
    if (listenedAt !== undefined && (!Number.isFinite(listenedAt) || listenedAt <= 0)) {
      return reply.code(400).send({ ok: false });
    }
    const track = await trackForSubmission(trackId);
    if (!track) return reply.code(404).send({ ok: false });
    const result = await submitUserTrack(request.user.userId, 'track.scrobble', track, listenedAt);
    return { ok: true, scrobbled: result.submitted, reason: result.reason };
  });
});
