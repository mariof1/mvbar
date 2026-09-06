import crypto from 'node:crypto';
import { db } from './db.js';
import { recommendationBucketPreferenceKey } from './recommendationTelemetry.js';
import {
  normalizeRecommendationFeature as normalizeFeature,
  recommendationArtistKeys as artistKeys,
  splitRecommendationFeatures as splitFeatureList,
} from './recommendationFeatures.js';

// ============================================================================
// GENRE TAXONOMY - Comprehensive genre families
// ============================================================================

export const GENRE_FAMILIES: { key: string; label: string; energy: 'low' | 'medium' | 'high'; tokens: string[] }[] = [
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
export const tokenToFamily = new Map<string, { key: string; label: string; energy: string }>();
for (const fam of GENRE_FAMILIES) {
  for (const t of fam.tokens) {
    tokenToFamily.set(t.toLowerCase().trim(), { key: fam.key, label: fam.label, energy: fam.energy });
  }
}

// Tempo labels
export function tempoLabel(bpm: number): { label: string; subtitle: string } {
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

export function dailySeed(...parts: (string | number)[]): number {
  const today = new Date().toISOString().split('T')[0];
  const hash = crypto.createHash('sha256').update(`${today}:${parts.join(':')}`).digest('hex');
  return parseInt(hash.slice(0, 12), 16);
}

export function weeklySeed(...parts: (string | number)[]): number {
  const now = new Date();
  const day = now.getUTCDay() || 7;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day + 1));
  const week = monday.toISOString().split('T')[0];
  const hash = crypto.createHash('sha256').update(`${week}:${parts.join(':')}`).digest('hex');
  return parseInt(hash.slice(0, 12), 16);
}

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export function seededShuffle<T>(arr: T[], seed: number): T[] {
  const result = [...arr];
  const rand = seededRandom(seed);
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function seededWeightedOrder<T>(arr: T[], seed: number, weight: (value: T) => number): T[] {
  const rand = seededRandom(seed);
  return arr
    .map((value) => ({
      value,
      // Weighted sampling without replacement: stronger tastes appear more
      // often, while smaller tastes still get a chance to rotate in.
      rank: -Math.log(Math.max(rand(), Number.EPSILON)) / Math.max(0.01, weight(value)),
    }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ value }) => value);
}

export function seededNoise(seed: number, n: number): number {
  // fast deterministic noise in [0, 1)
  let x = (seed ^ (n * 2654435761)) >>> 0;
  x = (x ^ (x >>> 16)) * 2246822507 >>> 0;
  x = (x ^ (x >>> 13)) * 3266489909 >>> 0;
  x = x ^ (x >>> 16);
  return (x >>> 0) / 0xffffffff;
}

// ============================================================================
// TYPES
// ============================================================================

export interface TrackData {
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
  duration_ms?: number | null;
  play_count: number;
  skip_count: number;
  last_played_at: Date | null;
  is_favorite: boolean;
  updated_at: Date | null;
  score?: number;
}

export interface Bucket {
  key: string;
  name: string;
  subtitle?: string;
  reason?: string;
  count: number;
  tracks: {
    id: number;
    title: string;
    artist: string;
    album: string | null;
    art_path: string | null;
    art_hash: string | null;
    duration_ms: number | null;
  }[];
  art_paths: string[];
  art_hashes: string[];
}

export interface TasteProfile {
  confidence: number;
  positiveSamples: number;
  artistWeights: Map<string, number>;
  albumWeights: Map<string, number>;
  genreWeights: Map<string, number>;
  familyWeights: Map<string, number>;
  countryWeights: Map<string, number>;
  languageWeights: Map<string, number>;
  decadeWeights: Map<string, number>;
  dislikedArtistWeights: Map<string, number>;
  dislikedGenreWeights: Map<string, number>;
  dislikedFamilyWeights: Map<string, number>;
  blockedTrackIds: Set<number>;
  boostedTrackIds: Set<number>;
  lessLikedArtists: Set<string>;
  hiddenBucketKeys: Set<string>;
  hiddenBucketCount: number;
  impressionPenalties: Map<number, number>;
  bpmMean: number | null;
  bpmStd: number | null;
}

