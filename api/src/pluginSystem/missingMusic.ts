import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { allowedLibrariesForUser } from '../access.js';
import { audit, db } from '../db.js';
import logger from '../logger.js';
import { broadcastToAdmins, broadcastToUser } from '../websocket.js';
import { pluginsEnabledGlobally } from './registry.js';
import type { NdpManifest, PluginDbRow } from './types.js';

export const MISSING_MUSIC_PLUGIN_ID = 'mvbar.missing-music';
const EXTENSION_TYPE = 'missing-music';
const MUSICBRAINZ_ORIGIN = 'https://musicbrainz.org';
const MUSICBRAINZ_CACHE_TTL_MS = 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

type MissingMusicConfig = {
  providerBaseUrl?: string;
  providerApiToken?: string;
  allowPrivateProvider?: boolean;
  requireAdminApproval?: boolean;
  musicBrainzContact?: string;
  releaseGroupTypes?: string;
};

type MissingMusicPluginRow = PluginDbRow & { config: MissingMusicConfig };

type ProviderResult = {
  providerRequestId?: unknown;
  status?: unknown;
  error?: unknown;
};

type MediaRequestRow = {
  id: string;
  plugin_id: string;
  user_id: string;
  user_email?: string;
  item_type: 'album' | 'track';
  artist: string;
  title: string;
  album: string | null;
  musicbrainz_artist_id: string | null;
  musicbrainz_release_group_id: string | null;
  musicbrainz_release_id: string | null;
  musicbrainz_recording_id: string | null;
  status: 'requested' | 'approved' | 'submitted' | 'completed' | 'failed' | 'rejected' | 'cancelled';
  provider_request_id: string | null;
  provider_error: string | null;
  metadata: Record<string, unknown>;
  approved_by: string | null;
  approved_at: string | Date | null;
  submitted_at: string | Date | null;
  completed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type MbReleaseGroup = {
  id?: string;
  title?: string;
  'primary-type'?: string | null;
  'secondary-types'?: string[];
  'first-release-date'?: string;
  releases?: Array<{ id?: string }>;
};

type MbRelease = {
  id?: string;
  status?: string;
  date?: string;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function normalizeCatalogText(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function validMbid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeText(value: unknown, label: string, max = 500) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  if (value.length > max) throw new Error(`${label} is too long`);
  return value.trim();
}

function optionalText(value: unknown, max = 500) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid text value');
  return value.trim() || null;
}

function isPrivateIpv4(address: string) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0;
}

export function isPrivateNetworkAddress(address: string) {
  const normalized = address.toLowerCase().split('%')[0];
  if (net.isIPv4(normalized)) return isPrivateIpv4(normalized);
  if (!net.isIPv6(normalized)) return false;
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  return mapped ? isPrivateIpv4(mapped) : false;
}

async function validateProviderBaseUrl(raw: unknown, allowPrivate: boolean) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Configure the request provider URL first');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('Request provider URL must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Request provider URL must use HTTP(S)');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Request provider URL cannot contain credentials, a query, or a fragment');
  }
  if (!allowPrivate) {
    if (url.hostname.toLowerCase() === 'localhost' || isPrivateNetworkAddress(url.hostname)) {
      throw new Error('Private request providers require the explicit private-network option');
    }
    if (url.protocol !== 'https:') throw new Error('Public request providers must use HTTPS');
    const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateNetworkAddress(address))) {
      throw new Error('Request provider hostname resolves to a private or unavailable address');
    }
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  return url;
}

export async function validateMissingMusicConfig(config: Record<string, unknown>) {
  if (config.providerBaseUrl) {
    await validateProviderBaseUrl(config.providerBaseUrl, config.allowPrivateProvider === true);
  }
}

export function sameProviderOrigin(base: URL, candidate: URL) {
  return base.origin === candidate.origin;
}

function extensionUrl(base: URL, relative: string) {
  return new URL(relative.replace(/^\/+/, ''), base);
}

