import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { allowedLibrariesForUser } from '../access.js';
import { audit, db, redis } from '../db.js';
import logger from '../logger.js';
import type { Role } from '../store.js';
import { broadcastToAdmins, broadcastToUser } from '../websocket.js';
import { pluginsEnabledGlobally } from './registry.js';
import type { NdpManifest, PluginDbRow } from './types.js';
import { cleanupLegacyStagedAlbumArchives, createStagedAlbumArchive, deezerStagingConfig, listStagedAlbumFiles, searchDeezerAlbums, searchDeezerTracks, stageDeezerAlbum, stagedAlbumComplete, stagedAlbumRelativePath, stageDeezerTrack, validStagedAlbumIdentifier, validStagedFilename, verifiedDeezerAlbum, verifiedDeezerTrack, type ExistingAlbumMetadata } from './deezerStaging.js';
import { deezerAlbum, deezerAlbumTracks, deezerAlbumsForArtist, deezerArtist, deezerFeaturedPlaylists, deezerPlaylistTracks, localAlbumTitleScore, matchDeezerTrack, normalizeDeezerText, searchDeezerArtists, searchDeezerPlaylists, searchDeezerSongs, type DeezerTrack, type LocalTrack } from './deezerCatalog.js';

export const MISSING_MUSIC_PLUGIN_ID = 'mvbar.missing-music';
const EXTENSION_TYPE = 'missing-music';
const MUSICBRAINZ_ORIGIN = 'https://musicbrainz.org';
const MUSICBRAINZ_CACHE_TTL_MS = 24 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MUSICBRAINZ_MAX_ATTEMPTS = 3;