interface TasteProfileRow {
  id: number;
  artist: string | null;
  album: string | null;
  genre: string | null;
  country: string | null;
  language: string | null;
  year: number | null;
  bpm: number | null;
  play_count: number;
  skip_count: number;
  last_played_at: Date | null;
  last_skipped_at: Date | null;
  is_favorite: boolean;
  playlist_count: number;
  recent_plays: number;
  total_listened_ms: number;
  completion_count: number;
  early_skip_count: number;
  explicit_preference: number;
}

interface RecommendationPreferenceRow {
  subject_type: 'track' | 'artist' | 'bucket';
  subject_key: string;
  preference: number;
}

interface RecommendationImpressionRow {
  track_id: number;
  slate_count: number;
  last_served_at: Date;
  engaged: boolean;
  skipped: boolean;
}

// ============================================================================
// SCORING ENGINE
// ============================================================================

export interface ScoringOptions {
  purpose: 'discovery' | 'familiar' | 'mixed' | 'rediscover';
  now: number;
  recentlyPlayedIds: Set<number>;
  favoriteIds: Set<number>;
  likedGenreFamilies?: Set<string>;  // genre families the user listens to
  tasteProfile?: TasteProfile;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function trackGenreList(track: TrackData): string[] {
  const aggregateGenres = (track as TrackData & { genres?: string[] }).genres;
  if (Array.isArray(aggregateGenres) && aggregateGenres.length > 0) {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const genre of aggregateGenres) {
      const normalized = normalizeFeature(genre);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
    }
    return result;
  }
  return splitFeatureList(track.genre);
}

function genreFamilyKeys(genres: string[]): string[] {
  const keys = new Set<string>();
  for (const genre of genres) {
    const fam = tokenToFamily.get(genre);
    if (fam) keys.add(fam.key);
  }
  return [...keys];
}

function decadeKey(year: number | null | undefined): string | null {
  if (!year || year < 1950 || year > 2100) return null;
  return String(Math.floor(year / 10) * 10);
}

function incrementWeight(map: Map<string, number>, key: string | null | undefined, amount: number) {
  if (!key || !Number.isFinite(amount) || amount <= 0) return;
  map.set(key, (map.get(key) || 0) + amount);
}

function normalizeWeights(map: Map<string, number>, maxScore: number) {
  let max = 0;
  for (const value of map.values()) max = Math.max(max, value);
  if (max <= 0) return;
  for (const [key, value] of map.entries()) {
    map.set(key, Math.log1p(value) / Math.log1p(max) * maxScore);
  }
}

function mapScore(map: Map<string, number>, key: string | null | undefined): number {
  if (!key) return 0;
  return map.get(key) || 0;
}

function interactionPositiveWeight(row: TasteProfileRow, now: number): number {
  const plays = Number(row.play_count || 0);
  const skips = Number(row.skip_count || 0);
  const playlistCount = Number(row.playlist_count || 0);
  const recentPlays = Number(row.recent_plays || 0);
  const attempts = Math.max(1, plays + skips);
  const skipRatio = skips / attempts;

  let weight = Math.log2(plays + 1) * 6;
  if (plays === 0 && row.total_listened_ms > 0) {
    // A partial listen is a weak signal, never equivalent to a completion.
    weight += Math.min(2, Number(row.total_listened_ms) / 240_000);
  }
  if (row.explicit_preference > 0) weight += row.explicit_preference * 12;
  weight += recentPlays * 1.4;
  if (row.is_favorite) weight += 18;
  if (playlistCount > 0) weight += Math.min(18, playlistCount * 7);

  if (row.last_played_at) {
    const daysSince = (now - new Date(row.last_played_at).getTime()) / 86400000;
    if (daysSince <= 7) weight *= 1.35;
    else if (daysSince <= 30) weight *= 1.18;
    else if (daysSince > 365) weight *= 0.82;
  }

  if (skips > 0) {
    weight -= Math.pow(skips, 1.2) * 3;
    if (skipRatio > 0.5) weight -= 10;
    if (skipRatio > 0.7) weight -= 15;
  }

  return Math.max(0, weight);
}