function providerHeaders(config: MissingMusicConfig, json = false) {
  const headers = new Headers({ Accept: 'application/json', 'User-Agent': 'MVBar-MissingMusic/1.0' });
  if (json) headers.set('Content-Type', 'application/json');
  if (config.providerApiToken) headers.set('Authorization', `Bearer ${config.providerApiToken}`);
  return headers;
}

async function fetchProviderJson(url: URL, config: MissingMusicConfig, init: RequestInit) {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (response.status >= 300 && response.status < 400) throw new Error('Request-provider redirects are not allowed');
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) throw new Error('Request-provider response is too large');
  let body: ProviderResult;
  try {
    body = text ? JSON.parse(text) as ProviderResult : {};
  } catch {
    throw new Error('Request provider returned invalid JSON');
  }
  if (!response.ok) throw new Error(optionalText(body.error, 2000) ?? `Request provider failed (${response.status})`);
  return body;
}

function isMissingMusicManifest(manifest: NdpManifest) {
  return manifest.mvbar?.extension?.type === EXTENSION_TYPE;
}

async function getMissingMusicPlugin(requireEnabled = true): Promise<MissingMusicPluginRow | null> {
  const result = await db().query<MissingMusicPluginRow>('select * from plugins where id=$1', [MISSING_MUSIC_PLUGIN_ID]);
  const row = result.rows[0] ?? null;
  if (!row || !isMissingMusicManifest(row.manifest)) return null;
  if (requireEnabled && (!row.enabled || !pluginsEnabledGlobally())) return null;
  return row;
}

async function requireExtension(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) {
    reply.code(401).send({ ok: false, error: 'Authentication required' });
    return null;
  }
  const plugin = await getMissingMusicPlugin(true);
  if (!plugin) {
    reply.code(404).send({ ok: false, error: 'Missing Music is not installed and enabled' });
    return null;
  }
  return plugin;
}

function libraryFilter(allowed: number[] | null, startParameter: number) {
  return allowed === null
    ? { sql: '', params: [] as unknown[] }
    : { sql: ` and track.library_id = any($${startParameter}::bigint[])`, params: [allowed] as unknown[] };
}

let musicBrainzQueue = Promise.resolve();
let lastMusicBrainzRequestAt = 0;

