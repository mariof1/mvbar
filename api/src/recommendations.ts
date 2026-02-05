import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import crypto from 'crypto';
import { db } from './db.js';
import { allowedLibrariesForUser } from './access.js';
import { findSimilarLocalArtists, isLastfmEnabled } from './lastfm.js';

// ============================================================================
// GENRE TAXONOMY - Comprehensive genre families
// ============================================================================

const GENRE_FAMILIES: { key: string; label: string; energy: 'low' | 'medium' | 'high'; tokens: string[] }[] = [
  { key: 'rock', label: 'Rock', energy: 'high', tokens: ['rock', 'hard rock', 'classic rock', 'alternative', 'alternative rock', 'indie rock', 'punk', 'punk rock', 'post-punk', 'grunge', 'garage rock', 'glam rock', 'southern rock', 'psychedelic rock', 'progressive rock', 'prog rock', 'post-rock', 'stoner rock', 'art rock', 'britrock'] },
  { key: 'metal', label: 'Metal', energy: 'high', tokens: ['metal', 'heavy metal', 'thrash metal', 'death metal', 'black metal', 'doom metal', 'metalcore', 'hardcore', 'nu metal', 'progressive metal', 'power metal', 'symphonic metal', 'gothic metal', 'industrial metal', 'sludge metal', 'groove metal', 'speed metal', 'deathcore', 'djent'] },
  { key: 'pop', label: 'Pop', energy: 'medium', tokens: ['pop', 'dance pop', 'synthpop', 'synth pop', 'electropop', 'electro pop', 'indie pop', 'power pop', 'k-pop', 'kpop', 'j-pop', 'jpop', 'britpop', 'teen pop', 'art pop', 'chamber pop', 'dream pop', 'noise pop', 'baroque pop', 'city pop'] },
  { key: 'electronic', label: 'Electronic', energy: 'high', tokens: ['dance', 'club', 'edm', 'electronic', 'electronica', 'electro', 'electro house', 'house', 'deep house', 'progressive house', 'tech house', 'techno', 'trance', 'psytrance', 'hardstyle', 'breakbeat', 'breaks', 'dubstep', 'drum and bass', 'dnb', 'd&b', 'jungle', 'uk garage', 'future bass', 'bass music', 'glitch', 'big beat'] },
  { key: 'chill', label: 'Chill & Ambient', energy: 'low', tokens: ['ambient', 'chill', 'chillout', 'chill out', 'chillwave', 'downtempo', 'lofi', 'lo-fi', 'lo fi', 'trip hop', 'trip-hop', 'idm', 'new age', 'meditation', 'relaxation', 'drone', 'dark ambient', 'space ambient', 'atmospheric'] },
  { key: 'synthwave', label: 'Synthwave & Retro', energy: 'medium', tokens: ['synthwave', 'retrowave', 'outrun', 'darksynth', 'dreamwave', 'vaporwave', 'future funk', 'nu disco', 'disco', 'italo disco', 'eurobeat', '80s', 'new wave', 'synth', 'electro funk'] },
  { key: 'hiphop', label: 'Hip-Hop', energy: 'high', tokens: ['hip hop', 'hiphop', 'hip-hop', 'rap', 'trap', 'drill', 'grime', 'boom bap', 'gangsta rap', 'conscious rap', 'underground hip hop', 'southern hip hop', 'west coast hip hop', 'east coast hip hop', 'crunk', 'dirty south', 'cloud rap', 'phonk', 'g-funk'] },
  { key: 'rnb', label: 'R&B & Soul', energy: 'medium', tokens: ['r&b', 'rb', 'rnb', 'rhythm and blues', 'soul', 'neo soul', 'neo-soul', 'funk', 'motown', 'quiet storm', 'contemporary r&b', 'new jack swing', 'urban contemporary'] },
  { key: 'jazz', label: 'Jazz', energy: 'low', tokens: ['jazz', 'smooth jazz', 'bebop', 'swing', 'fusion', 'acid jazz', 'cool jazz', 'free jazz', 'modal jazz', 'hard bop', 'latin jazz', 'jazz fusion', 'nu jazz', 'jazz funk', 'big band', 'dixieland', 'bossa nova'] },
  { key: 'blues', label: 'Blues', energy: 'medium', tokens: ['blues', 'blues rock', 'electric blues', 'delta blues', 'chicago blues', 'texas blues', 'soul blues'] },
  { key: 'classical', label: 'Classical', energy: 'low', tokens: ['classical', 'baroque', 'romantic', 'opera', 'symphony', 'symphonic', 'orchestral', 'orchestra', 'chamber music', 'concerto', 'sonata', 'minimalist', 'contemporary classical', 'neoclassical', 'impressionist', 'piano'] },
  { key: 'soundtrack', label: 'Soundtracks', energy: 'medium', tokens: ['soundtrack', 'score', 'film score', 'movie soundtrack', 'game soundtrack', 'video game', 'ost', 'cinematic', 'epic', 'trailer music', 'musical', 'broadway', 'anime'] },
  { key: 'country', label: 'Country', energy: 'medium', tokens: ['country', 'country rock', 'alt-country', 'outlaw country', 'country pop', 'honky tonk', 'western', 'americana', 'red dirt', 'texas country', 'bluegrass', 'country folk'] },
  { key: 'folk', label: 'Folk & Acoustic', energy: 'low', tokens: ['folk', 'folk rock', 'indie folk', 'contemporary folk', 'traditional folk', 'celtic', 'irish', 'scottish', 'singer songwriter', 'singer-songwriter', 'acoustic', 'unplugged', 'fingerstyle'] },
  { key: 'latin', label: 'Latin', energy: 'high', tokens: ['latin', 'reggaeton', 'salsa', 'bachata', 'cumbia', 'latin pop', 'latin rock', 'merengue', 'tango', 'samba', 'tropicalia', 'mariachi', 'urbano', 'dembow', 'latin trap'] },
  { key: 'reggae', label: 'Reggae & Caribbean', energy: 'medium', tokens: ['reggae', 'ska', 'dub', 'dancehall', 'roots reggae', 'lovers rock', 'rocksteady', 'ragga', 'soca', 'calypso'] },
  { key: 'world', label: 'World Music', energy: 'medium', tokens: ['world', 'world music', 'african', 'afrobeat', 'afropop', 'afrobeats', 'middle eastern', 'arabic', 'indian', 'bollywood', 'asian', 'flamenco', 'fado', 'chanson', 'balkan', 'klezmer', 'gypsy'] },
  { key: 'punk', label: 'Punk', energy: 'high', tokens: ['punk', 'punk rock', 'pop punk', 'skate punk', 'hardcore punk', 'emo', 'screamo', 'post-hardcore', 'melodic hardcore', 'street punk', 'oi'] },
  { key: 'indie', label: 'Indie', energy: 'medium', tokens: ['indie', 'indie rock', 'indie pop', 'indie folk', 'indie electronic', 'lo-fi indie', 'bedroom pop', 'shoegaze', 'dream pop', 'slowcore', 'sadcore'] },
  { key: 'gospel', label: 'Gospel & Christian', energy: 'medium', tokens: ['gospel', 'christian', 'christian rock', 'worship', 'ccm', 'contemporary christian', 'praise', 'spiritual'] },
];