function interactionNegativeWeight(row: TasteProfileRow, now: number): number {
  const plays = Number(row.play_count || 0);
  // New clients distinguish genuine early exits from other skip-like events;
  // legacy rows fall back to the historical skip count.
  const skips = Number(row.early_skip_count || row.skip_count || 0);
  if (skips <= 0) return 0;

  const attempts = Math.max(1, plays + skips);
  const skipRatio = skips / attempts;
  let weight = Math.pow(skips, 1.15) * 2.5;
  if (skipRatio > 0.55) weight += 8;
  if (skipRatio > 0.75) weight += 12;
  weight -= Math.log2(plays + 1) * 3;

  if (row.last_skipped_at) {
    const daysSince = (now - new Date(row.last_skipped_at).getTime()) / 86400000;
    if (daysSince <= 14) weight *= 1.25;
    else if (daysSince > 180) weight *= 0.65;
  }

  if (row.is_favorite || row.playlist_count > 0) weight *= 0.35;
  return Math.max(0, weight);
}

function emptyTasteProfile(): TasteProfile {
  return {
    confidence: 0,
    positiveSamples: 0,
    artistWeights: new Map(),
    albumWeights: new Map(),
    genreWeights: new Map(),
    familyWeights: new Map(),
    countryWeights: new Map(),
    languageWeights: new Map(),
    decadeWeights: new Map(),
    dislikedArtistWeights: new Map(),
    dislikedGenreWeights: new Map(),
    dislikedFamilyWeights: new Map(),
    blockedTrackIds: new Set(),
    boostedTrackIds: new Set(),
    lessLikedArtists: new Set(),
    hiddenBucketKeys: new Set(),
    hiddenBucketCount: 0,
    impressionPenalties: new Map(),
    bpmMean: null,
    bpmStd: null,
  };
}

