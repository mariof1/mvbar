import { db } from './db.js';
import logger from './logger.js';

const LASTFM_API_KEY = process.env.LASTFM_API_KEY || '';
const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/';
const CACHE_TTL_HOURS = 168; // 7 days

interface SimilarArtist {
  name: string;
  match: number; // 0-1 similarity score
  mbid?: string;
}

interface ArtistInfo {
  name: string;
  mbid?: string;
  tags: string[];
  similar: SimilarArtist[];
}

interface TrackInfo {
  name: string;
  artist: string;
  duration?: number;
  tags: string[];
}

// Check if Last.fm is configured
export function isLastfmEnabled(): boolean {
  return LASTFM_API_KEY.length > 10;
}

// Get cached data or null
async function getCache<T>(key: string): Promise<T | null> {
  try {
    const r = await db().query<{ data: T; fetched_at: Date }>(
      `select data, fetched_at from lastfm_cache where cache_key = $1`,
      [key]
    );
    if (r.rows.length === 0) return null;
    
    const row = r.rows[0];
    const age = (Date.now() - new Date(row.fetched_at).getTime()) / 3600000;
    if (age > CACHE_TTL_HOURS) return null;
    
    return row.data;
  } catch {
    return null;
  }
}

// Set cache
async function setCache(key: string, data: unknown): Promise<void> {
  try {
    await db().query(
      `insert into lastfm_cache(cache_key, data, fetched_at) values ($1, $2, now())
       on conflict (cache_key) do update set data = $2, fetched_at = now()`,
      [key, JSON.stringify(data)]
    );
  } catch {
    logger.error('lastfm', 'Cache write failed');
  }
}

// Fetch from Last.fm API
async function fetchLastfm(method: string, params: Record<string, string>): Promise<any> {
  if (!isLastfmEnabled()) return null;

  const url = new URL(LASTFM_BASE);
  url.searchParams.set('method', method);
  url.searchParams.set('api_key', LASTFM_API_KEY);
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  try {
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'mvbar/1.0' },
      signal: AbortSignal.timeout(5000)
    });

    if (!res.ok) {
      logger.error('lastfm', `API error: ${res.status}`);
      return null;
    }

    return await res.json();
  } catch {
    logger.error('lastfm', 'Fetch failed');
    return null;
  }
}

/**
 * Get similar artists for a given artist name
 * Returns artists sorted by similarity score
 */
export async function getSimilarArtists(artistName: string, limit = 20): Promise<SimilarArtist[]> {
  if (!artistName || !isLastfmEnabled()) return [];

  const cacheKey = `similar:${artistName.toLowerCase()}`;
  const cached = await getCache<SimilarArtist[]>(cacheKey);
  if (cached) return cached.slice(0, limit);

  const data = await fetchLastfm('artist.getsimilar', { artist: artistName, limit: '50' });
  if (!data?.similarartists?.artist) return [];

  const similar: SimilarArtist[] = data.similarartists.artist.map((a: any) => ({
    name: a.name,
    match: parseFloat(a.match) || 0,
    mbid: a.mbid || undefined
  }));

  await setCache(cacheKey, similar);
  logger.debug('lastfm', `Fetched ${similar.length} similar to ${artistName}`);

  return similar.slice(0, limit);
}

/**
 * Get artist info including tags and similar artists
 */
export async function getArtistInfo(artistName: string): Promise<ArtistInfo | null> {
  if (!artistName || !isLastfmEnabled()) return null;

  const cacheKey = `artist:${artistName.toLowerCase()}`;
  const cached = await getCache<ArtistInfo>(cacheKey);
  if (cached) return cached;

  const data = await fetchLastfm('artist.getinfo', { artist: artistName });
  if (!data?.artist) return null;

  const artist = data.artist;
  const info: ArtistInfo = {
    name: artist.name,
    mbid: artist.mbid || undefined,
    tags: (artist.tags?.tag || []).map((t: any) => t.name),
    similar: (artist.similar?.artist || []).map((a: any) => ({
      name: a.name,
      match: 1, // Top similar from getinfo don't have match scores
      mbid: a.mbid || undefined
    }))
  };

  await setCache(cacheKey, info);
  return info;
}

/**
 * Get top tags for an artist (genres)
 */
export async function getArtistTags(artistName: string): Promise<string[]> {
  const info = await getArtistInfo(artistName);
  return info?.tags || [];
}

/**
 * Get track info including tags
 */
export async function getTrackInfo(artist: string, track: string): Promise<TrackInfo | null> {
  if (!artist || !track || !isLastfmEnabled()) return null;

  const cacheKey = `track:${artist.toLowerCase()}:${track.toLowerCase()}`;
  const cached = await getCache<TrackInfo>(cacheKey);
  if (cached) return cached;

  const data = await fetchLastfm('track.getinfo', { artist, track });
  if (!data?.track) return null;

  const t = data.track;
  const info: TrackInfo = {
    name: t.name,
    artist: t.artist?.name || artist,
    duration: t.duration ? parseInt(t.duration) : undefined,
    tags: (t.toptags?.tag || []).map((tag: any) => tag.name)
  };

  await setCache(cacheKey, info);
  return info;
}

/**
 * Find local artists that are similar to a given artist
 * Returns artist names that exist in the local library
 */