type MissingMusicConfig = {
  providerBaseUrl?: string;
  providerApiToken?: string;
  allowPrivateProvider?: boolean;
  requireAdminApproval?: boolean;
  autoDownloadDeezer?: boolean;
  preferSpecialEditions?: boolean;
  musicBrainzContact?: string;
  releaseGroupTypes?: string;
  excludedSecondaryTypes?: string;
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
  deezer_artist_id: string | null;
  deezer_album_id: string | null;
  deezer_track_id: string | null;
  requested_isrc: string | null;
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

type DeezerPlaylistImportRow = {
  id: string;
  plugin_id: string;
  user_id: string;
  deezer_playlist_id: string;
  playlist_id: number | string;
  title: string;
  artwork_url: string | null;
  status: 'queued' | 'downloading' | 'completed' | 'partial' | 'failed';
  total_tracks: number;
  added_tracks: number;
  failed_tracks: number;
  created_at: string | Date;
  updated_at: string | Date;
};

type DeezerPlaylistImportItemRow = {
  import_id: string;
  position: number;
  deezer_track_id: string;
  deezer_album_id: string;
  deezer_artist_id: string | null;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  isrc: string | null;
  track_number: number | null;
  disc_number: number | null;
  request_id: string | null;
  track_id: number | string | null;
  state: 'pending' | 'requested' | 'downloading' | 'added' | 'failed';
  error: string | null;
};

type MbReleaseGroup = {
  id?: string;
  title?: string;
  'primary-type'?: string | null;
  'secondary-types'?: string[];
  'first-release-date'?: string;
};

type MbRelease = {
  id?: string;
  status?: string;
  date?: string;
};

type SavedArtistMatch = {
  musicBrainzId: string;
  musicBrainzName: string;
};

type SavedDeezerArtistMatch = {
  deezerId: string;
  deezerName: string;
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

const LOCAL_ALBUM_EDITION_SUFFIXES = [
  /\s+(?:deluxe|extended|expanded)(?:\s+(?:edition|version))?$/,
  /\s+(?:special|limited|collector s)(?:\s+edition)$/,
  /\s+(?:(?:19|20)\d{2}\s+)?remaster(?:ed)?(?:\s+(?:edition|version))?$/,
  /\s+remaster(?:ed)?\s+(?:19|20)\d{2}$/,
  /\s+(?:\d+(?:st|nd|rd|th)\s+)?anniversary(?:\s+edition)?$/,
  /\s+bonus(?:\s+tracks?)?(?:\s+edition)?$/,
  /\s+(?:mono|stereo)(?:\s+(?:mix|version|edition))?$/,
  /\s+(?:cd|disc|disk)\s*\d+$/,
] as const;

/**
 * Return the base title used when a local album name includes packaging or
 * edition information that MusicBrainz normally keeps in release metadata.
 * MusicBrainz titles themselves are not reduced before comparison, avoiding
 * a base album incorrectly satisfying a genuinely distinct release group.
 */
export function normalizeLocalAlbumTitle(value: string) {
  const original = normalizeCatalogText(value);
  let normalized = original;
  let changed = true;
  while (changed && normalized) {
    changed = false;
    for (const suffix of LOCAL_ALBUM_EDITION_SUFFIXES) {
      const reduced = normalized.replace(suffix, '').trim();
      if (reduced && reduced !== normalized) {
        normalized = reduced;
        changed = true;
      }
    }
  }
  return normalized || original;
}

export function albumTrackIsMissing(recordingId: string | null, title: string, recordingIds: Set<string>, titles: Set<string>) {
  return !((recordingId && recordingIds.has(recordingId)) || titles.has(normalizeCatalogText(title)));
}

function artistMatchKey(userId: string, name: string) {
  return `artist-match:${userId}:${normalizeCatalogText(name)}`;
}

function deezerArtistMatchKey(userId: string, name: string) {
  return `deezer-artist-match:${userId}:${normalizeDeezerText(name)}`;
}

function parseSavedDeezerArtistMatch(value: Buffer): SavedDeezerArtistMatch | null {
  try {
    const parsed = JSON.parse(value.toString('utf8')) as Partial<SavedDeezerArtistMatch>;
    if (!validDeezerId(parsed.deezerId) || typeof parsed.deezerName !== 'string' || !parsed.deezerName.trim()) return null;
    return { deezerId: parsed.deezerId, deezerName: parsed.deezerName.trim() };
  } catch {
    return null;
  }
}

function validDeezerId(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,16}$/.test(value);
}

function parseSavedArtistMatch(value: Buffer): SavedArtistMatch | null {
  try {
    const parsed = JSON.parse(value.toString('utf8')) as Partial<SavedArtistMatch>;
    if (!validMbid(parsed.musicBrainzId) || typeof parsed.musicBrainzName !== 'string' || !parsed.musicBrainzName.trim()) return null;
    return { musicBrainzId: parsed.musicBrainzId, musicBrainzName: parsed.musicBrainzName.trim() };
  } catch {
    return null;
  }
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
  const providerConfigured = typeof config.providerBaseUrl === 'string' && config.providerBaseUrl.trim().length > 0;
  const autoDownloadDeezer = config.autoDownloadDeezer === true;

  if (autoDownloadDeezer && config.requireAdminApproval !== false) {
    throw new Error('Automatic Deezer downloads require administrator approval to be disabled');
  }
  if (autoDownloadDeezer && providerConfigured) {
    throw new Error('Automatic Deezer downloads cannot be used with an external request provider');
  }
  if (providerConfigured) {
    await validateProviderBaseUrl(config.providerBaseUrl, config.allowPrivateProvider === true);
  }
  if (autoDownloadDeezer && !deezerStagingConfig().configured) {
    throw new Error('Configure Deezer staging before enabling automatic downloads');
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

export function songMatchKey(value: string) {
  return value.normalize('NFKD').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]/gu, '');
}

export function songSearchQuery(value: string) {
  const terms = value.trim().split(/\s+/).map(term => {
    const literal = `"${term.replace(/[\\"]/g, '\\$&')}"`;
    return `(recording:${literal} OR artist:${literal})`;
  }).join(' AND ');
  return `(${terms}) AND status:official AND (primarytype:album OR primarytype:ep OR primarytype:single) AND NOT video:true AND NOT comment:(live OR remix OR demo OR karaoke OR instrumental OR acoustic OR alternate OR rehearsal OR edit)`;
}

type SongRelease = {
  id?: string; title?: string; status?: string; date?: string;
  'release-group'?: { id?: string; title?: string; 'primary-type'?: string; 'secondary-types'?: string[] };
};

function alternateVersion(value: string) {
  return /\b(live|remix|demo|karaoke|instrumental|acoustic|unplugged|alternate|alternative|rehearsal|outtake|bootleg|edit|sped[ -]?up|slowed|nightcore|surround|quadraphonic|medley|excerpt|snippet|extended|re-recording|cover|tribute|mashup)\b/i.test(value) || /\b[457]\.1\b/.test(value) || (/\bmix\b/i.test(value) && !/\b(original|album|stereo) mix\b/i.test(value));
}

export function standardSongRelease(recording: { title?: string; disambiguation?: string; video?: boolean | null; releases?: SongRelease[] }) {
  if (recording.video || alternateVersion(recording.disambiguation ?? '')) return undefined;
  // Only inspect version suffixes: titles such as "Live Forever" are ordinary songs.
  const suffix = recording.title?.match(/(?:[([]|\s[–—-]\s)(.*)$/)?.[1] ?? '';
  if (alternateVersion(suffix) || /^(?:.*\bmedley\s*:)/i.test(recording.title ?? '')) return undefined;
  return (recording.releases ?? []).filter(release => {
    const group = release['release-group'];
    return (!release.status || release.status.toLowerCase() === 'official') &&
      ['Album', 'EP', 'Single'].includes(group?.['primary-type'] ?? '') &&
      !(group?.['secondary-types'] ?? []).length;
  }).sort((a, b) => songReleaseRank(a) - songReleaseRank(b) || (a.date || '9999').localeCompare(b.date || '9999'))[0];
}

function songReleaseRank(release: SongRelease) {
  return ['Album', 'EP', 'Single'].indexOf(release['release-group']?.['primary-type'] ?? '');
}

type SongCandidate = {
  recordingId: string; title: string; artist: string; artistNames: string[];
  version?: string | null;
  musicBrainzArtistId: string; album: string | null;
  musicBrainzReleaseGroupId: string | null; musicBrainzReleaseId: string | null;
};

export function songIsPresent(song: Pick<SongCandidate, 'recordingId' | 'title' | 'artistNames'>, local: Array<{
  title: string | null; artist: string | null; musicbrainz_track_id: string | null;
}>) {
  return local.some(track => track.musicbrainz_track_id === song.recordingId || (
    songMatchKey(track.title ?? '') === songMatchKey(song.title) &&
    (track.artist ?? '').split(/\s*(?:;|•|\|)\s*/).some(artist => song.artistNames.some(name => songMatchKey(name) === songMatchKey(artist)))
  ));
}

async function songPresence(req: FastifyRequest, songs: SongCandidate[]) {
  if (!songs.length) return [];
  const filter = libraryFilter(await allowedLibrariesForUser(req.user!.userId, req.user!.role), 4);
  const local = await db().query<{ title: string | null; artist: string | null; musicbrainz_track_id: string | null }>(
    `select track.title, track.artist, track.musicbrainz_track_id from active_tracks track
      where (track.musicbrainz_track_id=any($1::text[]) or lower(track.title)=any($3::text[]) or
        regexp_replace(lower(normalize(coalesce(track.title,''), NFKD)), '[^[:alnum:]]', '', 'g')=any($2::text[])) ${filter.sql}`,
    [songs.map(song => song.recordingId), songs.map(song => songMatchKey(song.title)), songs.map(song => song.title.toLocaleLowerCase('en')), ...filter.params]
  );
  return songs.map(song => songIsPresent(song, local.rows));
}

let musicBrainzQueue = Promise.resolve();
let lastMusicBrainzRequestAt = 0;
const musicBrainzInFlight = new Map<string, Promise<unknown>>();

async function musicBrainzFetch<T>(plugin: MissingMusicPluginRow, cacheKey: string, pathname: string, parameters: Record<string, string>) {
  const inFlightKey = `${plugin.id}:${cacheKey}`;
  const existing = musicBrainzInFlight.get(inFlightKey);
  if (existing) return existing as Promise<T>;
  const cached = await db().query<{ value: Buffer }>(
    `select value from plugin_kv
      where plugin_id=$1 and key=$2 and (expires_at is null or expires_at > now())`,
    [plugin.id, `musicbrainz:${cacheKey}`]
  );
  if (cached.rows[0]) return JSON.parse(cached.rows[0].value.toString('utf8')) as T;
  const queued = musicBrainzInFlight.get(inFlightKey);
  if (queued) return queued as Promise<T>;

  const run = musicBrainzQueue.then(async () => {
    const url = new URL(`/ws/2/${pathname.replace(/^\/+/, '')}`, MUSICBRAINZ_ORIGIN);
    for (const [key, value] of Object.entries({ ...parameters, fmt: 'json' })) url.searchParams.set(key, value);
    const contact = (plugin.config.musicBrainzContact ?? 'https://github.com/mariof1/mvbar').replace(/[\r\n()]/g, '').slice(0, 300);
    let response: Response | null = null;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MUSICBRAINZ_MAX_ATTEMPTS; attempt += 1) {
      const waitMs = Math.max(0, 1100 - (Date.now() - lastMusicBrainzRequestAt));
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      lastMusicBrainzRequestAt = Date.now();
      try {
        response = await fetch(url, {
          headers: { Accept: 'application/json', 'User-Agent': `MVBar/1.1 (${contact})` },
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (response.ok || ![429, 502, 503, 504].includes(response.status) || attempt === MUSICBRAINZ_MAX_ATTEMPTS) break;
        const retryAfterSeconds = Number(response.headers.get('retry-after'));
        await response.body?.cancel().catch(() => undefined);
        await new Promise((resolve) => setTimeout(
          resolve,
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? Math.min(retryAfterSeconds * 1000, 10_000)
            : 1100 * attempt
        ));
      } catch (error) {
        lastError = error;
        response = null;
        if (attempt === MUSICBRAINZ_MAX_ATTEMPTS) break;
        await new Promise((resolve) => setTimeout(resolve, 1100 * attempt));
      }
    }
    if (!response) throw new Error(`MusicBrainz request failed: ${errorMessage(lastError)}`);
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
  musicBrainzInFlight.set(inFlightKey, run);
  void run.then(() => musicBrainzInFlight.delete(inFlightKey), () => musicBrainzInFlight.delete(inFlightKey));
  return run;
}

function configuredReleaseTypes(plugin: MissingMusicPluginRow) {
  const raw = plugin.config.releaseGroupTypes ?? 'Album,EP';
  const values = raw.split(',').map((value) => value.trim().toLocaleLowerCase('en')).filter(Boolean);
  return new Set(values.length ? values : ['album', 'ep']);
}

function configuredExcludedSecondaryTypes(plugin: MissingMusicPluginRow) {
  const raw = plugin.config.excludedSecondaryTypes
    ?? 'Compilation,Live,Remix,DJ-mix,Mixtape/Street,Interview,Audio drama,Spokenword,Soundtrack,Audiobook,Demo';
  return new Set(raw.split(',').map((value) => value.trim().toLocaleLowerCase('en')).filter(Boolean));
}

async function releaseGroupsForArtist(plugin: MissingMusicPluginRow, artistMbid: string) {
  const output: MbReleaseGroup[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await musicBrainzFetch<{ 'release-group-count'?: number; 'release-groups'?: MbReleaseGroup[] }>(
      plugin,
      `artist:${artistMbid}:release-groups:website-default:${offset}`,
      'release-group',
      { artist: artistMbid, 'release-group-status': 'website-default', limit: '100', offset: String(offset) }
    );
    const groups = Array.isArray(page['release-groups']) ? page['release-groups'] : [];
    output.push(...groups);
    if (groups.length < 100 || output.length >= Number(page['release-group-count'] ?? 0)) break;
  }
  const types = configuredReleaseTypes(plugin);
  const excludedSecondaryTypes = configuredExcludedSecondaryTypes(plugin);
  return output.filter((group) => {
    if (!types.has(String(group['primary-type'] ?? '').toLocaleLowerCase('en'))) return false;
    return !(group['secondary-types'] ?? []).some((type) => excludedSecondaryTypes.has(type.toLocaleLowerCase('en')));
  }).sort((left, right) => String(left['first-release-date'] || '9999').localeCompare(String(right['first-release-date'] || '9999'))
    || String(left.title ?? '').localeCompare(String(right.title ?? '')));
}

async function localCatalog(req: FastifyRequest, artistMbid: string, localArtistName = '') {
  const allowed = await allowedLibrariesForUser(req.user!.userId, req.user!.role);
  const filter = libraryFilter(allowed, 3);
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
      where (
        $1 = track.musicbrainz_album_artist_id
        or $1 = track.musicbrainz_artist_id
        or ($2 <> '' and lower(coalesce(nullif(track.album_artist,''),track.artist,'')) = lower($2))
      )
        ${filter.sql}
      group by track.album`,
    [artistMbid, localArtistName, ...filter.params]
  );
  return result.rows;
}

type LocalAlbumSummary = {
  album: string;
  track_count: string | number;
  year: number | null;
};

async function localAlbumsForArtist(req: FastifyRequest, localArtistName: string): Promise<LocalAlbumSummary[]> {
  if (!localArtistName.trim()) return [];
  const allowed = await allowedLibrariesForUser(req.user!.userId, req.user!.role);
  const filter = libraryFilter(allowed, 2);
  const sql =
    "select track.album, count(*) track_count, min(track.year) filter (where track.year is not null) year " +
    "from active_tracks track where track.album is not null and btrim(track.album) <> '' " +
    "and lower(coalesce(nullif(track.album_artist,''),track.artist,'')) = lower($1) " +
    filter.sql + " group by track.album";
  const result = await db().query<LocalAlbumSummary>(sql, [localArtistName.trim(), ...filter.params]);
  return result.rows;
}

function bestLocalAlbum(remoteTitle: string, local: LocalAlbumSummary[]) {
  return local.map(row => ({ row, score: localAlbumTitleScore(remoteTitle, row.album) }))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.row.track_count) - Number(a.row.track_count))[0] ?? null;
}

async function localTracksForAlbum(req: FastifyRequest, localArtistName: string, album: string): Promise<LocalTrack[]> {
  const allowed = await allowedLibrariesForUser(req.user!.userId, req.user!.role);
  const filter = libraryFilter(allowed, 3);
  const sql =
    "select track.id, track.title, track.isrc, track.duration_ms, track.track_number, track.disc_number " +
    "from active_tracks track where lower(track.album)=lower($1) " +
    "and lower(coalesce(nullif(track.album_artist,''),track.artist,''))=lower($2) " +
    filter.sql + " order by coalesce(track.disc_number,1), coalesce(track.track_number,0), track.id";
  const result = await db().query<LocalTrack>(sql, [album, localArtistName.trim(), ...filter.params]);
  return result.rows;
}

type LocalPlaylistCandidate = LocalTrack & {
  artist: string | null;
  album_artist: string | null;
  album: string | null;
};

function playlistItemAsDeezerTrack(item: DeezerPlaylistImportItemRow): DeezerTrack {
  return {
    id: item.deezer_track_id,
    title: item.title,
    artist: item.artist,
    artistId: item.deezer_artist_id,
    albumId: item.deezer_album_id,
    album: item.album ?? '',
    isrc: item.isrc,
    durationMs: item.duration_ms,
    discNumber: item.disc_number && item.disc_number > 0 ? item.disc_number : 1,
    trackNumber: item.track_number && item.track_number > 0 ? item.track_number : 0,
  };
}

function compactIsrc(value: string | null | undefined) {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function playlistArtistMatches(remoteArtist: string, row: LocalPlaylistCandidate) {
  const wanted = normalizeDeezerText(remoteArtist);
  if (!wanted) return false;
  const credits = [row.artist, row.album_artist]
    .filter((value): value is string => Boolean(value))
    .flatMap(value => value.split(/\s*(?:;|•|\|)\s*/));
  return credits.some(value => normalizeDeezerText(value) === wanted);
}

async function localCandidatesForPlaylistItems(
  userId: string,
  role: Role,
  items: DeezerPlaylistImportItemRow[],
): Promise<LocalPlaylistCandidate[]> {
  if (!items.length) return [];
  const allowed = await allowedLibrariesForUser(userId, role);
  const filter = libraryFilter(allowed, 3);
  const titles = [...new Set(items.map(item => item.title.toLocaleLowerCase('en')))];
  const isrcs = [...new Set(items.map(item => compactIsrc(item.isrc)).filter(Boolean))];
  const sql =
    "select track.id,track.title,track.artist,track.album_artist,track.album,track.isrc," +
    "track.duration_ms,track.track_number,track.disc_number from active_tracks track " +
    "where (lower(track.title)=any($1::text[]) or " +
    "($2::text[] <> '{}'::text[] and regexp_replace(upper(coalesce(track.isrc,'')),'[^A-Z0-9]','','g')=any($2::text[]))) " +
    filter.sql;
  const result = await db().query<LocalPlaylistCandidate>(sql, [titles, isrcs, ...filter.params]);
  return result.rows;
}

function matchPlaylistImportItem(item: DeezerPlaylistImportItemRow, candidates: LocalPlaylistCandidate[]) {
  const remote = playlistItemAsDeezerTrack(item);
  const remoteIsrc = compactIsrc(remote.isrc);
  const relevant = candidates.filter(row => {
    const localIsrc = compactIsrc(row.isrc);
    if (remoteIsrc && localIsrc === remoteIsrc) return true;
    return playlistArtistMatches(remote.artist, row);
  });
  return matchDeezerTrack(remote, relevant);
}

function serializePlaylistImport(row: DeezerPlaylistImportRow) {
  return {
    id: row.id,
    deezerPlaylistId: row.deezer_playlist_id,
    playlistId: String(row.playlist_id),
    title: row.title,
    artworkUrl: row.artwork_url,
    status: row.status,
    totalTracks: Number(row.total_tracks),
    addedTracks: Number(row.added_tracks),
    failedTracks: Number(row.failed_tracks),
    pendingTracks: Math.max(0, Number(row.total_tracks) - Number(row.added_tracks) - Number(row.failed_tracks)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function startDeezerPlaylistImport(
  plugin: MissingMusicPluginRow,
  userId: string,
  playlistId: string,
) {
  const existingImport = (await db().query<DeezerPlaylistImportRow>(
    'select * from plugin_deezer_playlist_imports where plugin_id=$1 and user_id=$2 and deezer_playlist_id=$3',
    [plugin.id, userId, playlistId]
  )).rows[0];
  if (existingImport) return { alreadyImported: true, importRow: existingImport };

  const { playlist, tracks } = await deezerPlaylistTracks(playlistId, 1000);
  if (!tracks.length) throw new Error('This Deezer playlist has no downloadable tracks');

  const client = await db().connect();
  let importRow: DeezerPlaylistImportRow;
  let mvbarPlaylistId = 0;
  try {
    await client.query('begin');

    const sourceExisting = await client.query<{ id: number | string }>(
      'select id from playlists where user_id=$1 and source_plugin_id=$2 and source_external_id=$3 limit 1',
      [userId, plugin.id, 'deezer-playlist:' + playlist.id]
    );
    mvbarPlaylistId = sourceExisting.rows[0] ? Number(sourceExisting.rows[0].id) : 0;

    if (!mvbarPlaylistId) {
      try {
        const created = await client.query<{ id: number | string }>(
          'insert into playlists(user_id,name,artwork_url,source_plugin_id,source_external_id) values($1,$2,$3,$4,$5) returning id',
          [userId, playlist.title, playlist.cover, plugin.id, 'deezer-playlist:' + playlist.id]
        );
        mvbarPlaylistId = Number(created.rows[0].id);
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new Error('A playlist named “' + playlist.title + '” already exists. Rename or remove it before importing this Deezer playlist.');
        }
        throw error;
      }
    } else {
      await client.query(
        'update playlists set name=$2,artwork_url=$3 where id=$1 and user_id=$4',
        [mvbarPlaylistId, playlist.title, playlist.cover, userId]
      );
    }

    const importId = crypto.randomUUID();
    importRow = (await client.query<DeezerPlaylistImportRow>(
      "insert into plugin_deezer_playlist_imports(id,plugin_id,user_id,deezer_playlist_id,playlist_id,title,artwork_url,status,total_tracks) " +
      "values($1,$2,$3,$4,$5,$6,$7,'queued',$8) returning *",
      [importId, plugin.id, userId, playlist.id, mvbarPlaylistId, playlist.title, playlist.cover, tracks.length]
    )).rows[0];

    const values: string[] = [];
    const params: unknown[] = [];
    for (const [index, track] of tracks.entries()) {
      const base = params.length;
      values.push(
        '(' + Array.from({ length: 12 }, (_, offset) => '$' + (base + offset + 1)).join(',') + ')'
      );
      params.push(
        importId,
        index,
        track.id,
        track.albumId,
        track.artistId,
        track.title,
        track.artist,
        track.album || null,
        track.durationMs,
        track.isrc,
        track.trackNumber || null,
        track.discNumber || null,
      );
    }
    await client.query(
      'insert into plugin_deezer_playlist_items(' +
      'import_id,position,deezer_track_id,deezer_album_id,deezer_artist_id,title,artist,album,duration_ms,isrc,track_number,disc_number' +
      ') values ' + values.join(','),
      params
    );

    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }

  broadcastToUser(userId, 'playlist:created', {
    id: mvbarPlaylistId,
    playlistId: mvbarPlaylistId,
    name: playlist.title,
    by: userId,
  });
  await audit('plugin_deezer_playlist_import_started', {
    pluginId: plugin.id,
    importId: importRow.id,
    userId,
    deezerPlaylistId: playlist.id,
    playlistId: mvbarPlaylistId,
    title: playlist.title,
    trackCount: tracks.length,
  });

  return { alreadyImported: false, importRow };
}
async function addImportedPlaylistTrack(
  importRow: DeezerPlaylistImportRow,
  item: DeezerPlaylistImportItemRow,
  trackId: number,
) {
  const client = await db().connect();
  try {
    await client.query('begin');
    await client.query(
      "insert into playlist_items(playlist_id,track_id,position,added_by) values($1,$2,$3,$4) " +
      "on conflict(playlist_id,track_id) do update set position=excluded.position,added_by=coalesce(playlist_items.added_by,excluded.added_by)",
      [Number(importRow.playlist_id), trackId, item.position, importRow.user_id]
    );
    await client.query(
      "update plugin_deezer_playlist_items set track_id=$3,state='added',error=null where import_id=$1 and position=$2",
      [importRow.id, item.position, trackId]
    );
    if (item.request_id) {
      await client.query(
        "update plugin_media_requests set status='completed',completed_at=coalesce(completed_at,now()),provider_error=null,updated_at=now() where id=$1",
        [item.request_id]
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
  broadcastToUser(importRow.user_id, 'playlist:item_added', {
    playlistId: Number(importRow.playlist_id),
    trackId,
    position: item.position,
    by: importRow.user_id,
  });
}

async function ensurePlaylistImportRequest(
  plugin: MissingMusicPluginRow,
  importRow: DeezerPlaylistImportRow,
  item: DeezerPlaylistImportItemRow,
) {
  const existing = (await db().query<MediaRequestRow>(
    "select * from plugin_media_requests where plugin_id=$1 and user_id=$2 and deezer_track_id=$3 " +
    "and status not in ('failed','rejected','cancelled','completed') order by created_at desc limit 1",
    [plugin.id, importRow.user_id, item.deezer_track_id]
  )).rows[0];

  if (existing) {
    const metadata = {
      ...existing.metadata,
      autoDownloadDeezer: true,
      hiddenBatch: true,
      deezerPlaylistImportId: importRow.id,
      playlistId: Number(importRow.playlist_id),
      playlistPosition: item.position,
    };
    const updated = (await db().query<MediaRequestRow>(
      "update plugin_media_requests set status=case when status='requested' then 'approved' else status end," +
      "approved_by=coalesce(approved_by,$2),approved_at=coalesce(approved_at,now()),metadata=$3,updated_at=now() where id=$1 returning *",
      [existing.id, importRow.user_id, metadata]
    )).rows[0];
    await db().query(
      "update plugin_deezer_playlist_items set request_id=$3,state=$4,error=null where import_id=$1 and position=$2",
      [importRow.id, item.position, updated.id, updated.status === 'submitted' ? 'downloading' : 'requested']
    );
    return updated;
  }

  const requestId = crypto.randomUUID();
  const metadata = {
    source: 'deezer-playlist',
    autoDownloadDeezer: true,
    hiddenBatch: true,
    deezerPlaylistImportId: importRow.id,
    playlistId: Number(importRow.playlist_id),
    playlistPosition: item.position,
  };
  const request = (await db().query<MediaRequestRow>(
    "insert into plugin_media_requests(" +
    "id,plugin_id,user_id,item_type,artist,title,album,deezer_artist_id,deezer_album_id,deezer_track_id,requested_isrc," +
    "status,approved_by,approved_at,metadata" +
    ") values($1,$2,$3,'track',$4,$5,$6,$7,$8,$9,$10,'approved',$3,now(),$11) returning *",
    [requestId, plugin.id, importRow.user_id, item.artist, item.title, item.album, item.deezer_artist_id,
      item.deezer_album_id, item.deezer_track_id, item.isrc, metadata]
  )).rows[0];
  await db().query(
    "update plugin_deezer_playlist_items set request_id=$3,state='requested',error=null where import_id=$1 and position=$2",
    [importRow.id, item.position, request.id]
  );
  return request;
}

async function reconcileDeezerPlaylistImport(plugin: MissingMusicPluginRow, importId: string) {
  const importResult = await db().query<DeezerPlaylistImportRow & { role: Role }>(
    "select imp.*, app_user.role from plugin_deezer_playlist_imports imp " +
    "join users app_user on app_user.id=imp.user_id where imp.id=$1 and imp.plugin_id=$2",
    [importId, plugin.id]
  );
  const importRow = importResult.rows[0];
  if (!importRow || ['completed','partial','failed'].includes(importRow.status)) return importRow ?? null;

  const items = (await db().query<DeezerPlaylistImportItemRow>(
    "select * from plugin_deezer_playlist_items where import_id=$1 and state<>'added' order by position",
    [importId]
  )).rows;
  const candidates = await localCandidatesForPlaylistItems(importRow.user_id, importRow.role, items);
  const requestIds = items.map(item => item.request_id).filter((id): id is string => Boolean(id));
  const requests = requestIds.length ? (await db().query<MediaRequestRow>(
    "select * from plugin_media_requests where id=any($1::text[])",
    [requestIds]
  )).rows : [];
  const requestsById = new Map(requests.map(request => [request.id, request]));

  for (const item of items) {
    const match = matchPlaylistImportItem(item, candidates);
    if (match.present && match.localTrackId !== null) {
      await addImportedPlaylistTrack(importRow, item, Number(match.localTrackId));
      continue;
    }

    const request = item.request_id ? requestsById.get(item.request_id) : undefined;
    if (request && ['failed','rejected','cancelled'].includes(request.status)) {
      await db().query(
        "update plugin_deezer_playlist_items set state='failed',error=$3 where import_id=$1 and position=$2",
        [importRow.id, item.position, request.provider_error ?? 'Deezer download failed']
      );
      continue;
    }
    if (request) {
      const state = (request.metadata?.deezer as { state?: string } | undefined)?.state;
      await db().query(
        "update plugin_deezer_playlist_items set state=$3,error=null where import_id=$1 and position=$2",
        [importRow.id, item.position, state === 'downloading' || request.status === 'submitted' ? 'downloading' : 'requested']
      );
      continue;
    }

    await ensurePlaylistImportRequest(plugin, importRow, item);
  }

  const counts = (await db().query<{ total: string | number; added: string | number; failed: string | number }>(
    "select count(*) total,count(*) filter(where state='added') added,count(*) filter(where state='failed') failed " +
    "from plugin_deezer_playlist_items where import_id=$1",
    [importRow.id]
  )).rows[0];
  const total = Number(counts?.total ?? 0);
  const added = Number(counts?.added ?? 0);
  const failed = Number(counts?.failed ?? 0);
  const status: DeezerPlaylistImportRow['status'] = total > 0 && added + failed >= total
    ? (failed > 0 ? 'partial' : 'completed')
    : 'downloading';
  const updated = (await db().query<DeezerPlaylistImportRow>(
    "update plugin_deezer_playlist_imports set status=$2,total_tracks=$3,added_tracks=$4,failed_tracks=$5,updated_at=now() " +
    "where id=$1 returning *",
    [importRow.id, status, total, added, failed]
  )).rows[0];

  broadcastToUser(importRow.user_id, 'missing-music:update', {
    event: 'playlist-import',
    requestId: importRow.id,
    userId: importRow.user_id,
    status,
    artist: 'Deezer',
    title: importRow.title,
    message: `${importRow.title}: ${added}/${total} tracks added${failed ? `, ${failed} failed` : ''}`,
    at: new Date().toISOString(),
  });
  return updated;
}

async function reconcileDeezerPlaylistImports(plugin: MissingMusicPluginRow) {
  const imports = await db().query<{ id: string }>(
    "select id from plugin_deezer_playlist_imports where plugin_id=$1 and status in ('queued','downloading') order by updated_at limit 20",
    [plugin.id]
  );
  for (const row of imports.rows) {
    try {
      await reconcileDeezerPlaylistImport(plugin, row.id);
    } catch (error) {
      logger.warn('missing-music', `Could not reconcile Deezer playlist import ${row.id}: ${errorMessage(error)}`);
    }
  }
}
function serializeRequest(row: MediaRequestRow) {
  const deezer = row.metadata?.deezer as { state?: string; filename?: string; trackId?: string; albumId?: string; trackCount?: number; completed?: number; total?: number; phase?: string; usedLocalAlbumMetadata?: boolean } | undefined;
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
    deezerArtistId: row.deezer_artist_id,
    deezerAlbumId: row.deezer_album_id,
    deezerTrackId: row.deezer_track_id,
    requestedIsrc: row.requested_isrc,
    status: row.status,
    providerRequestId: row.provider_request_id,
    error: row.provider_error,
    deezer: deezer ? { state: deezer.state ?? null, filename: deezer.filename ?? null,
      trackId: deezer.trackId ?? null, albumId: deezer.albumId ?? null, trackCount: deezer.trackCount ?? null,
      completed: deezer.completed ?? null, total: deezer.total ?? null, phase: deezer.phase ?? null,
      usedLocalAlbumMetadata: Boolean(deezer.usedLocalAlbumMetadata) } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

async function stagedMediaAvailable(row: MediaRequestRow): Promise<boolean> {
  const deezer = row.metadata?.deezer as { filename?: unknown; trackFiles?: unknown; trackCount?: unknown } | undefined;
  const directory = deezerStagingConfig().directory;
  if (!directory) return false;

  if (row.item_type === 'album') {
    if (!validStagedAlbumIdentifier(deezer?.filename)) return false;
    if (deezer.trackFiles !== undefined && (!Array.isArray(deezer.trackFiles) || !deezer.trackFiles.every(name => typeof name === 'string'))) {
      return false;
    }
    const expectedCount = typeof deezer.trackCount === 'number' && Number.isSafeInteger(deezer.trackCount) && deezer.trackCount > 0
      ? deezer.trackCount
      : undefined;
    return stagedAlbumComplete(deezer.filename, deezer.trackFiles as string[] | undefined, expectedCount);
  }

  if (!validStagedFilename(deezer?.filename)) return false;
  try {
    const file = await stat(path.join(directory, deezer.filename));
    return file.isFile();
  } catch {
    return false;
  }
}

const deezerJobs = new Map<string, Promise<void>>();

async function existingAlbumMetadata(request: MediaRequestRow): Promise<ExistingAlbumMetadata | null> {
  if (request.item_type !== 'track') return null;
  const localAlbum = typeof request.metadata?.localAlbum === 'string' && request.metadata.localAlbum.trim()
    ? request.metadata.localAlbum.trim() : request.album?.trim();
  const localArtist = typeof request.metadata?.localArtist === 'string' && request.metadata.localArtist.trim()
    ? request.metadata.localArtist.trim() : request.artist.trim();
  if (!localAlbum) return null;
  const result = await db().query<ExistingAlbumMetadata>(
    `select t.album, t.album_artist, t.year, t.genre, t.country, t.language
       from active_tracks t
      where lower(t.album)=lower($1) and t.source_plugin_id is null
        and (lower(t.artist)=lower($2) or lower(t.album_artist)=lower($2)
          or exists (select 1 from track_artists ta join artists a on a.id=ta.artist_id
                      where ta.track_id=t.id and lower(a.name)=lower($2)))
      order by (t.album_artist is not null)::int + (t.year is not null)::int
             + (t.genre is not null)::int + (t.country is not null)::int + (t.language is not null)::int desc,
               t.id asc
      limit 1`,
    [localAlbum, localArtist]
  );
  return result.rows[0] ?? null;
}

async function startAutomaticDeezerDownload(plugin: MissingMusicPluginRow, request: MediaRequestRow) {
  if (request.status !== 'approved' || deezerJobs.has(request.id)) return;

  const staging = deezerStagingConfig();
  if (!staging.configured) throw new Error(staging.error);

  let itemId = request.item_type === 'album' ? request.deezer_album_id : request.deezer_track_id;
  if (!itemId) {
    const candidates = request.item_type === 'album'
      ? await searchDeezerAlbums(request.artist, request.title)
      : await searchDeezerTracks(request.artist, request.title, request.album);
    itemId = candidates[0]?.id ?? null;
  }
  if (!itemId) throw new Error('No confident Deezer match was found for automatic download');

  const key = request.item_type === 'album' ? 'albumId' : 'trackId';
  const updateSql =
    "update plugin_media_requests set status='submitted', submitted_at=now(), provider_error=null, " +
    "metadata=jsonb_set(metadata,'{deezer}',jsonb_build_object('state','downloading',$2::text,$3::text,'automatic',true)), " +
    "updated_at=now() where id=$1 and plugin_id=$4 and status='approved' and not (metadata ? 'deezer') returning *";
  const claimed = (await db().query<MediaRequestRow>(updateSql, [request.id, key, itemId, plugin.id])).rows[0];
  if (!claimed) return;

  const localAlbum = claimed.item_type === 'track' ? await existingAlbumMetadata(claimed) : null;
  const job = downloadDeezerRequest(claimed, itemId, localAlbum);
  deezerJobs.set(claimed.id, job);
  void job;

  void audit('plugin_media_deezer_download_started', {
    pluginId: plugin.id,
    requestId: claimed.id,
    by: claimed.user_id,
    itemType: claimed.item_type,
    deezerId: itemId,
    automatic: true,
    catalogDirect: Boolean(request.deezer_album_id || request.deezer_track_id),
  }).catch(error => logger.warn('missing-music', 'Could not audit automatic Deezer start: ' + errorMessage(error)));
  await notifyRequest(claimed, 'downloading', 'Automatic Deezer download started');
}

async function downloadDeezerRequest(request: MediaRequestRow, itemId: string, localAlbum: ExistingAlbumMetadata | null) {
  try {
    const album = request.item_type === 'album'
      ? await verifiedDeezerAlbum(itemId, request.artist, request.title) : null;
    const reportProgress = async (completed: number, total: number, phase: 'downloading' | 'publishing') => {
      try {
        const row = (await db().query<MediaRequestRow>(`update plugin_media_requests
          set metadata=jsonb_set(metadata,'{deezer}',coalesce(metadata->'deezer','{}'::jsonb)
            || jsonb_build_object('completed',$2::int,'total',$3::int,'phase',$4::text)), updated_at=now()
          where id=$1 and metadata->'deezer'->>'state'='downloading' returning *`,
        [request.id, completed, total, phase])).rows[0];
        if (row) await notifyRequest(row, 'download-progress');
      } catch (error) {
        logger.warn('missing-music', `Could not record Deezer progress for ${request.id}: ${errorMessage(error)}`);
      }
    };
    const filename = album
      ? await stageDeezerAlbum(album, reportProgress)
      : await stageDeezerTrack(await verifiedDeezerTrack(itemId, request.artist, request.title, request.album), localAlbum);
    const trackFiles = album ? await listStagedAlbumFiles(filename) : null;
    if (album && trackFiles?.length !== album.trackCount) throw new Error('Staged album track list is incomplete');
    const deezer = album
      ? { state: 'staged', albumId: itemId, trackCount: album.trackCount, trackFiles, filename }
      : { state: 'staged', trackId: itemId, filename, usedLocalAlbumMetadata: Boolean(localAlbum) };
    const row = await updateRequest(request.id, {
      metadata: { ...request.metadata, deezer },
      provider_error: null,
    });
    if (row) {
      void audit('plugin_media_staged_from_deezer', { pluginId: request.plugin_id, requestId: request.id,
        itemType: request.item_type, deezerId: itemId, trackCount: album?.trackCount ?? 1, filename })
        .catch(error => logger.warn('missing-music', `Could not audit Deezer staging: ${errorMessage(error)}`));
      try {
        await redis().publish('library:commands', JSON.stringify({ command: 'rescan', by: 'missing-music', mountPath: deezerStagingConfig().directory }));
      } catch (error) {
        logger.warn('missing-music', `Could not trigger staging library scan: ${errorMessage(error)}`);
      }
      await notifyRequest(row, 'staged', 'Download is ready and being added to the library');
    }
  } catch (error) {
    const message = errorMessage(error).slice(0, 500);
    try {
      const row = await updateRequest(request.id, {
        status: 'failed',
        provider_error: message,
        metadata: { ...request.metadata, deezer: { state: 'failed', [request.item_type === 'album' ? 'albumId' : 'trackId']: itemId } },
      });
      if (row) await notifyRequest(row, 'failed', message);
    } catch (databaseError) {
      logger.error('missing-music', `Could not record Deezer staging failure for ${request.id}: ${errorMessage(databaseError)}`);
    }
    logger.warn('missing-music', `Deezer staging failed for request ${request.id}: ${message}`);
  } finally {
    deezerJobs.delete(request.id);
    const next = setTimeout(() => void runMissingMusicJobs().catch((error) => {
      logger.warn('missing-music', `Could not continue queued Deezer jobs: ${errorMessage(error)}`);
    }), 250);
    next.unref();
  }
}

async function recoverInterruptedDeezerJobs() {
  await db().query(`update plugin_media_requests
    set status='failed', provider_error='Deezer download was interrupted. Choose the track again to retry.',
        metadata=jsonb_set(metadata,'{deezer,state}','"failed"'::jsonb), updated_at=now()
    where plugin_id=$1 and metadata->'deezer'->>'state'='downloading'`, [MISSING_MUSIC_PLUGIN_ID]);
}

async function notifyRequest(row: MediaRequestRow, event: string, message?: string) {
  const data = {
    event,
    requestId: row.id,
    userId: row.user_id,
    status: row.status,
    artist: row.artist,
    title: row.title,
    message: message ? `${row.artist} — ${row.title}: ${message}` : undefined,
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
        deezer: {
          artistId: request.deezer_artist_id,
          albumId: request.deezer_album_id,
          trackId: request.deezer_track_id,
          isrc: request.requested_isrc,
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
    if (!plugin) return;

    const providerConfigured = Boolean(plugin.config.providerBaseUrl?.trim());
    if (!providerConfigured) await reconcileDeezerPlaylistImports(plugin);

    const jobs = providerConfigured
      ? await db().query<MediaRequestRow>(
        `select * from plugin_media_requests
          where plugin_id=$1 and status in ('approved','submitted') and not (metadata ? 'deezer')
            and metadata->>'hiddenBatch' is distinct from 'true'
          order by updated_at,id limit 3`,
        [plugin.id]
      )
      : await db().query<MediaRequestRow>(
        `select * from plugin_media_requests
          where plugin_id=$1 and status='approved'
            and metadata->>'autoDownloadDeezer'='true' and not (metadata ? 'deezer')
          order by updated_at,id limit 3`,
        [plugin.id]
      );

    for (const request of jobs.rows) {
      try {
        if (providerConfigured) {
          await processRequest(plugin, request);
        } else {
          await startAutomaticDeezerDownload(plugin, request);
        }
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
  void cleanupLegacyStagedAlbumArchives()
    .then((removed) => {
      if (removed > 0) logger.info('missing-music', `Removed ${removed} legacy staged album ZIP archive${removed === 1 ? '' : 's'}`);
    })
    .catch((error) => logger.warn('missing-music', `Could not clean legacy staged album ZIPs: ${errorMessage(error)}`));
  void recoverInterruptedDeezerJobs().then(() => runMissingMusicJobs()).catch((error) => {
    logger.warn('missing-music', `Could not recover interrupted Deezer jobs: ${errorMessage(error)}`);
  });
}

export const missingMusicPlugin: FastifyPluginAsync = fp(async (app) => {
  app.get('/api/plugins/missing-music/songs/search', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const plugin = await getMissingMusicPlugin(true);
    if (!plugin) return { ok: true, enabled: false, songs: [] };
    const q = (req.query as { q?: unknown }).q;
    if (typeof q !== 'string' || q.trim().length < 3 || q.length > 200) {
      return reply.code(400).send({ ok: false, error: 'Enter between 3 and 200 characters' });
    }
    try {
      const songs = await searchDeezerSongs(q);
      if (!songs.length) return { ok: true, enabled: true, songs: [] };

      const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
      const filter = libraryFilter(allowed, 3);
      const titles = [...new Set(songs.map(song => song.title.toLocaleLowerCase('en')))];
      const isrcs = [...new Set(songs.map(song => (song.isrc ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean))];
      const localSql =
        "select track.id,track.title,track.artist,track.album_artist,track.album,track.isrc,track.duration_ms,track.track_number,track.disc_number " +
        "from active_tracks track where (lower(track.title)=any($1::text[]) " +
        "or regexp_replace(upper(coalesce(track.isrc,'')),'[^A-Z0-9]','','g')=any($2::text[])) " +
        filter.sql;
      const local = await db().query<LocalTrack & { artist: string | null; album_artist: string | null }>(
        localSql,
        [titles, isrcs, ...filter.params]
      );

      const requested = await db().query<{ deezer_track_id: string }>(
        "select deezer_track_id from plugin_media_requests where plugin_id=$1 and user_id=$2 " +
        "and item_type='track' and deezer_track_id=any($3::text[]) and status not in ('failed','rejected','cancelled')",
        [plugin.id, req.user.userId, songs.map(song => song.id)]
      );
      const requestedIds = new Set(requested.rows.map(row => row.deezer_track_id));

      return {
        ok: true,
        enabled: true,
        songs: songs.map(song => {
          const remoteArtist = normalizeDeezerText(song.artist);
          const remoteIsrc = (song.isrc ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
          const relevant = local.rows.filter(row => {
            const localIsrc = (row.isrc ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
            if (remoteIsrc && localIsrc === remoteIsrc) return true;
            const credits = [row.artist, row.album_artist].filter(Boolean).flatMap(value => String(value).split(/\s*(?:;|•|\|)\s*/));
            return credits.some(value => normalizeDeezerText(value) === remoteArtist);
          });
          const match = matchDeezerTrack(song, relevant);
          return {
            recordingId: song.id,
            title: song.title,
            artist: song.artist,
            artistNames: [song.artist],
            album: song.album,
            version: null,
            deezerArtistId: song.artistId,
            deezerAlbumId: song.albumId,
            deezerTrackId: song.id,
            isrc: song.isrc,
            durationMs: song.durationMs,
            musicBrainzArtistId: null,
            musicBrainzReleaseGroupId: null,
            musicBrainzReleaseId: null,
            present: match.present,
            matchConfidence: match.confidence,
            requested: requestedIds.has(song.id),
          };
        }),
      };
    } catch (error) {
      logger.warn('missing-music', 'Deezer song search failed: ' + errorMessage(error));
      return reply.code(502).send({ ok: false, error: 'Could not check the Deezer song catalog. Please try again.' });
    }
  });

  app.get('/api/plugins/missing-music/status', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false, error: 'Authentication required' });
    const installed = await getMissingMusicPlugin(false);
    const providerConfigured = Boolean(installed?.config.providerBaseUrl?.trim());
    const staging = deezerStagingConfig();
    let stagingAvailable = staging.configured;
    if (stagingAvailable) {
      try { stagingAvailable = (await stat(staging.directory)).isDirectory(); }
      catch { stagingAvailable = false; }
    }
    let localArtistCount = 0;
    let taggedArtistCount = 0;
    let deezerMatchedArtistCount = 0;
    if (installed) {
      const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
      const filter = libraryFilter(allowed, 1);
      const stats = await db().query<{ local_artist_count: string | number; tagged_artist_count: string | number }>(
        `select count(distinct coalesce(nullif(track.album_artist,''),track.artist)) local_artist_count,
                count(distinct coalesce(nullif(track.album_artist,''),track.artist)) filter (
                  where coalesce(track.musicbrainz_album_artist_id,track.musicbrainz_artist_id) is not null
                ) tagged_artist_count
           from active_tracks track
          where coalesce(nullif(track.album_artist,''),track.artist,'') <> ''
            ${filter.sql}`,
        filter.params
      );
      localArtistCount = Number(stats.rows[0]?.local_artist_count ?? 0);
      taggedArtistCount = Number(stats.rows[0]?.tagged_artist_count ?? 0);
      const savedDeezer = await db().query<{ count: string | number }>(
        "select count(*) count from plugin_kv where plugin_id=$1 and key like $2",
        [installed.id, 'deezer-artist-match:' + req.user.userId + ':%']
      );
      deezerMatchedArtistCount = Number(savedDeezer.rows[0]?.count ?? 0);
    }
    return {
      ok: true,
      installed: Boolean(installed),
      enabled: Boolean(installed?.enabled && pluginsEnabledGlobally()),
      configured: providerConfigured,
      providerConfigured,
      deezerConfigured: stagingAvailable,
      deezerConfigurationError: req.user.role === 'admin' && !stagingAvailable
        ? staging.configured ? 'Deezer staging directory is unavailable. Restore its mount before downloading.' : staging.error
        : null,
      deezerStagingDirectory: req.user.role === 'admin' ? staging.directory || null : null,
      mode: providerConfigured ? 'provider' : 'wanted-list',
      requireAdminApproval: installed?.config.requireAdminApproval !== false,
      autoDownloadDeezer: Boolean(
        installed?.config.requireAdminApproval === false
        && installed?.config.autoDownloadDeezer === true
        && !providerConfigured
      ),
      playlistImportEnabled: Boolean(
        installed
        && !providerConfigured
        && stagingAvailable
        && (req.user.role === 'admin' || (
          installed.config.requireAdminApproval === false
          && installed.config.autoDownloadDeezer === true
        ))
      ),
      localArtistCount,
      taggedArtistCount,
      deezerMatchedArtistCount,
    };
  });

  app.get('/api/plugins/missing-music/deezer-playlists', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    const q = optionalText((req.query as { q?: string }).q, 200) ?? '';
    try {
      const playlists = q ? await searchDeezerPlaylists(q) : await deezerFeaturedPlaylists();
      return { ok: true, playlists };
    } catch (error) {
      logger.warn('missing-music', 'Deezer playlist discovery failed: ' + errorMessage(error));
      return reply.code(502).send({ ok: false, error: 'Could not load Deezer playlists. Please try again.' });
    }
  });

  app.get('/api/plugins/missing-music/deezer-playlist-imports', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    const result = await db().query<DeezerPlaylistImportRow>(
      "select * from plugin_deezer_playlist_imports where plugin_id=$1 and user_id=$2 order by created_at desc limit 50",
      [plugin.id, req.user!.userId]
    );
    return { ok: true, imports: result.rows.map(serializePlaylistImport) };
  });
  app.post('/api/plugins/missing-music/deezer-playlists/:playlistId/import', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    if (plugin.config.providerBaseUrl?.trim()) {
      return reply.code(409).send({ ok: false, error: 'Disable the external request provider before importing Deezer playlists' });
    }
    const staging = deezerStagingConfig();
    if (!staging.configured) return reply.code(409).send({ ok: false, error: staging.error });
    try {
      if (!(await stat(staging.directory)).isDirectory()) throw new Error('Not a directory');
    } catch {
      return reply.code(409).send({ ok: false, error: 'Deezer staging directory is unavailable. Restore its mount before importing a playlist.' });
    }

    const canImport = req.user!.role === 'admin' || (
      plugin.config.requireAdminApproval === false && plugin.config.autoDownloadDeezer === true
    );
    if (!canImport) {
      return reply.code(409).send({
        ok: false,
        error: 'Playlist imports require Auto-download from Deezer for non-administrator users.',
      });
    }

    const { playlistId } = req.params as { playlistId: string };
    if (!validDeezerId(playlistId)) return reply.code(400).send({ ok: false, error: 'Invalid Deezer playlist id' });
    try {
      const result = await startDeezerPlaylistImport(plugin, req.user!.userId, playlistId);
      void runMissingMusicJobs().catch((error) => {
        logger.warn('missing-music', 'Could not start Deezer playlist import: ' + errorMessage(error));
      });
      return reply.code(result.alreadyImported ? 200 : 202).send({
        ok: true,
        alreadyImported: result.alreadyImported,
        import: serializePlaylistImport(result.importRow),
      });
    } catch (error) {
      const message = errorMessage(error);
      const status = message.includes('already exists') ? 409 : message.includes('up to 1000') ? 400 : 502;
      return reply.code(status).send({ ok: false, error: message });
    }
  });
  app.get('/api/plugins/missing-music/artists', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    const query = optionalText((req.query as { q?: string }).q, 200)?.toLocaleLowerCase('en') ?? '';
    const allowed = await allowedLibrariesForUser(req.user!.userId, req.user!.role);
    const filter = libraryFilter(allowed, 2);
    const result = await db().query<{
      name: string;
      musicbrainz_id: string | null;
      album_count: string | number;
      track_count: string | number;
    }>(
      `select coalesce(nullif(track.album_artist,''),track.artist) name,
              max(coalesce(track.musicbrainz_album_artist_id,track.musicbrainz_artist_id)) musicbrainz_id,
              count(distinct nullif(track.album,'')) album_count,
              count(*) track_count
         from active_tracks track
        where coalesce(nullif(track.album_artist,''),track.artist,'') <> ''
          and ($1='' or position($1 in lower(coalesce(nullif(track.album_artist,''),track.artist,''))) > 0)
          ${filter.sql}
        group by 1 order by lower(coalesce(nullif(track.album_artist,''),track.artist)) limit $${2 + filter.params.length}`,
      [query, ...filter.params, query ? 100 : 40]
    );
    const matchKeys = result.rows.flatMap((row) => [
      artistMatchKey(req.user!.userId, row.name),
      deezerArtistMatchKey(req.user!.userId, row.name),
    ]);
    const savedMatches = matchKeys.length
      ? await db().query<{ key: string; value: Buffer }>(
        'select key,value from plugin_kv where plugin_id=$1 and key = any($2::text[])',
        [plugin.id, matchKeys]
      )
      : { rows: [] as Array<{ key: string; value: Buffer }> };
    const savedByKey = new Map(savedMatches.rows.map((row) => [row.key, row.value]));
    return {
      ok: true,
      artists: result.rows.map((row) => {
        const legacyValue = savedByKey.get(artistMatchKey(req.user!.userId, row.name));
        const legacy = row.musicbrainz_id ? null : legacyValue ? parseSavedArtistMatch(legacyValue) : null;
        const deezerValue = savedByKey.get(deezerArtistMatchKey(req.user!.userId, row.name));
        const deezer = deezerValue ? parseSavedDeezerArtistMatch(deezerValue) : null;
        return {
          name: row.name,
          deezerId: deezer?.deezerId ?? null,
          deezerName: deezer?.deezerName ?? null,
          matchSource: deezer ? 'saved' : null,
          musicBrainzId: row.musicbrainz_id ?? legacy?.musicBrainzId ?? null,
          musicBrainzName: legacy?.musicBrainzName ?? null,
          albumCount: Number(row.album_count),
          trackCount: Number(row.track_count),
        };
      }),
    };
  });

  app.get('/api/plugins/missing-music/artists/matches', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    let query: string;
    try {
      query = safeText((req.query as { q?: string }).q, 'Artist name', 200);
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
    try {
      const matches = (await searchDeezerArtists(query)).map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        sortName: candidate.name.split(/\s+/).reverse().join(', '),
        disambiguation: null,
        country: null,
        type: 'Artist',
        score: candidate.score,
        cover: candidate.cover,
        link: candidate.link,
        source: 'deezer',
      }));
      return { ok: true, matches };
    } catch (error) {
      logger.warn('missing-music', 'Deezer artist search failed: ' + errorMessage(error));
      return reply.code(502).send({ ok: false, error: 'Could not search Deezer artists. Please try again.' });
    }
  });

  app.put('/api/plugins/missing-music/artists/match', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    try {
      const body = req.body as Record<string, unknown>;
      const localArtist = safeText(body.localArtist, 'Local artist', 500);
      const deezerId = validDeezerId(body.deezerId) ? body.deezerId : null;
      if (!deezerId) throw new Error('A valid Deezer artist id is required');
      const verified = await deezerArtist(deezerId);
      const deezerName = verified.name;
      const value = Buffer.from(JSON.stringify({ deezerId, deezerName }));
      await db().query(
        "insert into plugin_kv(plugin_id,key,value,expires_at,updated_at) values($1,$2,$3,null,now()) " +
        "on conflict(plugin_id,key) do update set value=excluded.value,expires_at=null,updated_at=now()",
        [plugin.id, deezerArtistMatchKey(req.user!.userId, localArtist), value]
      );
      await audit('plugin_deezer_artist_match_saved', {
        pluginId: plugin.id,
        localArtist,
        deezerId,
        deezerName,
        by: req.user!.userId,
      });
      return { ok: true, match: { localArtist, deezerId, deezerName } };
    } catch (error) {
      return reply.code(400).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.get('/api/plugins/missing-music/deezer-artists/:artistId/catalog', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    const { artistId } = req.params as { artistId: string };
    const localArtist = optionalText((req.query as { localArtist?: string }).localArtist, 500) ?? '';
    if (!validDeezerId(artistId)) return reply.code(400).send({ ok: false, error: 'Invalid Deezer artist id' });
    try {
      const [remoteArtist, localAlbums] = await Promise.all([
        deezerArtist(artistId),
        localAlbumsForArtist(req, localArtist),
      ]);
      const albums = await deezerAlbumsForArtist(artistId, {
        artistName: remoteArtist.name,
        releaseTypes: configuredReleaseTypes(plugin),
        excludedTypes: configuredExcludedSecondaryTypes(plugin),
        preferSpecial: plugin.config.preferSpecialEditions === true,
      });
      return {
        ok: true,
        artist: remoteArtist,
        albums: albums.map((album) => {
          const matched = bestLocalAlbum(album.title, localAlbums);
          const localTrackCount = matched ? Number(matched.row.track_count) : 0;
          const complete = Boolean(matched && album.trackCount > 0 && localTrackCount >= album.trackCount);
          return {
            id: album.id,
            title: album.title,
            primaryType: album.recordType,
            secondaryTypes: album.secondaryTypes,
            firstReleaseDate: album.releaseDate,
            cover: album.cover,
            trackCount: album.trackCount,
            present: complete,
            partial: Boolean(matched) && !complete,
            localAlbum: matched?.row.album ?? null,
            localTrackCount,
            missingTrackCount: album.trackCount > 0 ? Math.max(0, album.trackCount - localTrackCount) : null,
            matchConfidence: matched?.score ?? 0,
          };
        }),
      };
    } catch (error) {
      logger.warn('missing-music', 'Deezer artist catalog failed: ' + errorMessage(error));
      return reply.code(502).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.get('/api/plugins/missing-music/deezer-albums/:albumId/tracks', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    const { albumId } = req.params as { albumId: string };
    const localArtist = optionalText((req.query as { localArtist?: string }).localArtist, 500) ?? '';
    if (!validDeezerId(albumId)) return reply.code(400).send({ ok: false, error: 'Invalid Deezer album id' });
    try {
      const [{ album, tracks }, localAlbums] = await Promise.all([
        deezerAlbumTracks(albumId),
        localAlbumsForArtist(req, localArtist),
      ]);
      const matchedAlbum = bestLocalAlbum(album.title, localAlbums);
      const localTracks = matchedAlbum
        ? await localTracksForAlbum(req, localArtist, matchedAlbum.row.album)
        : [];
      return {
        ok: true,
        album: {
          id: album.id,
          title: album.title,
          artist: album.artist,
          releaseDate: album.releaseDate,
          trackCount: album.trackCount,
          localAlbum: matchedAlbum?.row.album ?? null,
          matchConfidence: matchedAlbum?.score ?? 0,
        },
        tracks: tracks.map((track) => {
          const match = matchDeezerTrack(track, localTracks);
          return {
            id: track.id,
            recordingId: track.id,
            title: track.title,
            discNumber: track.discNumber,
            trackNumber: track.trackNumber,
            number: String(track.trackNumber),
            durationMs: track.durationMs,
            isrc: track.isrc,
            missing: !match.present,
            matchConfidence: match.confidence,
            matchReason: match.reason,
            localTrackId: match.localTrackId,
          };
        }),
      };
    } catch (error) {
      logger.warn('missing-music', 'Deezer album track lookup failed: ' + errorMessage(error));
      return reply.code(502).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.get('/api/plugins/missing-music/artists/:artistMbid/catalog', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    const { artistMbid } = req.params as { artistMbid: string };
    const localArtist = optionalText((req.query as { localArtist?: string }).localArtist, 500) ?? '';
    if (!validMbid(artistMbid)) return reply.code(400).send({ ok: false, error: 'Invalid MusicBrainz artist id' });
    try {
      const [groups, local] = await Promise.all([releaseGroupsForArtist(plugin, artistMbid), localCatalog(req, artistMbid, localArtist)]);
      const localTitles = new Set(local.map((item) => normalizeCatalogText(item.album ?? '')).filter(Boolean));
      const localBaseTitles = new Set(local.map((item) => normalizeLocalAlbumTitle(item.album ?? '')).filter(Boolean));
      return {
        ok: true,
        releaseGroups: groups.map((group) => {
          const musicBrainzTitle = normalizeCatalogText(group.title ?? '');
          return {
            id: group.id,
            title: group.title,
            primaryType: group['primary-type'] ?? null,
            secondaryTypes: group['secondary-types'] ?? [],
            firstReleaseDate: group['first-release-date'] ?? null,
            present: localTitles.has(musicBrainzTitle) || localBaseTitles.has(musicBrainzTitle),
          };
        }),
      };
    } catch (error) {
      return reply.code(502).send({ ok: false, error: errorMessage(error) });
    }
  });

  app.get('/api/plugins/missing-music/release-groups/:releaseGroupMbid/tracks', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    const { releaseGroupMbid } = req.params as { releaseGroupMbid: string };
    const { artistMbid, album, localArtist } = req.query as { artistMbid?: string; album?: string; localArtist?: string };
    if (!validMbid(releaseGroupMbid) || !validMbid(artistMbid)) {
      return reply.code(400).send({ ok: false, error: 'Invalid MusicBrainz id' });
    }
    try {
      const releasesResult = await musicBrainzFetch<{ releases?: MbRelease[] }>(
        plugin,
        `release-group:${releaseGroupMbid}:releases`,
        'release',
        { 'release-group': releaseGroupMbid, limit: '100' }
      );
      const releases = Array.isArray(releasesResult.releases) ? releasesResult.releases : [];
      const local = await localCatalog(req, artistMbid, optionalText(localArtist, 500) ?? '');
      const wantedAlbum = normalizeCatalogText(album ?? '');
      const matching = local.filter((row) => {
        const localTitle = row.album ?? '';
        return normalizeCatalogText(localTitle) === wantedAlbum || normalizeLocalAlbumTitle(localTitle) === wantedAlbum;
      });
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
      }>(plugin, `release:${release.id}:recordings`, `release/${release.id}`, { inc: 'recordings' });
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
          missing: albumTrackIsMissing(recordingId, title, recordingIds, titles),
        };
      }));
      return { ok: true, releaseId: release.id, releaseTitle: detail.title ?? album ?? null, tracks };
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
          and request.metadata->>'hiddenBatch' is distinct from 'true'
        order by request.created_at desc limit 500`,
      all ? [plugin.id] : [plugin.id, req.user!.userId]
    );
    const requests: ReturnType<typeof serializeRequest>[] = [];
    for (let index = 0; index < result.rows.length; index += 32) {
      requests.push(...await Promise.all(result.rows.slice(index, index + 32).map(async row => {
        const serialized = serializeRequest(row);
        if (serialized.deezer?.state === 'staged' && !await stagedMediaAvailable(row)) {
          serialized.deezer.state = 'missing';
        }
        return serialized;
      })));
    }
    return { ok: true, requests };
  });

  app.get('/api/plugins/missing-music/requests/:id/deezer-candidates', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    if (req.user!.role !== 'admin') return reply.code(403).send({ ok: false, error: 'Administrator access required' });
    const { id } = req.params as { id: string };
    const request = (await db().query<MediaRequestRow>('select * from plugin_media_requests where id=$1 and plugin_id=$2', [id, plugin.id])).rows[0];
    if (!request) return reply.code(404).send({ ok: false, error: 'Request not found' });
    try {
      let candidates;
      if (request.item_type === 'album' && request.deezer_album_id) {
        candidates = [await verifiedDeezerAlbum(request.deezer_album_id, request.artist, request.title)];
      } else if (request.item_type === 'track' && request.deezer_track_id) {
        candidates = [await verifiedDeezerTrack(request.deezer_track_id, request.artist, request.title, request.album)];
      } else {
        candidates = request.item_type === 'album'
          ? await searchDeezerAlbums(request.artist, request.title)
          : await searchDeezerTracks(request.artist, request.title, request.album);
      }
      return { ok: true, localAlbumMetadata: await existingAlbumMetadata(request), candidates };
    } catch (error) {
      logger.warn('missing-music', `Deezer catalog lookup failed: ${errorMessage(error)}`);
      return reply.code(502).send({ ok: false, error: 'Could not search Deezer. Please try again.' });
    }
  });

  app.post('/api/plugins/missing-music/requests/:id/deezer-download', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    if (req.user!.role !== 'admin') return reply.code(403).send({ ok: false, error: 'Administrator access required' });
    if (plugin.config.providerBaseUrl) return reply.code(409).send({ ok: false, error: 'Disable the external request provider before using Deezer staging' });
    if (!deezerStagingConfig().configured) return reply.code(409).send({ ok: false, error: deezerStagingConfig().error });
    const body = req.body as { trackId?: unknown; albumId?: unknown; useLocalAlbumMetadata?: unknown } | null;
    if (body?.albumId !== undefined && body.trackId !== undefined) return reply.code(400).send({ ok: false, error: 'Choose one Deezer item' });
    const itemType = body?.albumId !== undefined ? 'album' : 'track';
    const itemId = itemType === 'album' ? body?.albumId : body?.trackId;
    if (typeof itemId !== 'string' || !/^\d{1,16}$/.test(itemId)) return reply.code(400).send({ ok: false, error: 'Invalid Deezer item id' });
    try {
      if (!(await stat(deezerStagingConfig().directory)).isDirectory()) throw new Error('Not a directory');
    } catch {
      return reply.code(409).send({ ok: false, error: 'Deezer staging directory is unavailable. Restore its mount before downloading.' });
    }
    const { id } = req.params as { id: string };
    const existing = (await db().query<MediaRequestRow>(
      'select * from plugin_media_requests where id=$1 and plugin_id=$2', [id, plugin.id]
    )).rows[0];
    if (body?.useLocalAlbumMetadata !== undefined && typeof body.useLocalAlbumMetadata !== 'boolean') {
      return reply.code(400).send({ ok: false, error: 'Invalid album metadata choice' });
    }
    if (body?.useLocalAlbumMetadata && itemType !== 'track') return reply.code(400).send({ ok: false, error: 'Album metadata reuse is only available for songs' });
    const localAlbum = body?.useLocalAlbumMetadata && existing ? await existingAlbumMetadata(existing) : null;
    if (body?.useLocalAlbumMetadata && !localAlbum) return reply.code(409).send({ ok: false, error: 'Matching album metadata is no longer available' });
    const previous = existing?.metadata?.deezer as { state?: string; filename?: string } | undefined;
    const missingStaged = existing?.item_type === itemType && existing.status === 'submitted'
      && previous?.state === 'staged' && !await stagedMediaAvailable(existing);
    const request = (await db().query<MediaRequestRow>(
      `update plugin_media_requests set status='submitted', submitted_at=now(), approved_by=coalesce(approved_by,$3),
        approved_at=coalesce(approved_at,now()), provider_error=null,
        metadata=jsonb_set(metadata,'{deezer}',jsonb_build_object('state','downloading',
          case when item_type='album' then 'albumId' else 'trackId' end,$4::text)), updated_at=now()
       where id=$1 and plugin_id=$2 and item_type=$5 and (
         (status in ('requested','approved','failed') and coalesce(metadata->'deezer'->>'state','') not in ('downloading','staged'))
         or ($6::boolean and status='submitted' and metadata->'deezer'->>'state'='staged'
           and metadata->'deezer'->>'filename'=$7)
       ) returning *`,
      [id, plugin.id, req.user!.userId, itemId, itemType, missingStaged, missingStaged ? previous?.filename : null]
    )).rows[0];
    if (!request) return reply.code(409).send({ ok: false, error: 'Request is not available for Deezer staging' });
    const job = downloadDeezerRequest(request, itemId, localAlbum);
    deezerJobs.set(id, job);
    void audit('plugin_media_deezer_download_started', { pluginId: plugin.id, requestId: id, by: req.user!.userId,
      itemType, deezerId: itemId }).catch(error => logger.warn('missing-music', `Could not audit Deezer start: ${errorMessage(error)}`));
    await notifyRequest(request, 'downloading', 'An administrator started a Deezer download');
    return reply.code(202).send({ ok: true, request: serializeRequest(request) });
  });

  app.get('/api/plugins/missing-music/requests/:id/deezer-file', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    if (req.user!.role !== 'admin') return reply.code(403).send({ ok: false, error: 'Administrator access required' });
    const { id } = req.params as { id: string };
    const request = (await db().query<MediaRequestRow>('select * from plugin_media_requests where id=$1 and plugin_id=$2', [id, plugin.id])).rows[0];
    const deezer = request?.metadata?.deezer as { state?: string; filename?: unknown; trackFiles?: unknown; trackCount?: unknown } | undefined;
    if (deezer?.state !== 'staged') return reply.code(404).send({ ok: false, error: 'No staged file for this request' });
    const directory = deezerStagingConfig().directory;
    if (!directory) return reply.code(404).send({ ok: false, error: 'Staging directory is not configured' });

    if (request?.item_type === 'album') {
      if (!validStagedAlbumIdentifier(deezer.filename)) return reply.code(404).send({ ok: false, error: 'No staged album for this request' });
      if (deezer.trackFiles !== undefined && (!Array.isArray(deezer.trackFiles) || !deezer.trackFiles.every(name => typeof name === 'string'))) {
        return reply.code(404).send({ ok: false, error: 'Invalid staged album manifest' });
      }
      try {
        const archive = await createStagedAlbumArchive(
          deezer.filename,
          deezer.trackFiles as string[] | undefined,
          typeof deezer.trackCount === 'number' ? deezer.trackCount : undefined,
        );
        const downloadName = `${path.basename(stagedAlbumRelativePath(deezer.filename))}.zip`;
        return reply
          .header('Content-Type', 'application/zip')
          .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`)
          .send(archive);
      } catch {
        return reply.code(404).send({ ok: false, error: 'Staged album files are missing or could not be packaged' });
      }
    }

    if (!validStagedFilename(deezer.filename)) return reply.code(404).send({ ok: false, error: 'No staged file for this request' });
    const file = path.join(directory, deezer.filename);
    try {
      const details = await stat(file);
      if (!details.isFile()) throw new Error('Not a file');
    } catch {
      return reply.code(404).send({ ok: false, error: 'Staged file is missing' });
    }
    return reply
      .header('Content-Type', deezer.filename.endsWith('.flac') ? 'audio/flac' : 'audio/mpeg')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(deezer.filename))}`)
      .send(createReadStream(file));
  });

  app.get('/api/plugins/missing-music/requests/:id/deezer-review-album', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    if (req.user!.role !== 'admin') return reply.code(403).send({ ok: false, error: 'Administrator access required' });
    const { id } = req.params as { id: string };
    const request = (await db().query<MediaRequestRow>(
      'select * from plugin_media_requests where id=$1 and plugin_id=$2', [id, plugin.id]
    )).rows[0];
    const filename = (request?.metadata?.deezer as { filename?: unknown } | undefined)?.filename;
    if (!request || typeof filename !== 'string') return reply.code(404).send({ ok: false, error: 'Staged download not found' });

    const isAlbum = request.item_type === 'album';
    if (isAlbum ? !validStagedAlbumIdentifier(filename) : !validStagedFilename(filename)) {
      return reply.code(404).send({ ok: false, error: 'Staged download not found' });
    }

    const albumRelative = isAlbum ? stagedAlbumRelativePath(filename) : null;
    const relative = isAlbum ? `${albumRelative}/` : filename;
    const normalizedPath = "ltrim(replace(t.path, chr(92), '/'), '/')";
    const current = await db().query<{ album: string; artist: string }>(
      `select coalesce(nullif(btrim(t.album), ''), 'Unknown Album — ' ||
                coalesce(nullif(btrim(t.album_artist), ''), nullif(btrim(t.artist), ''), 'Unknown Artist')) as album,
              coalesce(nullif(btrim(t.album_artist), ''), nullif(btrim(t.artist), ''), 'Unknown Artist') as artist
         from active_tracks t join libraries l on l.id=t.library_id
        where l.source_plugin_id=$1 and l.mount_path=$2
          and ${isAlbum ? `left(${normalizedPath}, length($3))=$3` : `${normalizedPath}=$3`}
        order by coalesce(t.disc_number, 1), coalesce(t.track_number, 0), t.id
        limit 1`,
      [MISSING_MUSIC_PLUGIN_ID, deezerStagingConfig().directory, relative]
    );
    if (current.rows[0]) return { ok: true, ...current.rows[0] };

    const parts = (albumRelative ?? filename).split('/');
    const artist = parts.length >= 2 ? parts[0] : request.artist;
    const album = isAlbum
      ? (parts.length >= 2 ? parts[1] : request.title)
      : (parts.length >= 3 ? parts[1] : request.album);
    if (!album) return reply.code(404).send({ ok: false, error: 'Album not found in the library yet' });
    return { ok: true, artist, album };
  });

  app.post('/api/plugins/missing-music/requests', async (req, reply) => {
    const plugin = await requireExtension(req, reply);
    if (!plugin) return;
    try {
      const body = req.body as Record<string, unknown>;
      const itemType = body.itemType === 'album' || body.itemType === 'track' ? body.itemType : null;
      if (!itemType) throw new Error('itemType must be album or track');

      const artist = safeText(body.artist, 'artist');
      let title = safeText(body.title, 'title');
      let album = optionalText(body.album);
      const localArtist = optionalText(body.localArtist, 500) ?? artist;
      const localAlbumHint = optionalText(body.localAlbum, 500);
      const artistMbid = validMbid(body.musicBrainzArtistId) ? body.musicBrainzArtistId : null;
      const releaseGroupMbid = validMbid(body.musicBrainzReleaseGroupId) ? body.musicBrainzReleaseGroupId : null;
      const releaseMbid = validMbid(body.musicBrainzReleaseId) ? body.musicBrainzReleaseId : null;
      const recordingMbid = validMbid(body.musicBrainzRecordingId) ? body.musicBrainzRecordingId : null;
      const deezerArtistId = validDeezerId(body.deezerArtistId) ? body.deezerArtistId : null;
      const deezerAlbumId = validDeezerId(body.deezerAlbumId) ? body.deezerAlbumId : null;
      const deezerTrackId = validDeezerId(body.deezerTrackId) ? body.deezerTrackId : null;
      let requestedIsrc = optionalText(body.isrc, 64);
      const deezerMode = Boolean(deezerArtistId || deezerAlbumId || deezerTrackId);

      if (deezerMode) {
        if (!deezerArtistId) throw new Error('A valid Deezer artist id is required');
        if (!deezerAlbumId) throw new Error('A valid Deezer album id is required');

        if (itemType === 'album') {
          const remote = await deezerAlbum(deezerAlbumId);
          title = remote.title;
          album = remote.title;
        } else {
          if (!deezerTrackId) throw new Error('A valid Deezer track id is required');
          const remote = await deezerAlbumTracks(deezerAlbumId);
          const track = remote.tracks.find(candidate => candidate.id === deezerTrackId);
          if (!track) throw new Error('The selected Deezer track does not belong to this album');
          title = track.title;
          album = remote.album.title;
          requestedIsrc = track.isrc;

          const localAlbums = await localAlbumsForArtist(req, localArtist);
          const hintedAlbum = localAlbumHint
            ? localAlbums.find(candidate => candidate.album.toLocaleLowerCase('en') === localAlbumHint.toLocaleLowerCase('en')) ?? null
            : null;
          const matchedAlbum = hintedAlbum ? { row: hintedAlbum, score: 100 } : bestLocalAlbum(album, localAlbums);
          if (matchedAlbum) {
            const localTracks = await localTracksForAlbum(req, localArtist, matchedAlbum.row.album);
            if (matchDeezerTrack(track, localTracks).present) {
              return reply.code(409).send({ ok: false, error: 'This song is already in your library', present: true });
            }
          }
        }
      } else {
        if (!artistMbid) throw new Error('A MusicBrainz or Deezer artist id is required');
        if (itemType === 'album' && !releaseGroupMbid) throw new Error('A MusicBrainz release-group id is required');
        if (itemType === 'track' && !recordingMbid) throw new Error('A MusicBrainz recording id is required');
        if (itemType === 'track' && (await songPresence(req, [{
          recordingId: recordingMbid!, title, artist, artistNames: [artist],
          musicBrainzArtistId: artistMbid, album,
          musicBrainzReleaseGroupId: releaseGroupMbid, musicBrainzReleaseId: releaseMbid
        }]))[0]) {
          return reply.code(409).send({ ok: false, error: 'This song is already in your library', present: true });
        }
      }

      const keyColumn = deezerMode
        ? (itemType === 'album' ? 'deezer_album_id' : 'deezer_track_id')
        : (itemType === 'album' ? 'musicbrainz_release_group_id' : 'musicbrainz_recording_id');
      const keyValue = deezerMode
        ? (itemType === 'album' ? deezerAlbumId : deezerTrackId)
        : (itemType === 'album' ? releaseGroupMbid : recordingMbid);
      if (!keyValue) throw new Error('Request catalog identifier is missing');

      const status = plugin.config.requireAdminApproval === false ? 'approved' : 'requested';
      const autoDownloadOnCreate = status === 'approved'
        && plugin.config.autoDownloadDeezer === true
        && !plugin.config.providerBaseUrl?.trim();
      const id = crypto.randomUUID();
      const client = await db().connect();
      let row: MediaRequestRow;
      try {
        await client.query('begin');
        await client.query(
          'select pg_advisory_xact_lock(hashtextextended($1,0))',
          [plugin.id + ':' + req.user!.userId + ':' + itemType + ':' + keyValue]
        );
        const duplicateSql =
          'select id from plugin_media_requests where plugin_id=$1 and user_id=$2 and item_type=$3 and ' +
          keyColumn + "=$4 and status not in ('failed','rejected','cancelled') limit 1";
        const duplicate = await client.query<{ id: string }>(
          duplicateSql,
          [plugin.id, req.user!.userId, itemType, keyValue]
        );
        if (duplicate.rows[0]) {
          await client.query('rollback');
          return reply.code(409).send({ ok: false, error: 'This item is already requested' });
        }

        const insertSql =
          'insert into plugin_media_requests(' +
          'id,plugin_id,user_id,item_type,artist,title,album,musicbrainz_artist_id,' +
          'musicbrainz_release_group_id,musicbrainz_release_id,musicbrainz_recording_id,' +
          'deezer_artist_id,deezer_album_id,deezer_track_id,requested_isrc,status,' +
          'approved_by,approved_at,metadata' +
          ') values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) returning *';
        const result = await client.query<MediaRequestRow>(insertSql, [
          id, plugin.id, req.user!.userId, itemType, artist, title, album,
          artistMbid, releaseGroupMbid, releaseMbid, recordingMbid,
          deezerArtistId, deezerAlbumId, deezerTrackId, requestedIsrc,
          status,
          status === 'approved' ? req.user!.userId : null,
          status === 'approved' ? new Date() : null,
          {
            source: deezerMode ? 'deezer' : 'musicbrainz',
            ...(deezerMode ? { localArtist, localAlbum: localAlbumHint } : {}),
            ...(autoDownloadOnCreate ? { autoDownloadDeezer: true } : {}),
          },
        ]);
        row = result.rows[0];
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }

      await audit('plugin_media_requested', {
        pluginId: plugin.id,
        requestId: id,
        userId: req.user!.userId,
        itemType,
        keyValue,
        catalog: deezerMode ? 'deezer' : 'musicbrainz',
      });
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
    if ((current.metadata?.deezer as { state?: string } | undefined)?.state === 'downloading') {
      return reply.code(409).send({ ok: false, error: 'Wait for the Deezer download to finish' });
    }
    try {
      let row: MediaRequestRow;
      if (action === 'approve' && current.status === 'requested') {
        row = await updateRequest(id, { status: 'approved', approved_by: req.user!.userId, approved_at: new Date(), provider_error: null });
      } else if (action === 'reject' && ['requested', 'failed'].includes(current.status)) {
        row = await updateRequest(id, { status: 'rejected', approved_by: req.user!.userId, approved_at: new Date(), provider_error: null });
      } else if (action === 'retry' && current.status === 'failed') {
        if (current.metadata?.deezer) throw new Error('Choose a Deezer match again to retry this download');
        row = await updateRequest(id, { status: current.provider_request_id ? 'submitted' : 'approved', provider_error: null });
      } else if (action === 'complete' && ['requested', 'approved', 'submitted', 'failed'].includes(current.status)) {
        row = await updateRequest(id, {
          status: 'completed',
          completed_at: new Date(),
          provider_error: null,
          approved_by: current.approved_by ?? req.user!.userId,
          approved_at: current.approved_at ?? new Date(),
        });
      } else {
        throw new Error(`Action ${String(action)} is not valid for a ${current.status} request`);
      }
      await audit('plugin_media_request_changed', { pluginId: plugin.id, requestId: id, action, by: req.user!.userId });
      await notifyRequest(row, String(action), action === 'complete' ? 'An administrator marked this request as fulfilled' : undefined);
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
    if ((row.metadata?.deezer as { state?: string } | undefined)?.state === 'downloading') return reply.code(409).send({ ok: false, error: 'Wait for the Deezer download to finish' });
    if (req.user!.role !== 'admin' && row.user_id !== req.user!.userId) return reply.code(403).send({ ok: false, error: 'Access denied' });
    await db().query('delete from plugin_media_requests where id=$1', [id]);
    await audit('plugin_media_request_deleted', { pluginId: plugin.id, requestId: id, by: req.user!.userId });
    await notifyRequest({ ...row, status: 'cancelled' }, 'deleted');
    return { ok: true };
  });
});