export async function buildTasteProfile(userId: string, allowed: number[] | null, now: number): Promise<TasteProfile> {
  const profile = emptyTasteProfile();
  const [rows, preferences, impressions] = await Promise.all([
    db().query<TasteProfileRow>(
    `select t.id, t.artist, t.album, t.genre, t.country, t.language, t.year, t.bpm,
            coalesce(s.play_count, 0)::int as play_count,
            coalesce(s.skip_count, 0)::int as skip_count,
            coalesce(s.total_listened_ms, 0)::bigint as total_listened_ms,
            coalesce(s.completion_count, 0)::int as completion_count,
            coalesce(s.early_skip_count, 0)::int as early_skip_count,
            coalesce(pref.preference, 0)::int as explicit_preference,
            s.last_played_at,
            s.last_skipped_at,
            case when f.track_id is not null then true else false end as is_favorite,
            coalesce(pc.playlist_count, 0)::int as playlist_count,
            coalesce(rp.recent_plays, 0)::int as recent_plays
     from active_tracks t
     left join user_track_stats s on s.track_id = t.id and s.user_id = $1
     left join recommendation_preferences pref
       on pref.user_id=$1 and pref.subject_type='track' and pref.subject_key=t.id::text
     left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
     left join (
       select pi.track_id, count(distinct pi.playlist_id)::int as playlist_count
       from playlist_items pi
       join playlists p on p.id = pi.playlist_id
       where p.user_id = $1 or pi.added_by = $1
       group by pi.track_id
     ) pc on pc.track_id = t.id
     left join (
       select track_id, count(*)::int as recent_plays
       from play_history
       where user_id = $1 and played_at > now() - interval '60 days'
       group by track_id
     ) rp on rp.track_id = t.id
     where (
       coalesce(s.play_count, 0) > 0
       or coalesce(s.skip_count, 0) > 0
       or coalesce(s.total_listened_ms, 0) > 0
       or f.track_id is not null
       or coalesce(pc.playlist_count, 0) > 0
       or coalesce(pref.preference, 0) > 0
     )
     ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
     order by greatest(
       coalesce(s.last_played_at, 'epoch'::timestamptz),
       coalesce(f.added_at, 'epoch'::timestamptz)
     ) desc
     limit 2500`,
    allowed ? [userId, allowed] : [userId]
    ),
    db().query<RecommendationPreferenceRow>(
      `select subject_type, subject_key, preference
         from recommendation_preferences
        where user_id=$1`,
      [userId],
    ),
    db().query<RecommendationImpressionRow>(
      `select track_id::bigint,
              count(distinct slate_id)::int as slate_count,
              max(served_at) as last_served_at,
              bool_or(played_at is not null or completed_at is not null) as engaged,
              bool_or(skipped_at is not null) as skipped
         from recommendation_impressions
        where user_id=$1 and served_at > now() - interval '30 days'
        group by track_id`,
      [userId],
    ),
  ]);

  for (const preference of preferences.rows) {
    if (preference.subject_type === 'track') {
      const trackId = Number(preference.subject_key);
      if (!Number.isSafeInteger(trackId) || trackId <= 0) continue;
      if (preference.preference < 0) profile.blockedTrackIds.add(trackId);
      if (preference.preference > 0) profile.boostedTrackIds.add(trackId);
    } else if (preference.subject_type === 'artist' && preference.preference < 0) {
      const artist = normalizeFeature(preference.subject_key);
      if (artist) profile.lessLikedArtists.add(artist);
    } else if (preference.subject_type === 'bucket' && preference.preference < 0) {
      const exactKey = preference.subject_key.trim().toLowerCase();
      if (!exactKey) continue;
      profile.hiddenBucketCount++;
      profile.hiddenBucketKeys.add(exactKey);
      profile.hiddenBucketKeys.add(recommendationBucketPreferenceKey(exactKey));
    }
  }

  for (const impression of impressions.rows) {
    if (impression.engaged) continue;
    const trackId = Number(impression.track_id);
    if (!Number.isSafeInteger(trackId)) continue;
    const daysSince = Math.max(0, (now - new Date(impression.last_served_at).getTime()) / 86400000);
    const recency = daysSince <= 2 ? 1 : daysSince <= 7 ? 0.65 : 0.3;
    const penalty = Math.min(14, Number(impression.slate_count) * (impression.skipped ? 4 : 1.75)) * recency;
    profile.impressionPenalties.set(trackId, penalty);
  }

  let totalPositive = 0;
  let bpmWeight = 0;
  let bpmWeightedSum = 0;
  let bpmWeightedSquares = 0;

  for (const row of rows.rows) {
    const positive = interactionPositiveWeight(row, now);
    const negative = interactionNegativeWeight(row, now);
    const artists = artistKeys(row.artist);
    const album = normalizeFeature(row.album);
    const genres = splitFeatureList(row.genre);
    const families = genreFamilyKeys(genres);
    const countries = splitFeatureList(row.country);
    const languages = splitFeatureList(row.language);
    const decade = decadeKey(row.year);

    if (positive > 0) {
      totalPositive += positive;
      profile.positiveSamples++;
      for (const [index, artist] of artists.entries()) {
        const creditWeight = index === 0 ? 1 : 0.5;
        incrementWeight(profile.artistWeights, artist, positive * 1.25 * creditWeight);
        incrementWeight(profile.albumWeights, album ? `${artist}::${album}` : null, positive * 0.5 * creditWeight);
      }
      incrementWeight(profile.decadeWeights, decade, positive * 0.45);
      for (const genre of genres) incrementWeight(profile.genreWeights, genre, positive * 1.05);
      for (const family of families) incrementWeight(profile.familyWeights, family, positive * 0.9);
      for (const country of countries) incrementWeight(profile.countryWeights, country, positive * 0.3);
      for (const language of languages) incrementWeight(profile.languageWeights, language, positive * 0.35);

      if (row.bpm && row.bpm > 0) {
        const weight = Math.min(positive, 35);
        bpmWeight += weight;
        bpmWeightedSum += row.bpm * weight;
        bpmWeightedSquares += row.bpm * row.bpm * weight;
      }
    }

    if (negative > 0) {
      for (const [index, artist] of artists.entries()) {
        incrementWeight(profile.dislikedArtistWeights, artist, negative * 0.8 * (index === 0 ? 1 : 0.5));
      }
      for (const genre of genres) incrementWeight(profile.dislikedGenreWeights, genre, negative * 0.75);
      for (const family of families) incrementWeight(profile.dislikedFamilyWeights, family, negative * 0.6);
    }
  }

  for (const artist of profile.lessLikedArtists) {
    incrementWeight(profile.dislikedArtistWeights, artist, 30);
  }

  normalizeWeights(profile.artistWeights, 16);
  normalizeWeights(profile.albumWeights, 5);
  normalizeWeights(profile.genreWeights, 12);
  normalizeWeights(profile.familyWeights, 10);
  normalizeWeights(profile.countryWeights, 3);
  normalizeWeights(profile.languageWeights, 4);
  normalizeWeights(profile.decadeWeights, 4);
  normalizeWeights(profile.dislikedArtistWeights, 12);
  normalizeWeights(profile.dislikedGenreWeights, 8);
  normalizeWeights(profile.dislikedFamilyWeights, 6);

  if (bpmWeight > 0) {
    profile.bpmMean = bpmWeightedSum / bpmWeight;
    const variance = Math.max(0, bpmWeightedSquares / bpmWeight - profile.bpmMean * profile.bpmMean);
    profile.bpmStd = Math.sqrt(variance);
  }

  const sampleConfidence = clamp(profile.positiveSamples / 30, 0, 1);
  const signalConfidence = clamp(Math.log1p(totalPositive) / Math.log1p(350), 0, 1);
  profile.confidence = clamp((sampleConfidence * 0.45) + (signalConfidence * 0.55), 0, 1);

  return profile;
}