export async function findSimilarLocalArtists(
  artistName: string,
  limit = 10
): Promise<{ name: string; match: number }[]> {
  const similar = await getSimilarArtists(artistName, 50);
  if (similar.length === 0) return [];

  // Find which of these exist in our library
  const names = similar.map(s => s.name.toLowerCase());
  const localR = await db().query<{ artist: string }>(
    `select distinct lower(artist) as artist from active_tracks where lower(artist) = any($1)`,
    [names]
  );

  const localSet = new Set(localR.rows.map(r => r.artist));
  
  return similar
    .filter(s => localSet.has(s.name.toLowerCase()))
    .slice(0, limit);
}

interface SimilarTrack {
  name: string;
  artist: string;
  match: number;
  mbid?: string;
}

/**
 * Get similar tracks for a given track
 * Returns tracks sorted by similarity score
 */
export async function getSimilarTracks(artistName: string, trackName: string, limit = 20): Promise<SimilarTrack[]> {
  if (!artistName || !trackName || !isLastfmEnabled()) return [];

  const cacheKey = `similar_track:${artistName.toLowerCase()}:${trackName.toLowerCase()}`;
  const cached = await getCache<SimilarTrack[]>(cacheKey);
  if (cached) return cached.slice(0, limit);

  const data = await fetchLastfm('track.getsimilar', { artist: artistName, track: trackName, limit: '50' });
  if (!data?.similartracks?.track) return [];

  const similar: SimilarTrack[] = data.similartracks.track.map((t: any) => ({
    name: t.name,
    artist: t.artist?.name || '',
    match: parseFloat(t.match) || 0,
    mbid: t.mbid || undefined
  }));

  await setCache(cacheKey, similar);
  logger.debug('lastfm', `Fetched ${similar.length} similar tracks to ${artistName} - ${trackName}`);

  return similar.slice(0, limit);
}

/**
 * Find local tracks that are similar to a given track
 * Returns track IDs that exist in the local library
 */
export async function findSimilarLocalTracks(
  artistName: string,
  trackName: string,
  excludeTrackIds: number[] = [],
  limit = 20
): Promise<{ id: number; title: string; artist: string; match: number }[]> {
  const similar = await getSimilarTracks(artistName, trackName, 100);
  if (similar.length === 0) return [];

  // Batch lookup: build (title, artist) pairs and query all at once
  const pairs = similar.slice(0, 50);
  if (pairs.length === 0) return [];

  // Build a VALUES clause for batch matching
  const values: string[] = [];
  const params: (string | number[])[] = [];
  let paramIdx = 1;
  for (const s of pairs) {
    values.push(`(lower($${paramIdx}), lower($${paramIdx + 1}))`);
    params.push(s.name, s.artist);
    paramIdx += 2;
  }

  const excludeClause = excludeTrackIds.length > 0
    ? `AND t.id != ALL($${paramIdx})`
    : '';
  if (excludeTrackIds.length > 0) params.push(excludeTrackIds as any);

  const r = await db().query<{ id: number; title: string; artist: string; matched_title: string; matched_artist: string }>(
    `SELECT DISTINCT ON (t.id) t.id, t.title, t.artist, lower(t.title) as matched_title, lower(t.artist) as matched_artist
     FROM active_tracks t
     WHERE (lower(t.title), lower(t.artist)) IN (${values.join(',')})
       ${excludeClause}`,
    params
  );

  // Also try partial artist match for tracks not found with exact match
  const foundTitles = new Set(r.rows.map(row => row.matched_title));
  const missingPairs = pairs.filter(s => !foundTitles.has(s.name.toLowerCase()));

  let partialResults: typeof r.rows = [];
  if (missingPairs.length > 0 && missingPairs.length <= 20) {
    const partialValues: string[] = [];
    const partialParams: (string | number[])[] = [];
    let pIdx = 1;
    for (const s of missingPairs.slice(0, 20)) {
      partialValues.push(`(lower(t.title) = lower($${pIdx}) AND lower(t.artist) LIKE '%' || lower($${pIdx + 1}) || '%')`);
      partialParams.push(s.name, s.artist);
      pIdx += 2;
    }
    const pExclude = excludeTrackIds.length > 0 ? `AND t.id != ALL($${pIdx})` : '';
    if (excludeTrackIds.length > 0) partialParams.push(excludeTrackIds as any);

    const pr = await db().query<{ id: number; title: string; artist: string; matched_title: string; matched_artist: string }>(
      `SELECT DISTINCT ON (t.id) t.id, t.title, t.artist, lower(t.title) as matched_title, lower(t.artist) as matched_artist
       FROM active_tracks t
       WHERE (${partialValues.join(' OR ')}) ${pExclude}
       LIMIT ${limit}`,
      partialParams
    );
    partialResults = pr.rows;
  }

  // Merge results and map back to match scores
  const allRows = [...r.rows, ...partialResults];
  const seenIds = new Set<number>();
  const results: { id: number; title: string; artist: string; match: number }[] = [];

  // Create lookup for match scores
  const matchScoreLookup = new Map<string, number>();
  for (const s of pairs) {
    matchScoreLookup.set(`${s.name.toLowerCase()}::${s.artist.toLowerCase()}`, s.match);
  }

  for (const row of allRows) {
    if (seenIds.has(row.id) || results.length >= limit) continue;
    seenIds.add(row.id);
    
    // Find best match score
    let matchScore = 0;
    for (const s of pairs) {
      if (row.matched_title === s.name.toLowerCase() &&
          row.matched_artist.includes(s.artist.toLowerCase())) {
        matchScore = s.match;
        break;
      }
    }
    
    results.push({ id: row.id, title: row.title, artist: row.artist, match: matchScore });
  }
  
  return results.sort((a, b) => b.match - a.match);
}