// Build lookup maps
const tokenToFamily = new Map<string, { key: string; label: string; energy: string }>();
for (const fam of GENRE_FAMILIES) {
  for (const t of fam.tokens) {
    tokenToFamily.set(t.toLowerCase().trim(), { key: fam.key, label: fam.label, energy: fam.energy });
  }
}

// Tempo labels
function tempoLabel(bpm: number): { label: string; subtitle: string } {
  if (bpm < 70) return { label: 'Slow & Mellow', subtitle: `Around ${Math.round(bpm)} BPM` };
  if (bpm < 90) return { label: 'Chill Vibes', subtitle: `Around ${Math.round(bpm)} BPM` };
  if (bpm < 105) return { label: 'Easy Listening', subtitle: `Around ${Math.round(bpm)} BPM` };
  if (bpm < 120) return { label: 'Steady Groove', subtitle: `Around ${Math.round(bpm)} BPM` };
  if (bpm < 135) return { label: 'Upbeat', subtitle: `Around ${Math.round(bpm)} BPM` };
  if (bpm < 150) return { label: 'Energy Boost', subtitle: `Around ${Math.round(bpm)} BPM` };
  if (bpm < 170) return { label: 'Workout Mode', subtitle: `Around ${Math.round(bpm)} BPM` };
  return { label: 'High Intensity', subtitle: `Around ${Math.round(bpm)} BPM` };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function dailySeed(...parts: (string | number)[]): number {
  const today = new Date().toISOString().split('T')[0];
  const hash = crypto.createHash('sha256').update(`${today}:${parts.join(':')}`).digest('hex');
  return parseInt(hash.slice(0, 12), 16);
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const result = [...arr];
  const rand = seededRandom(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Fold diacritics for matching (e.g., "Sokół" -> "Sokol")
function foldDiacritics(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .replace(/ø/g, 'o')
    .replace(/Ø/g, 'O')
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .toLowerCase();
}

function getTimeContext(): { period: 'morning' | 'afternoon' | 'evening' | 'night'; energyBias: number } {
  const hour = new Date().getHours();
  if (hour >= 6 && hour < 12) return { period: 'morning', energyBias: 0.3 };
  if (hour >= 12 && hour < 17) return { period: 'afternoon', energyBias: 0.5 };
  if (hour >= 17 && hour < 22) return { period: 'evening', energyBias: 0.7 };
  return { period: 'night', energyBias: 0.2 };
}

// ============================================================================
// TYPES
// ============================================================================

interface TrackData {
  id: number;
  title: string;
  artist: string;
  album: string | null;
  art_path: string | null;
  art_hash: string | null;
  genre: string | null;
  year: number | null;
  country: string | null;
  language: string | null;
  bpm: number | null;
  play_count: number;
  skip_count: number;
  last_played_at: Date | null;
  is_favorite: boolean;
  updated_at: Date | null;
  score?: number;
}

interface Bucket {
  key: string;
  name: string;
  subtitle?: string;
  reason?: string;
  count: number;
  tracks: { id: number; title: string; artist: string }[];
  art_paths: string[];
  art_hashes: string[];
}

// ============================================================================
// SCORING ENGINE
// ============================================================================

interface ScoringOptions {
  purpose: 'discovery' | 'familiar' | 'mixed' | 'rediscover';
  now: number;
  recentlyPlayedIds: Set<number>;
  favoriteIds: Set<number>;
}

function scoreTrack(track: TrackData, opts: ScoringOptions): number {
  let score = 0;
  const { purpose, now, recentlyPlayedIds, favoriteIds } = opts;
  
  // Base signals
  if (track.is_favorite) score += 20;
  if (track.play_count > 0) score += Math.log2(track.play_count + 1) * 4;
  
  // Skip penalty
  if (track.skip_count > 0) {
    score -= Math.pow(track.skip_count, 1.3) * 2;
    // High skip ratio = very bad
    if (track.play_count > 0) {
      const skipRatio = track.skip_count / (track.play_count + track.skip_count);
      if (skipRatio > 0.5) score -= 15;
      if (skipRatio > 0.7) score -= 25;
    }
  }
  
  // Recency
  if (track.last_played_at) {
    const daysSince = (now - new Date(track.last_played_at).getTime()) / 86400000;
    
    if (daysSince < 0.08) score -= 40; // < 2 hours
    else if (daysSince < 0.5) score -= 20; // < 12 hours  
    else if (daysSince < 1) score -= 10; // < 24 hours
    else if (daysSince < 3) score -= 5; // < 3 days
    
    // Rediscovery sweet spot
    if (purpose === 'rediscover') {
      if (daysSince >= 30 && daysSince <= 90) score += 15;
      else if (daysSince > 90 && daysSince <= 180) score += 20;
      else if (daysSince > 180) score += 10;
    } else if (daysSince >= 30) {
      score += 5;
    }
  } else {
    // Never played
    if (purpose === 'discovery') score += 20;
    else if (purpose === 'mixed') score += 8;
  }
  
  // Purpose adjustments
  if (purpose === 'discovery') {
    if (track.play_count === 0) score += 15;
    else score -= track.play_count * 2;
  } else if (purpose === 'familiar') {
    if (track.play_count >= 5) score += 12;
    if (track.is_favorite) score += 15;
  }
  
  // Library freshness
  if (track.updated_at) {
    const daysInLibrary = (now - new Date(track.updated_at).getTime()) / 86400000;
    if (daysInLibrary <= 7) score += 10;
    else if (daysInLibrary <= 30) score += 5;
  }
  
  return Math.max(-50, Math.min(100, score));
}

// ============================================================================
// DIVERSITY HELPER
// ============================================================================

// Filter out tracks with high skip ratio (>60%)
function filterHighSkipRatio(tracks: TrackData[]): TrackData[] {
  return tracks.filter(t => {
    if (t.skip_count === 0) return true;
    if (t.play_count === 0) return t.skip_count < 3; // Allow up to 2 skips if never fully played
    const skipRatio = t.skip_count / (t.play_count + t.skip_count);
    return skipRatio <= 0.6;
  });
}

function diversify(
  tracks: TrackData[],
  opts: { maxPerArtist?: number; maxPerAlbum?: number; limit?: number; seed?: number; filterSkips?: boolean }
): TrackData[] {
  const { maxPerArtist = 2, maxPerAlbum = 3, limit = 25, seed, filterSkips = true } = opts;
  
  // Filter out heavily skipped tracks
  let filtered = filterSkips ? filterHighSkipRatio(tracks) : tracks;
  let sorted = [...filtered].sort((a, b) => (b.score || 0) - (a.score || 0));
  
  // Shuffle top tier for variety
  if (seed !== undefined && sorted.length > 15) {
    const top = seededShuffle(sorted.slice(0, 40), seed);
    sorted = [...top, ...sorted.slice(40)];
  }
  
  const result: TrackData[] = [];
  const artistCount = new Map<string, number>();
  const albumCount = new Map<string, number>();
  
  for (const track of sorted) {
    const artist = (track.artist || '').toLowerCase();
    const album = (track.album || '').toLowerCase();
    
    if ((artistCount.get(artist) || 0) >= maxPerArtist) continue;
    if (album && (albumCount.get(album) || 0) >= maxPerAlbum) continue;
    
    result.push(track);
    artistCount.set(artist, (artistCount.get(artist) || 0) + 1);
    if (album) albumCount.set(album, (albumCount.get(album) || 0) + 1);
    
    if (result.length >= limit) break;
  }
  
  return result;
}

// ============================================================================
// MAIN PLUGIN
// ============================================================================

export const recommendationsPlugin: FastifyPluginAsync = fp(async (app) => {
  app.get('/api/recommendations', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const userId = req.user.userId;
    const allowed = await allowedLibrariesForUser(userId, req.user.role);
    const libFilter = allowed ? `and t.library_id = any($lib::bigint[])` : '';
    const now = Date.now();
    const timeContext = getTimeContext();
    const buckets: Bucket[] = [];

    // ========================================================================
    // HELPER FUNCTIONS
    // ========================================================================

    async function getBucketArt(ids: number[]): Promise<{ art_paths: string[]; art_hashes: string[] }> {
      if (ids.length === 0) return { art_paths: [], art_hashes: [] };
      const r = await db().query(
        `select distinct on (t.album) t.art_path, t.art_hash
         from active_tracks t where t.id = any($1) and t.art_path is not null
         order by t.album limit 4`,
        [ids]
      );
      return {
        art_paths: r.rows.map((r: any) => r.art_path).filter(Boolean),
        art_hashes: r.rows.map((r: any) => r.art_hash).filter(Boolean)
      };
    }

    async function addBucket(key: string, name: string, tracks: TrackData[], subtitle?: string, reason?: string) {
      if (tracks.length < 4) return;
      const art = await getBucketArt(tracks.map(t => t.id));
      if (art.art_paths.length === 0) return;
      
      buckets.push({
        key, name, subtitle, reason,
        count: tracks.length,
        tracks: tracks.slice(0, 15).map(t => ({ id: t.id, title: t.title, artist: t.artist })),
        ...art
      });
    }

    // ========================================================================
    // LOAD USER DATA
    // ========================================================================

    // Favorites
    const favR = await db().query<{ track_id: number }>(`select track_id from favorite_tracks where user_id = $1`, [userId]);
    const favoriteIds = new Set(favR.rows.map(r => r.track_id));

    // Recently played (24h)
    const recentR = await db().query<{ track_id: number }>(
      `select distinct track_id from play_history where user_id = $1 and played_at > now() - interval '24 hours'`,
      [userId]
    );
    const recentlyPlayedIds = new Set(recentR.rows.map(r => r.track_id));

    const scoringOpts: ScoringOptions = { purpose: 'mixed', now, recentlyPlayedIds, favoriteIds };

    // Top artists
    const topArtistsR = await db().query<{ artist: string; plays: number }>(
      `select t.artist, sum(s.play_count)::int as plays
       from user_track_stats s join active_tracks t on t.id = s.track_id
       where s.user_id = $1 and t.artist is not null and s.play_count > 0
       group by t.artist order by plays desc limit 20`,
      [userId]
    );

    // Top genres
    const topGenresR = await db().query<{ genre: string; plays: number }>(
      `select tg.genre, sum(s.play_count)::int as plays
       from user_track_stats s join track_genres tg on tg.track_id = s.track_id
       where s.user_id = $1 and s.play_count > 0
       group by tg.genre order by plays desc limit 30`,
      [userId]
    );

    // Top genre + country combos (for "Polish Hip-Hop" style buckets)
    const genreCountryR = await db().query<{ genre: string; country: string; plays: number }>(
      `select tg.genre, t.country, sum(s.play_count)::int as plays
       from user_track_stats s 
       join active_tracks t on t.id = s.track_id
       join track_genres tg on tg.track_id = t.id
       where s.user_id = $1 and s.play_count > 0 and t.country is not null and t.country != ''
       group by tg.genre, t.country
       having sum(s.play_count) >= 3
       order by plays desc limit 10`,
      [userId]
    );

    // Top decades listened to
    const decadesR = await db().query<{ decade: number; plays: number }>(
      `select (t.year / 10 * 10)::int as decade, sum(s.play_count)::int as plays
       from user_track_stats s join active_tracks t on t.id = s.track_id
       where s.user_id = $1 and s.play_count > 0 and t.year is not null and t.year >= 1950
       group by decade order by plays desc limit 5`,
      [userId]
    );

    // Top languages
    const languagesR = await db().query<{ language: string; plays: number }>(
      `select t.language, sum(s.play_count)::int as plays
       from user_track_stats s join active_tracks t on t.id = s.track_id
       where s.user_id = $1 and s.play_count > 0 and t.language is not null and t.language != ''
       group by t.language order by plays desc limit 5`,
      [userId]
    );

    // ========================================================================
    // BUCKET: TOP PICKS FOR YOU
    // ========================================================================

    const topPicksR = await db().query<TrackData>(
      `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash, t.updated_at,
              coalesce(s.play_count, 0)::int as play_count,
              coalesce(s.skip_count, 0)::int as skip_count,
              s.last_played_at,
              case when f.track_id is not null then true else false end as is_favorite
       from active_tracks t
       left join user_track_stats s on s.track_id = t.id and s.user_id = $1
       left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
       where (s.play_count > 0 or f.track_id is not null)
         ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
       limit 200`,
      allowed ? [userId, allowed] : [userId]
    );

    if (topPicksR.rows.length > 0) {
      const scored = topPicksR.rows.map(t => ({ ...t, score: scoreTrack(t, scoringOpts) }));
      const diverse = diversify(scored, { limit: 50, seed: dailySeed(userId, 'top_picks') });
      await addBucket('top_picks', 'Top Picks For You', diverse, 'Personalized just for you');
    }

    // ========================================================================
    // BUCKET: ON REPEAT
    // ========================================================================

    const onRepeatR = await db().query<TrackData>(
      `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
              s.play_count, s.skip_count, s.last_played_at,
              false as is_favorite, null as updated_at
       from user_track_stats s join active_tracks t on t.id = s.track_id
       where s.user_id = $1 and s.last_played_at > now() - interval '14 days' and s.play_count >= 2
         ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
       order by s.play_count desc limit 100`,
      allowed ? [userId, allowed] : [userId]
    );

    if (onRepeatR.rows.length >= 5) {
      const diverse = diversify(
        onRepeatR.rows.map(t => ({ ...t, score: t.play_count })),
        { maxPerArtist: 3, limit: 50 }
      );
      await addBucket('on_repeat', 'On Repeat', diverse, 'Your heavy rotation lately');
    }

    // ========================================================================
    // BUCKET: REDISCOVER
    // ========================================================================

    const rediscoverR = await db().query<TrackData>(
      `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
              s.play_count, s.skip_count, s.last_played_at,
              false as is_favorite, null as updated_at
       from user_track_stats s join active_tracks t on t.id = s.track_id
       where s.user_id = $1 and s.play_count >= 3 and s.last_played_at < now() - interval '45 days'
         ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
       order by s.play_count desc, s.last_played_at asc limit 50`,
      allowed ? [userId, allowed] : [userId]
    );

    if (rediscoverR.rows.length >= 5) {
      const scored = rediscoverR.rows.map(t => ({
        ...t,
        score: scoreTrack(t, { ...scoringOpts, purpose: 'rediscover' })
      }));
      const diverse = diversify(scored, { limit: 50, seed: dailySeed(userId, 'rediscover') });
      await addBucket('rediscover', 'Rediscover', diverse, 'Forgotten gems worth replaying');
    }

    // ========================================================================
    // BUCKET: FAVORITES
    // ========================================================================

    if (favoriteIds.size > 0) {
      const favsR = await db().query<TrackData>(
        `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                coalesce(s.play_count, 0)::int as play_count,
                coalesce(s.skip_count, 0)::int as skip_count,
                s.last_played_at, true as is_favorite, f.added_at as updated_at
         from favorite_tracks f join active_tracks t on t.id = f.track_id
         left join user_track_stats s on s.track_id = t.id and s.user_id = $1
         where f.user_id = $1 ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
         order by f.added_at desc limit 30`,
        allowed ? [userId, allowed] : [userId]
      );
      await addBucket('favorites', 'Your Favorites', favsR.rows, `${favoriteIds.size} loved tracks`);
    }

    // ========================================================================
    // BUCKET: BECAUSE YOU SEARCHED "X" (up to 5)
    // ========================================================================

    // Get recent searches with results (most recent first)
    const searchLogsR = await db().query<{ query: string; query_normalized: string }>(
      `select query, query_normalized
       from (
         select query, query_normalized, max(created_at) as latest
         from search_logs 
         where user_id = $1 and result_count >= 5 and length(query_normalized) >= 3
         group by query, query_normalized
       ) t order by latest desc`,
      [userId]
    );

    // Filter and deduplicate searches
    const stopWords = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from']);
    const searches = searchLogsR.rows
      .filter(r => !stopWords.has(r.query_normalized) && r.query_normalized.length >= 3)
      .slice(0, 20);

    // Dedupe by removing prefixes
    const chosenSearches: { query: string; normalized: string }[] = [];
    for (const s of searches) {
      const isPrefix = chosenSearches.some(c => 
        c.normalized.startsWith(s.query_normalized) || s.query_normalized.startsWith(c.normalized)
      );
      if (!isPrefix) {
        chosenSearches.push({ query: s.query, normalized: s.query_normalized });
      }
      if (chosenSearches.length >= 5) break;
    }

    for (const search of chosenSearches) {
      const term = search.query.trim();
      const termFold = foldDiacritics(term);
      const termLower = term.toLowerCase();
      let matchType = '';
      let matchedTracks: TrackData[] = [];

      // Try year match
      if (/^\d{4}$/.test(term) && parseInt(term) >= 1900 && parseInt(term) <= 2100) {
        const year = parseInt(term);
        const yearR = await db().query<TrackData>(
          `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                  coalesce(s.play_count, 0)::int as play_count, 0 as skip_count,
                  s.last_played_at, false as is_favorite, null as updated_at
           from active_tracks t left join user_track_stats s on s.track_id = t.id and s.user_id = $1
           where t.year = $2 ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
           order by coalesce(s.play_count, 0) desc limit 50`,
          allowed ? [userId, year, allowed] : [userId, year]
        );
        if (yearR.rows.length > 0) {
          matchType = `Matching year ${year}`;
          matchedTracks = yearR.rows;
        }
      }

      // Try genre match (partial)
      if (matchedTracks.length === 0) {
        const genreR = await db().query<TrackData>(
          `select distinct t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                  coalesce(s.play_count, 0)::int as play_count, 0 as skip_count,
                  s.last_played_at, false as is_favorite, null as updated_at
           from active_tracks t join track_genres tg on tg.track_id = t.id
           left join user_track_stats s on s.track_id = t.id and s.user_id = $1
           where lower(tg.genre) like $2 ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
           order by coalesce(s.play_count, 0) desc limit 50`,
          allowed ? [userId, `%${termLower}%`, allowed] : [userId, `%${termLower}%`]
        );
        if (genreR.rows.length > 0) {
          matchType = `Matching genre`;
          matchedTracks = genreR.rows;
        }
      }

      // Try country match
      if (matchedTracks.length === 0) {
        const countryR = await db().query<TrackData>(
          `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                  coalesce(s.play_count, 0)::int as play_count, 0 as skip_count,
                  s.last_played_at, false as is_favorite, null as updated_at
           from active_tracks t left join user_track_stats s on s.track_id = t.id and s.user_id = $1
           where lower(t.country) = $2 ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
           order by coalesce(s.play_count, 0) desc limit 50`,
          allowed ? [userId, termLower, allowed] : [userId, termLower]
        );
        if (countryR.rows.length > 0) {
          matchType = `Matching country`;
          matchedTracks = countryR.rows;
        }
      }

      // Try artist match (with diacritics folding)
      if (matchedTracks.length === 0) {
        const artistR = await db().query<TrackData>(
          `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                  coalesce(s.play_count, 0)::int as play_count, 0 as skip_count,
                  s.last_played_at, false as is_favorite, null as updated_at
           from active_tracks t left join user_track_stats s on s.track_id = t.id and s.user_id = $1
           where (lower(t.artist) like $2 or lower(t.artist) like $3)
             ${allowed ? `and t.library_id = any($4::bigint[])` : ''}
           order by coalesce(s.play_count, 0) desc limit 50`,
          allowed ? [userId, `%${termLower}%`, `%${termFold}%`, allowed] : [userId, `%${termLower}%`, `%${termFold}%`]
        );
        if (artistR.rows.length > 0) {
          matchType = `Matching artist`;
          matchedTracks = artistR.rows;
        }
      }

      // Try album match
      if (matchedTracks.length === 0) {
        const albumR = await db().query<TrackData>(
          `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                  coalesce(s.play_count, 0)::int as play_count, 0 as skip_count,
                  s.last_played_at, false as is_favorite, null as updated_at
           from active_tracks t left join user_track_stats s on s.track_id = t.id and s.user_id = $1
           where lower(t.album) like $2 ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
           order by t.album, coalesce(s.play_count, 0) desc limit 50`,
          allowed ? [userId, `%${termLower}%`, allowed] : [userId, `%${termLower}%`]
        );
        if (albumR.rows.length > 0) {
          matchType = `Matching album`;
          matchedTracks = albumR.rows;
        }
      }

      if (matchedTracks.length >= 5) {
        // Prioritize unplayed then played
        const unplayed = matchedTracks.filter(t => t.play_count === 0);
        const played = matchedTracks.filter(t => t.play_count > 0).sort((a, b) => b.play_count - a.play_count);
        const combined = [...unplayed, ...played];
        
        // For artist searches, don't limit per artist (the whole bucket IS that artist)
        const isArtistMatch = matchType === 'Matching artist';
        const diverse = diversify(
          combined.map(t => ({ ...t, score: t.play_count === 0 ? 10 : t.play_count })),
          { maxPerArtist: isArtistMatch ? 50 : 3, maxPerAlbum: isArtistMatch ? 10 : 3, limit: 50 }
        );
        
        await addBucket(
          `search_${search.normalized.replace(/\W/g, '_').slice(0, 30)}`,
          `Because you searched "${term}"`,
          diverse,
          matchType
        );
      }
    }

    // ========================================================================
    // BUCKET: BECAUSE YOU LISTEN TO X (Last.fm similar artists)
    // ========================================================================

    if (isLastfmEnabled() && topArtistsR.rows.length >= 3) {
      // Pick top artist with most plays
      const topArtist = topArtistsR.rows[0];
      const similarLocal = await findSimilarLocalArtists(topArtist.artist, 10);
      
      if (similarLocal.length >= 2) {
        const similarNames = similarLocal.map(s => s.name.toLowerCase());
        const similarR = await db().query<TrackData>(
          `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                  coalesce(s.play_count, 0)::int as play_count, 0 as skip_count,
                  s.last_played_at, false as is_favorite, null as updated_at
           from active_tracks t left join user_track_stats s on s.track_id = t.id and s.user_id = $1
           where lower(t.artist) = any($2) ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
           order by coalesce(s.play_count, 0) desc limit 150`,
          allowed ? [userId, similarNames, allowed] : [userId, similarNames]
        );

        if (similarR.rows.length >= 10) {
          // Prefer unplayed
          const scored = similarR.rows.map(t => ({
            ...t,
            score: t.play_count === 0 ? 20 : 10 - Math.min(t.play_count, 5)
          }));
          const diverse = diversify(scored, { maxPerArtist: 3, limit: 50 });
          await addBucket(
            'similar_to_top',
            `Because you listen to ${topArtist.artist}`,
            diverse,
            'Similar artists you might like'
          );
        }
      }
    }

    // ========================================================================
    // BUCKET: GENRE + COUNTRY COMBOS (e.g., "Polish Hip-Hop")
    // ========================================================================

    const usedFamilyCountryCombos = new Set<string>();
    for (const gc of genreCountryR.rows.slice(0, 5)) {
      // Map genre to family for nicer label and deduplication
      const family = tokenToFamily.get(gc.genre.toLowerCase());
      const familyKey = family?.key || gc.genre.toLowerCase();
      const genreLabel = family?.label || gc.genre;
      
      // Skip if we already have this family+country combo
      const comboKey = `${familyKey}_${gc.country.toLowerCase()}`;
      if (usedFamilyCountryCombos.has(comboKey)) continue;
      usedFamilyCountryCombos.add(comboKey);

      // Get all genres in this family for broader matching
      const familyGenres = family ? [...GENRE_FAMILIES.find(f => f.key === family.key)?.tokens || []] : [gc.genre.toLowerCase()];
      
      const gcR = await db().query<TrackData>(
        `select distinct on (t.id)
                t.id, t.title, t.artist, t.album, t.art_path, t.art_hash, t.updated_at,
                coalesce(s.play_count, 0)::int as play_count,
                coalesce(s.skip_count, 0)::int as skip_count,
                s.last_played_at,
                case when f.track_id is not null then true else false end as is_favorite
         from active_tracks t 
         join track_genres tg on tg.track_id = t.id
         left join user_track_stats s on s.track_id = t.id and s.user_id = $1
         left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
         where lower(tg.genre) = any($2) and lower(t.country) = $3
           ${allowed ? `and t.library_id = any($4::bigint[])` : ''}
         order by t.id
         limit 100`,
        allowed ? [userId, familyGenres, gc.country.toLowerCase(), allowed] 
                : [userId, familyGenres, gc.country.toLowerCase()]
      );

      if (gcR.rows.length >= 10) {
        const scored = gcR.rows.map(t => ({ ...t, score: scoreTrack(t, scoringOpts) }));
        const diverse = diversify(scored, { maxPerArtist: 3, limit: 50 });
        await addBucket(
          `genre_country_${familyKey}_${gc.country.toLowerCase().replace(/\W/g, '_')}`,
          `${gc.country} ${genreLabel}`,
          diverse,
          `Because you listen to a lot of ${gc.country} ${genreLabel.toLowerCase()}`
        );
      }
    }

    // ========================================================================
    // BUCKET: DECADE FAVORITES (e.g., "Your 90s Favorites")
    // ========================================================================

    for (const dec of decadesR.rows.slice(0, 2)) {
      if (dec.plays < 5) continue;
      
      const decadeR = await db().query<TrackData>(
        `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash, t.updated_at,
                coalesce(s.play_count, 0)::int as play_count,
                coalesce(s.skip_count, 0)::int as skip_count,
                s.last_played_at,
                case when f.track_id is not null then true else false end as is_favorite
         from active_tracks t
         left join user_track_stats s on s.track_id = t.id and s.user_id = $1
         left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
         where t.year >= $2 and t.year < $3
           ${allowed ? `and t.library_id = any($4::bigint[])` : ''}
         limit 100`,
        allowed ? [userId, dec.decade, dec.decade + 10, allowed] 
                : [userId, dec.decade, dec.decade + 10]
      );

      if (decadeR.rows.length >= 15) {
        const scored = decadeR.rows.map(t => ({ ...t, score: scoreTrack(t, scoringOpts) }));
        const diverse = diversify(scored, { maxPerArtist: 2, limit: 50 });
        const decadeLabel = dec.decade === 2000 ? '2000s' : 
                           dec.decade === 2010 ? '2010s' : 
                           dec.decade === 2020 ? '2020s' : `${dec.decade}s`;
        await addBucket(
          `decade_${dec.decade}`,
          `Your ${decadeLabel} Favorites`,
          diverse,
          `Throwback to the ${decadeLabel}`
        );
      }
    }

    // ========================================================================
    // BUCKET: LANGUAGE MIX (e.g., "More Polish Music")
    // ========================================================================

    for (const lang of languagesR.rows.slice(0, 2)) {
      if (lang.plays < 5 || lang.language.toLowerCase() === 'english') continue;
      
      const langR = await db().query<TrackData>(
        `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash, t.updated_at,
                coalesce(s.play_count, 0)::int as play_count,
                coalesce(s.skip_count, 0)::int as skip_count,
                s.last_played_at,
                case when f.track_id is not null then true else false end as is_favorite
         from active_tracks t
         left join user_track_stats s on s.track_id = t.id and s.user_id = $1
         left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
         where lower(t.language) = $2
           ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
         limit 100`,
        allowed ? [userId, lang.language.toLowerCase(), allowed] 
                : [userId, lang.language.toLowerCase()]
      );

      if (langR.rows.length >= 15) {
        const scored = langR.rows.map(t => ({ ...t, score: scoreTrack(t, scoringOpts) }));
        const diverse = diversify(scored, { maxPerArtist: 3, limit: 50 });
        await addBucket(
          `language_${lang.language.toLowerCase().replace(/\W/g, '_')}`,
          `More ${lang.language} Music`,
          diverse,
          `Because you love ${lang.language} music`
        );
      }
    }

    // ========================================================================
    // BUCKET: DAILY MIXES (up to 4)
    // ========================================================================

    // Group genres into families
    const familyScores = new Map<string, { label: string; score: number; genres: Set<string> }>();
    for (const g of topGenresR.rows) {
      const family = tokenToFamily.get(g.genre.toLowerCase());
      const key = family?.key || g.genre.toLowerCase();
      const label = family?.label || g.genre;
      
      const existing = familyScores.get(key);
      if (existing) {
        existing.score += g.plays;
        existing.genres.add(g.genre.toLowerCase());
      } else {
        familyScores.set(key, { label, score: g.plays, genres: new Set([g.genre.toLowerCase()]) });
      }
    }

    const rankedFamilies = [...familyScores.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 4);

    let mixNum = 1;
    for (const [, familyData] of rankedFamilies) {
      const genreList = [...familyData.genres];
      
      const mixR = await db().query<TrackData>(
        `select distinct on (t.id) 
                t.id, t.title, t.artist, t.album, t.art_path, t.art_hash, t.updated_at,
                coalesce(s.play_count, 0)::int as play_count,
                coalesce(s.skip_count, 0)::int as skip_count,
                s.last_played_at,
                case when f.track_id is not null then true else false end as is_favorite
         from active_tracks t join track_genres tg on tg.track_id = t.id
         left join user_track_stats s on s.track_id = t.id and s.user_id = $1
         left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
         where lower(tg.genre) = any($2) ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
         order by t.id
         limit 150`,
        allowed ? [userId, genreList, allowed] : [userId, genreList]
      );

      if (mixR.rows.length < 15) continue;

      const scored = mixR.rows.map(t => ({ ...t, score: scoreTrack(t, scoringOpts) }));
      const seed = dailySeed(userId, 'daily_mix', mixNum);
      const diverse = diversify(scored, { maxPerArtist: 3, maxPerAlbum: 3, limit: 50, seed });

      if (diverse.length >= 10) {
        await addBucket(
          `daily_mix_${mixNum}`,
          `Daily Mix ${mixNum}`,
          diverse,
          `${familyData.label} • Refreshed daily`
        );
        mixNum++;
      }
    }

    // ========================================================================
    // BUCKET: TEMPO-BASED (if we have BPM data)
    // ========================================================================

    const tempoStatsR = await db().query<{ avg_bpm: number; count: number }>(
      `select avg(t.bpm)::float as avg_bpm, count(*)::int as count
       from user_track_stats s join active_tracks t on t.id = s.track_id
       where s.user_id = $1 and t.bpm is not null and t.bpm > 0 and s.play_count > 0
         and s.last_played_at > now() - interval '30 days'`,
      [userId]
    );

    if (tempoStatsR.rows[0]?.count >= 10) {
      const targetBpm = tempoStatsR.rows[0].avg_bpm;
      const tolerance = 15;
      
      const tempoR = await db().query<TrackData>(
        `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash, t.bpm,
                coalesce(s.play_count, 0)::int as play_count, 0 as skip_count,
                s.last_played_at, false as is_favorite, null as updated_at
         from active_tracks t left join user_track_stats s on s.track_id = t.id and s.user_id = $1
         where t.bpm between $2 and $3 ${allowed ? `and t.library_id = any($4::bigint[])` : ''}
         order by abs(t.bpm - $5), coalesce(s.play_count, 0) desc limit 100`,
        allowed 
          ? [userId, targetBpm - tolerance, targetBpm + tolerance, allowed, targetBpm]
          : [userId, targetBpm - tolerance, targetBpm + tolerance, targetBpm]
      );

      if (tempoR.rows.length >= 10) {
        const { label, subtitle } = tempoLabel(targetBpm);
        const diverse = diversify(
          tempoR.rows.map(t => ({ ...t, score: 10 - Math.abs((t.bpm || targetBpm) - targetBpm) / 5 })),
          { maxPerArtist: 2, limit: 50, seed: dailySeed(userId, 'tempo') }
        );
        await addBucket('tempo_match', label, diverse, subtitle);
      }
    }

    // ========================================================================
    // BUCKET: NEW FROM ARTISTS YOU LOVE
    // ========================================================================

    if (topArtistsR.rows.length >= 3) {
      const artistNames = topArtistsR.rows.slice(0, 10).map(a => a.artist.toLowerCase());
      const newFromR = await db().query<TrackData>(
        `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash, t.updated_at,
                coalesce(s.play_count, 0)::int as play_count, 0 as skip_count,
                s.last_played_at, false as is_favorite
         from active_tracks t left join user_track_stats s on s.track_id = t.id and s.user_id = $1
         where lower(t.artist) = any($2) and (s.play_count is null or s.play_count < 2)
           and t.updated_at > now() - interval '90 days'
           ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
         order by t.updated_at desc limit 100`,
        allowed ? [userId, artistNames, allowed] : [userId, artistNames]
      );

      if (newFromR.rows.length >= 5) {
        const diverse = diversify(
          newFromR.rows.map(t => ({ ...t, score: 10 })),
          { maxPerArtist: 4, limit: 50 }
        );
        await addBucket('new_from_artists', 'New From Artists You Love', diverse, 'Fresh tracks from your favorites');
      }
    }

    // ========================================================================
    // BUCKET: DISCOVER WEEKLY
    // ========================================================================

    if (topGenresR.rows.length > 0) {
      const likedGenres = new Set(topGenresR.rows.slice(0, 10).map(g => g.genre.toLowerCase()));
      
      const discoverR = await db().query<TrackData & { genres: string[] }>(
        `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash, t.updated_at,
                0 as play_count, 0 as skip_count, null::timestamptz as last_played_at, false as is_favorite,
                array_agg(tg.genre) as genres
         from active_tracks t join track_genres tg on tg.track_id = t.id
         left join user_track_stats s on s.track_id = t.id and s.user_id = $1
         where (s.play_count is null or s.play_count = 0)
           ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
         group by t.id, t.title, t.artist, t.album, t.art_path, t.art_hash, t.updated_at limit 300`,
        allowed ? [userId, allowed] : [userId]
      );

      // Score by genre match
      const scored = discoverR.rows.map(t => {
        let genreScore = 0;
        for (const g of (t.genres || [])) {
          if (likedGenres.has(g.toLowerCase())) genreScore += 5;
        }
        const freshness = t.updated_at ? Math.max(0, 30 - (now - new Date(t.updated_at).getTime()) / 86400000) : 0;
        return { ...t, score: genreScore + freshness * 0.3 };
      }).filter(t => t.score > 0);

      if (scored.length >= 10) {
        const diverse = diversify(scored, { maxPerArtist: 2, limit: 50, seed: dailySeed(userId, 'discover') });
        await addBucket('discover_weekly', 'Discover Weekly', diverse, 'Fresh picks based on your taste');
      }
    }

    // ========================================================================
    // BUCKET: DEEP CUTS
    // ========================================================================

    if (topArtistsR.rows.length >= 3) {
      const topNames = topArtistsR.rows.slice(0, 5).map(a => a.artist.toLowerCase());
      const deepR = await db().query<TrackData>(
        `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                coalesce(s.play_count, 0)::int as play_count, 0 as skip_count,
                s.last_played_at, false as is_favorite, null as updated_at
         from active_tracks t left join user_track_stats s on s.track_id = t.id and s.user_id = $1
         where lower(t.artist) = any($2) and coalesce(s.play_count, 0) < 2
           ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
         order by random() limit 100`,
        allowed ? [userId, topNames, allowed] : [userId, topNames]
      );

      if (deepR.rows.length >= 8) {
        const diverse = diversify(
          deepR.rows.map(t => ({ ...t, score: 10 - t.play_count })),
          { maxPerArtist: 4, limit: 50 }
        );
        await addBucket('deep_cuts', 'Deep Cuts', diverse, 'Hidden gems from artists you love');
      }
    }

    // ========================================================================
    // BUCKET: TIME-BASED MOOD
    // ========================================================================

    const moodConfig = {
      morning: { name: 'Morning Coffee', subtitle: 'Easy listening to start your day', energies: ['low', 'medium'] },
      afternoon: { name: 'Afternoon Boost', subtitle: 'Keep the momentum going', energies: ['medium', 'high'] },
      evening: { name: 'Evening Vibes', subtitle: 'Wind down with these', energies: ['medium'] },
      night: { name: 'Late Night', subtitle: 'Quiet hours companion', energies: ['low'] }
    }[timeContext.period];

    const moodGenres: string[] = [];
    for (const fam of GENRE_FAMILIES) {
      if (moodConfig.energies.includes(fam.energy)) {
        moodGenres.push(...fam.tokens.slice(0, 5));
      }
    }

    if (moodGenres.length > 0) {
      const moodR = await db().query<TrackData>(
        `select distinct t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                coalesce(s.play_count, 0)::int as play_count, 0 as skip_count,
                s.last_played_at, false as is_favorite, null as updated_at
         from active_tracks t join track_genres tg on tg.track_id = t.id
         left join user_track_stats s on s.track_id = t.id and s.user_id = $1
         where lower(tg.genre) = any($2) and coalesce(s.play_count, 0) > 0
           ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
         limit 150`,
        allowed ? [userId, moodGenres.slice(0, 30), allowed] : [userId, moodGenres.slice(0, 30)]
      );

      if (moodR.rows.length >= 10) {
        const diverse = diversify(
          moodR.rows.map(t => ({ ...t, score: t.play_count + Math.random() * 5 })),
          { maxPerArtist: 2, limit: 50, seed: dailySeed(userId, 'mood', timeContext.period) }
        );
        await addBucket(`mood_${timeContext.period}`, moodConfig.name, diverse, moodConfig.subtitle);
      }
    }

    // ========================================================================
    // BUCKET: RECENTLY ADDED
    // ========================================================================

    const recentlyAddedR = await db().query<TrackData & { birthtime_ms: number }>(
      `select distinct on (t.album) t.id, t.title, t.artist, t.album, t.art_path, t.art_hash, t.birthtime_ms,
              0 as play_count, 0 as skip_count, null as last_played_at, false as is_favorite
       from active_tracks t
       where t.art_path is not null and t.birthtime_ms is not null
         and t.birthtime_ms > (extract(epoch from (now() - interval '30 days')) * 1000)::bigint
         ${allowed ? `and t.library_id = any($1::bigint[])` : ''}
       order by t.album, t.birthtime_ms desc nulls last limit 50`,
      allowed ? [allowed] : []
    );

    // Re-sort by birthtime_ms after distinct
    const recentlyAddedSorted = recentlyAddedR.rows.sort((a: any, b: any) => 
      Number(b.birthtime_ms) - Number(a.birthtime_ms)
    ).slice(0, 25);

    if (recentlyAddedSorted.length >= 4) {
      await addBucket('recently_added', 'Recently Added', recentlyAddedSorted, 'New in your library');
    }

    // ========================================================================
    // BUCKET: JUMP BACK IN
    // ========================================================================

    const jumpBackR = await db().query<TrackData>(
      `select distinct on (t.album) t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
              0 as play_count, 0 as skip_count, ph.played_at as last_played_at,
              false as is_favorite, null::timestamptz as updated_at
       from play_history ph join active_tracks t on t.id = ph.track_id
       where ph.user_id = $1 and t.album is not null and ph.played_at > now() - interval '7 days'
         ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
       order by t.album, ph.played_at desc`,
      allowed ? [userId, allowed] : [userId]
    );

    if (jumpBackR.rows.length >= 4) {
      await addBucket('jump_back_in', 'Jump Back In', jumpBackR.rows.slice(0, 20), 'Continue where you left off');
    }

    // ========================================================================
    // RETURN
    // ========================================================================

    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      lastfmEnabled: isLastfmEnabled(),
      buckets
    };
  });
});