function tasteScoreTrack(track: TrackData, profile: TasteProfile, purpose: ScoringOptions['purpose']): number {
  const artists = artistKeys(track.artist);
  if (profile.blockedTrackIds.has(track.id)) return -1000;
  let explicitScore = profile.boostedTrackIds.has(track.id) ? 24 : 0;
  if (artists.some((artist) => profile.lessLikedArtists.has(artist))) explicitScore -= 28;
  if (profile.confidence <= 0) return explicitScore;

  const album = normalizeFeature(track.album);
  const genres = trackGenreList(track);
  const families = genreFamilyKeys(genres);
  const countries = splitFeatureList(track.country);
  const languages = splitFeatureList(track.language);
  const decade = decadeKey(track.year);

  let score = explicitScore;
  const artistScores = artists.map((artist) => mapScore(profile.artistWeights, artist)).sort((a, b) => b - a);
  const albumScores = artists
    .map((artist) => mapScore(profile.albumWeights, album ? `${artist}::${album}` : null))
    .sort((a, b) => b - a);
  score += Math.min(20, (artistScores[0] || 0) + artistScores.slice(1).reduce((sum, value) => sum + value * 0.25, 0));
  score += Math.min(6, (albumScores[0] || 0) + albumScores.slice(1).reduce((sum, value) => sum + value * 0.25, 0));
  score += mapScore(profile.decadeWeights, decade);
  score += Math.min(16, genres.reduce((sum, genre) => sum + mapScore(profile.genreWeights, genre), 0));
  score += Math.min(12, families.reduce((sum, family) => sum + mapScore(profile.familyWeights, family), 0));
  score += Math.min(4, countries.reduce((sum, country) => sum + mapScore(profile.countryWeights, country), 0));
  score += Math.min(4, languages.reduce((sum, language) => sum + mapScore(profile.languageWeights, language), 0));

  score -= Math.min(14, artists.reduce((max, artist) => Math.max(max, mapScore(profile.dislikedArtistWeights, artist)), 0));
  score -= Math.min(10, genres.reduce((sum, genre) => sum + mapScore(profile.dislikedGenreWeights, genre), 0));
  score -= Math.min(8, families.reduce((sum, family) => sum + mapScore(profile.dislikedFamilyWeights, family), 0));

  if (profile.bpmMean && track.bpm && track.bpm > 0) {
    const tolerance = Math.max(12, profile.bpmStd || 18);
    const distance = Math.abs(track.bpm - profile.bpmMean);
    score += Math.max(0, 8 - (distance / tolerance) * 8);
    if (distance > tolerance * 2.2) score -= 3;
  }

  if (purpose === 'discovery' && track.play_count === 0) score += 5;
  if (purpose === 'discovery' && artistScores.some((value) => value > 12)) score -= 2;
  if (purpose === 'familiar' && track.is_favorite) score += 5;

  return clamp(score * (0.55 + profile.confidence * 0.45), -35, 65);
}