async function musicBrainzFetch<T>(plugin: MissingMusicPluginRow, cacheKey: string, pathname: string, parameters: Record<string, string>) {
  const cached = await db().query<{ value: Buffer }>(
    `select value from plugin_kv
      where plugin_id=$1 and key=$2 and (expires_at is null or expires_at > now())`,
    [plugin.id, `musicbrainz:${cacheKey}`]
  );
  if (cached.rows[0]) return JSON.parse(cached.rows[0].value.toString('utf8')) as T;

  const run = musicBrainzQueue.then(async () => {
    const waitMs = Math.max(0, 1100 - (Date.now() - lastMusicBrainzRequestAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    const url = new URL(`/ws/2/${pathname.replace(/^\/+/, '')}`, MUSICBRAINZ_ORIGIN);
    for (const [key, value] of Object.entries({ ...parameters, fmt: 'json' })) url.searchParams.set(key, value);
    const contact = (plugin.config.musicBrainzContact ?? 'https://github.com/mariof1/mvbar').replace(/[\r\n()]/g, '').slice(0, 300);
    lastMusicBrainzRequestAt = Date.now();
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': `MVBar/1.0 (${contact})` },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (text.length > 8 * 1024 * 1024) throw new Error('MusicBrainz response is too large');
    if (!response.ok) throw new Error(`MusicBrainz request failed (${response.status})`);
    const parsed = JSON.parse(text) as T;
    await db().query(
      `insert into plugin_kv(plugin_id,key,value,expires_at,updated_at)
       values($1,$2,$3,$4,now())
       on conflict(plugin_id,key) do update set value=excluded.value,expires_at=excluded.expires_at,updated_at=now()`,
      [plugin.id, `musicbrainz:${cacheKey}`, Buffer.from(JSON.stringify(parsed)), new Date(Date.now() + MUSICBRAINZ_CACHE_TTL_MS)]
    );
    await db().query(
      `with ranked as (
         select key,
                sum(octet_length(value)) over (order by updated_at desc,key) running_bytes
           from plugin_kv
          where plugin_id=$1 and key like 'musicbrainz:%'
       )
       delete from plugin_kv cache
        using ranked
        where cache.plugin_id=$1 and cache.key=ranked.key and ranked.running_bytes > $2`,
      [plugin.id, 32 * 1024 * 1024]
    );
    return parsed;
  });
  musicBrainzQueue = run.then(() => undefined, () => undefined);
  return run;
}

function configuredReleaseTypes(plugin: MissingMusicPluginRow) {
  const raw = plugin.config.releaseGroupTypes ?? 'Album,EP';
  const values = raw.split(',').map((value) => value.trim().toLocaleLowerCase('en')).filter(Boolean);
  return new Set(values.length ? values : ['album', 'ep']);
}

async function releaseGroupsForArtist(plugin: MissingMusicPluginRow, artistMbid: string) {
  const output: MbReleaseGroup[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await musicBrainzFetch<{ 'release-group-count'?: number; 'release-groups'?: MbReleaseGroup[] }>(
      plugin,
      `artist:${artistMbid}:release-groups:${offset}`,
      'release-group',
      { artist: artistMbid, inc: 'releases', limit: '100', offset: String(offset) }
    );
    const groups = Array.isArray(page['release-groups']) ? page['release-groups'] : [];
    output.push(...groups);
    if (groups.length < 100 || output.length >= Number(page['release-group-count'] ?? 0)) break;
  }
  const types = configuredReleaseTypes(plugin);
  return output.filter((group) => types.has(String(group['primary-type'] ?? '').toLocaleLowerCase('en')));
}

async function localCatalog(req: FastifyRequest, artistMbid: string) {
  const allowed = await allowedLibrariesForUser(req.user!.userId, req.user!.role);
  const filter = libraryFilter(allowed, 2);
  const result = await db().query<{
    album: string | null;
    release_ids: string[] | null;
    recording_ids: string[] | null;
    track_titles: string[] | null;
  }>(
    `select track.album,
            array_remove(array_agg(distinct track.musicbrainz_release_id), null) release_ids,
            array_remove(array_agg(distinct track.musicbrainz_track_id), null) recording_ids,
            array_remove(array_agg(distinct track.title), null) track_titles
       from active_tracks track
      where ($1 = track.musicbrainz_album_artist_id or $1 = track.musicbrainz_artist_id)
        ${filter.sql}
      group by track.album`,
    [artistMbid, ...filter.params]
  );
  return result.rows;
}

function serializeRequest(row: MediaRequestRow) {
  return {
    id: row.id,
    userId: row.user_id,
    userEmail: row.user_email ?? null,
    itemType: row.item_type,
    artist: row.artist,
    title: row.title,
    album: row.album,
    musicBrainzArtistId: row.musicbrainz_artist_id,
    musicBrainzReleaseGroupId: row.musicbrainz_release_group_id,
    musicBrainzReleaseId: row.musicbrainz_release_id,
    musicBrainzRecordingId: row.musicbrainz_recording_id,
    status: row.status,
    providerRequestId: row.provider_request_id,
    error: row.provider_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

async function notifyRequest(row: MediaRequestRow, event: string, message?: string) {
  const data = {
    event,
    requestId: row.id,
    userId: row.user_id,
    status: row.status,
    artist: row.artist,
    title: row.title,
    message,
    at: new Date().toISOString(),
  };
  broadcastToUser(row.user_id, 'missing-music:update', data);
  broadcastToAdmins('missing-music:update', data, row.user_id);
}

async function updateRequest(id: string, values: Record<string, unknown>) {
  const allowed = new Set([
    'status', 'provider_request_id', 'provider_error', 'approved_by', 'approved_at',
    'submitted_at', 'completed_at', 'metadata',
  ]);
  const entries = Object.entries(values).filter(([key]) => allowed.has(key));
  if (!entries.length) throw new Error('No request values to update');
  const assignments = entries.map(([key], index) => `${key}=$${index + 2}`);
  const result = await db().query<MediaRequestRow>(
    `update plugin_media_requests set ${assignments.join(',')},updated_at=now() where id=$1 returning *`,
    [id, ...entries.map(([, value]) => value)]
  );
  return result.rows[0];
}

function providerStatus(value: unknown): 'queued' | 'completed' | 'failed' {
  if (value === 'queued' || value === 'processing' || value === 'submitted') return 'queued';
  if (value === 'ready' || value === 'complete' || value === 'completed' || value === 'fulfilled') return 'completed';
  if (value === 'failed' || value === 'error' || value === 'rejected') return 'failed';
  throw new Error('Request provider returned an unknown status');
}

async function failRequest(request: MediaRequestRow, error: unknown) {
  const message = errorMessage(error).slice(0, 2000);
  const failed = await updateRequest(request.id, { status: 'failed', provider_error: message });
  await notifyRequest(failed, 'failed', message);
  logger.warn('missing-music', `Request ${request.id} failed: ${message}`);
}

async function processRequest(plugin: MissingMusicPluginRow, request: MediaRequestRow) {
  const baseUrl = await validateProviderBaseUrl(plugin.config.providerBaseUrl, Boolean(plugin.config.allowPrivateProvider));
  if (request.status === 'approved') {
    const result = await fetchProviderJson(extensionUrl(baseUrl, 'v1/requests'), plugin.config, {
      method: 'POST',
      headers: providerHeaders(plugin.config, true),
      body: JSON.stringify({
        requestId: request.id,
        itemType: request.item_type,
        artist: request.artist,
        title: request.title,
        album: request.album,
        musicBrainz: {
          artistId: request.musicbrainz_artist_id,
          releaseGroupId: request.musicbrainz_release_group_id,
          releaseId: request.musicbrainz_release_id,
          recordingId: request.musicbrainz_recording_id,
        },
      }),
    });
    const status = providerStatus(result.status);
    if (status === 'failed') throw new Error(optionalText(result.error, 2000) ?? 'Request provider rejected the request');
    const providerRequestId = safeText(result.providerRequestId, 'providerRequestId', 500);
    request = await updateRequest(request.id, {
      status: status === 'completed' ? 'completed' : 'submitted',
      provider_request_id: providerRequestId,
      provider_error: null,
      submitted_at: new Date(),
      completed_at: status === 'completed' ? new Date() : null,
    });
    await audit('plugin_request_handed_off', {
      pluginId: plugin.id,
      requestId: request.id,
      providerRequestId,
      status: request.status,
    });
    await notifyRequest(
      request,
      request.status,
      request.status === 'completed' ? 'The external request provider marked this request complete' : 'Request handed to the external provider'
    );
    return;
  }

  if (request.status === 'submitted') {
    if (!request.provider_request_id) throw new Error('Submitted request has no provider request id');
    const result = await fetchProviderJson(
      extensionUrl(baseUrl, `v1/requests/${encodeURIComponent(request.provider_request_id)}`),
      plugin.config,
      { method: 'GET', headers: providerHeaders(plugin.config) }
    );
    const status = providerStatus(result.status);
    if (status === 'failed') throw new Error(optionalText(result.error, 2000) ?? 'External request failed');
    if (status === 'completed') {
      request = await updateRequest(request.id, { status: 'completed', completed_at: new Date(), provider_error: null });
      await audit('plugin_request_completed', { pluginId: plugin.id, requestId: request.id, providerRequestId: request.provider_request_id });
      await notifyRequest(request, 'completed', 'The external request provider marked this request complete');
    }
  }
}

let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerBusy = false;

export async function runMissingMusicJobs() {
  if (schedulerBusy) return;
  schedulerBusy = true;
  try {
    const plugin = await getMissingMusicPlugin(true);
    if (!plugin || !plugin.config.providerBaseUrl) return;
    const jobs = await db().query<MediaRequestRow>(
      `select * from plugin_media_requests
        where plugin_id=$1 and status in ('approved','submitted')
        order by updated_at,id limit 3`,
      [plugin.id]
    );
    for (const request of jobs.rows) {
      try {
        await processRequest(plugin, request);
      } catch (error) {
        await failRequest(request, error);
      }
    }
  } finally {
    schedulerBusy = false;
  }
}

export function startMissingMusicScheduler() {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => void runMissingMusicJobs().catch((error) => {
    logger.error('missing-music', `Scheduler failed: ${errorMessage(error)}`);
  }), 30_000);
  schedulerTimer.unref();
  void runMissingMusicJobs().catch(() => undefined);
}

export const missingMusicPlugin: FastifyPluginAsync = fp(async (app) => {
  app.get('/api/plugins/missing-music/status', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false, error: 'Authentication required' });
    const installed = await getMissingMusicPlugin(false);
    return {
      ok: true,
      installed: Boolean(installed),
      enabled: Boolean(installed?.enabled && pluginsEnabledGlobally()),
      configured: Boolean(installed?.config.providerBaseUrl),
      requireAdminApproval: installed?.config.requireAdminApproval !== false,
    };
  });

  app.get('/api/plugins/missing-music/artists', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    const query = optionalText((req.query as { q?: string }).q, 200)?.toLocaleLowerCase('en') ?? '';
    const allowed = await allowedLibrariesForUser(req.user!.userId, req.user!.role);
    const filter = libraryFilter(allowed, 2);
    const result = await db().query<{
      name: string;
      musicbrainz_id: string;
      album_count: string | number;
      track_count: string | number;
    }>(
      `select coalesce(nullif(track.album_artist,''),track.artist) name,
              coalesce(track.musicbrainz_album_artist_id,track.musicbrainz_artist_id) musicbrainz_id,
              count(distinct nullif(track.album,'')) album_count,
              count(*) track_count
         from active_tracks track
        where coalesce(track.musicbrainz_album_artist_id,track.musicbrainz_artist_id) is not null
          and ($1='' or lower(coalesce(nullif(track.album_artist,''),track.artist,'')) like '%' || $1 || '%')
          ${filter.sql}
        group by 1,2 order by lower(coalesce(nullif(track.album_artist,''),track.artist)) limit 200`,
      [query, ...filter.params]
    );
    return {
      ok: true,
      artists: result.rows.map((row) => ({
        name: row.name,
        musicBrainzId: row.musicbrainz_id,
        albumCount: Number(row.album_count),
        trackCount: Number(row.track_count),
      })),
    };
  });

  app.get('/api/plugins/missing-music/artists/:artistMbid/catalog', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    const { artistMbid } = req.params as { artistMbid: string };
    if (!validMbid(artistMbid)) return reply.code(400).send({ ok: false, error: 'Invalid MusicBrainz artist id' });
    try {
      const [groups, local] = await Promise.all([releaseGroupsForArtist(plugin, artistMbid), localCatalog(req, artistMbid)]);
      const localTitles = new Set(local.map((item) => normalizeCatalogText(item.album ?? '')).filter(Boolean));
      const localReleaseIds = new Set(local.flatMap((item) => item.release_ids ?? []));
      return {
        ok: true,
        releaseGroups: groups.map((group) => ({
          id: group.id,
          title: group.title,
          primaryType: group['primary-type'] ?? null,
          secondaryTypes: group['secondary-types'] ?? [],
          firstReleaseDate: group['first-release-date'] ?? null,
          present: (group.releases ?? []).some((release) => release.id && localReleaseIds.has(release.id))
            || localTitles.has(normalizeCatalogText(group.title ?? '')),
        })),
      };
    } catch (error) {
      return reply.code(502).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.get('/api/plugins/missing-music/release-groups/:releaseGroupMbid/tracks', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    const { releaseGroupMbid } = req.params as { releaseGroupMbid: string };
    const { artistMbid, album } = req.query as { artistMbid?: string; album?: string };
    if (!validMbid(releaseGroupMbid) || !validMbid(artistMbid)) {
      return reply.code(400).send({ ok: false, error: 'Invalid MusicBrainz id' });
    }
    try {
      const group = await musicBrainzFetch<{ title?: string; releases?: MbRelease[] }>(
        plugin,
        `release-group:${releaseGroupMbid}:releases`,
        `release-group/${releaseGroupMbid}`,
        { inc: 'releases' }
      );
      const releases = Array.isArray(group.releases) ? group.releases : [];
      const local = await localCatalog(req, artistMbid);
      const wantedAlbum = normalizeCatalogText(album ?? group.title ?? '');
      const matching = local.filter((row) => normalizeCatalogText(row.album ?? '') === wantedAlbum);
      const localReleaseIds = new Set(matching.flatMap((row) => row.release_ids ?? []));
      const release = [...releases].sort((left, right) => {
        const localMatch = Number(Boolean(right.id && localReleaseIds.has(right.id)))
          - Number(Boolean(left.id && localReleaseIds.has(left.id)));
        const official = Number(right.status === 'Official') - Number(left.status === 'Official');
        return localMatch || official || String(left.date ?? '9999').localeCompare(String(right.date ?? '9999'));
      })[0];
      if (!release?.id || !validMbid(release.id)) throw new Error('MusicBrainz has no usable release for this release group');
      const detail = await musicBrainzFetch<{
        title?: string;
        media?: Array<{
          position?: number;
          tracks?: Array<{
            number?: string;
            position?: number;
            title?: string;
            length?: number;
            recording?: { id?: string; title?: string };
          }>;
        }>;
      }>(plugin, `release:${release.id}:recordings`, `release/${release.id}`, { inc: 'recordings+media+artist-credits' });
      const recordingIds = new Set(matching.flatMap((row) => row.recording_ids ?? []));
      const titles = new Set(matching.flatMap((row) => row.track_titles ?? []).map(normalizeCatalogText));
      const tracks = (detail.media ?? []).flatMap((medium) => (medium.tracks ?? []).map((track) => {
        const recordingId = track.recording?.id ?? null;
        const title = track.title ?? track.recording?.title ?? 'Unknown track';
        return {
          recordingId,
          title,
          discNumber: medium.position ?? 1,
          trackNumber: track.position ?? null,
          number: track.number ?? null,
          durationMs: track.length ?? null,
          missing: recordingId ? !recordingIds.has(recordingId) : !titles.has(normalizeCatalogText(title)),
        };
      }));
      return { ok: true, releaseId: release.id, releaseTitle: detail.title ?? group.title ?? null, tracks };
    } catch (error) {
      return reply.code(502).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.get('/api/plugins/missing-music/requests', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    const scope = (req.query as { scope?: string }).scope;
    const all = req.user!.role === 'admin' && scope !== 'mine';
    const result = await db().query<MediaRequestRow>(
      `select request.*, app_user.email user_email
         from plugin_media_requests request join users app_user on app_user.id=request.user_id
        where request.plugin_id=$1 ${all ? '' : 'and request.user_id=$2'}
        order by request.created_at desc limit 500`,
      all ? [plugin.id] : [plugin.id, req.user!.userId]
    );
    return { ok: true, requests: result.rows.map(serializeRequest) };
  });

  app.post('/api/plugins/missing-music/requests', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    try {
      const body = req.body as Record<string, unknown>;
      const itemType = body.itemType === 'album' || body.itemType === 'track' ? body.itemType : null;
      if (!itemType) throw new Error('itemType must be album or track');
      const artist = safeText(body.artist, 'artist');
      const title = safeText(body.title, 'title');
      const album = optionalText(body.album);
      const artistMbid = validMbid(body.musicBrainzArtistId) ? body.musicBrainzArtistId : null;
      const releaseGroupMbid = validMbid(body.musicBrainzReleaseGroupId) ? body.musicBrainzReleaseGroupId : null;
      const releaseMbid = validMbid(body.musicBrainzReleaseId) ? body.musicBrainzReleaseId : null;
      const recordingMbid = validMbid(body.musicBrainzRecordingId) ? body.musicBrainzRecordingId : null;
      if (!artistMbid) throw new Error('A MusicBrainz artist id is required');
      if (itemType === 'album' && !releaseGroupMbid) throw new Error('A MusicBrainz release-group id is required');
      if (itemType === 'track' && (!recordingMbid || !releaseGroupMbid)) {
        throw new Error('MusicBrainz recording and release-group ids are required');
      }
      const keyColumn = itemType === 'album' ? 'musicbrainz_release_group_id' : 'musicbrainz_recording_id';
      const keyValue = itemType === 'album' ? releaseGroupMbid : recordingMbid;
      const duplicate = await db().query<{ id: string }>(
        `select id from plugin_media_requests
          where plugin_id=$1 and user_id=$2 and item_type=$3 and ${keyColumn}=$4
            and status not in ('failed','rejected','cancelled') limit 1`,
        [plugin.id, req.user!.userId, itemType, keyValue]
      );
      if (duplicate.rows[0]) return reply.code(409).send({ ok: false, error: 'This item is already requested' });
      const status = plugin.config.requireAdminApproval === false ? 'approved' : 'requested';
      const id = crypto.randomUUID();
      const result = await db().query<MediaRequestRow>(
        `insert into plugin_media_requests(
           id,plugin_id,user_id,item_type,artist,title,album,musicbrainz_artist_id,
           musicbrainz_release_group_id,musicbrainz_release_id,musicbrainz_recording_id,status,
           approved_by,approved_at,metadata
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
        [
          id, plugin.id, req.user!.userId, itemType, artist, title, album, artistMbid,
          releaseGroupMbid, releaseMbid, recordingMbid, status,
          status === 'approved' ? req.user!.userId : null, status === 'approved' ? new Date() : null,
          { source: 'musicbrainz' },
        ]
      );
      const row = result.rows[0];
      await audit('plugin_media_requested', { pluginId: plugin.id, requestId: id, userId: req.user!.userId, itemType, keyValue });
      await notifyRequest(row, status, status === 'requested' ? 'Request is waiting for administrator approval' : 'Request approved automatically');
      if (status === 'approved') void runMissingMusicJobs().catch(() => undefined);
      return reply.code(201).send({ ok: true, request: serializeRequest(row) });
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.put('/api/plugins/missing-music/requests/:id', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    if (req.user!.role !== 'admin') return reply.code(403).send({ ok: false, error: 'Administrator access required' });
    const { id } = req.params as { id: string };
    const action = (req.body as { action?: unknown }).action;
    const current = (await db().query<MediaRequestRow>('select * from plugin_media_requests where id=$1 and plugin_id=$2', [id, plugin.id])).rows[0];
    if (!current) return reply.code(404).send({ ok: false, error: 'Request not found' });
    try {
      let row: MediaRequestRow;
      if (action === 'approve' && current.status === 'requested') {
        row = await updateRequest(id, { status: 'approved', approved_by: req.user!.userId, approved_at: new Date(), provider_error: null });
      } else if (action === 'reject' && ['requested', 'failed'].includes(current.status)) {
        row = await updateRequest(id, { status: 'rejected', approved_by: req.user!.userId, approved_at: new Date(), provider_error: null });
      } else if (action === 'retry' && current.status === 'failed') {
        row = await updateRequest(id, { status: current.provider_request_id ? 'submitted' : 'approved', provider_error: null });
      } else {
        throw new Error(`Action ${String(action)} is not valid for a ${current.status} request`);
      }
      await audit('plugin_media_request_changed', { pluginId: plugin.id, requestId: id, action, by: req.user!.userId });
      await notifyRequest(row, String(action));
      if (row.status === 'approved' || row.status === 'submitted') void runMissingMusicJobs().catch(() => undefined);
      return { ok: true, request: serializeRequest(row) };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.delete('/api/plugins/missing-music/requests/:id', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    const { id } = req.params as { id: string };
    const result = await db().query<MediaRequestRow>('select * from plugin_media_requests where id=$1 and plugin_id=$2', [id, plugin.id]);
    const row = result.rows[0];
    if (!row) return reply.code(404).send({ ok: false, error: 'Request not found' });
    if (req.user!.role !== 'admin' && row.user_id !== req.user!.userId) return reply.code(403).send({ ok: false, error: 'Access denied' });
    await db().query('delete from plugin_media_requests where id=$1', [id]);
    await audit('plugin_media_request_deleted', { pluginId: plugin.id, requestId: id, by: req.user!.userId });
    await notifyRequest({ ...row, status: 'cancelled' }, 'deleted');
    return { ok: true };
  });
});