export function scoreTrack(track: TrackData, opts: ScoringOptions): number {
  let score = 0;
  const { purpose, now } = opts;

  // Extra recency guard (covers cases where last_played_at isn't present in the row)
  if (opts.recentlyPlayedIds.has(track.id)) score -= 30;
  
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

  // Genre affinity — bonus for tracks in user's preferred genre families
  if (opts.likedGenreFamilies && opts.likedGenreFamilies.size > 0) {
    const families = genreFamilyKeys(trackGenreList(track));
    if (families.some((family) => opts.likedGenreFamilies?.has(family))) {
      score += 6;
    }
  }

  if (opts.tasteProfile) {
    score += tasteScoreTrack(track, opts.tasteProfile, purpose);
    score -= opts.tasteProfile.impressionPenalties.get(track.id) || 0;
  }
  
  return Math.max(-60, Math.min(140, score));
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

export function diversify(
  tracks: TrackData[],
  opts: { maxPerArtist?: number; maxPerAlbum?: number; limit?: number; seed?: number; filterSkips?: boolean; rotationStrength?: number }
): TrackData[] {
  const { maxPerArtist = 2, maxPerAlbum = 3, limit = 25, seed, filterSkips = true, rotationStrength = 4 } = opts;
  
  // Filter out heavily skipped tracks
  const filtered = filterSkips ? filterHighSkipRatio(tracks) : tracks;
  const sorted = [...filtered].sort((a, b) => {
    const aScore = (a.score || 0) + (seed === undefined ? 0 : seededNoise(seed, a.id) * rotationStrength);
    const bScore = (b.score || 0) + (seed === undefined ? 0 : seededNoise(seed, b.id) * rotationStrength);
    return bScore - aScore;
  });
  
  const result: TrackData[] = [];
  const artistCount = new Map<string, number>();
  const albumCount = new Map<string, number>();
  
  for (const track of sorted) {
    const artists = artistKeys(track.artist);
    const albumName = normalizeFeature(track.album);
    const album = albumName ? `${artists[0] || 'unknown'}::${albumName}` : '';
    
    if (artists.some((artist) => (artistCount.get(artist) || 0) >= maxPerArtist)) continue;
    if (album && (albumCount.get(album) || 0) >= maxPerAlbum) continue;
    
    result.push(track);
    for (const artist of artists) artistCount.set(artist, (artistCount.get(artist) || 0) + 1);
    if (album) albumCount.set(album, (albumCount.get(album) || 0) + 1);
    
    if (result.length >= limit) break;
  }
  
  return result;
}
