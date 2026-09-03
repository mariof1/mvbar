export interface RecommendationTrackLike {
  id: number;
  artist?: string | null;
  album?: string | null;
}

export interface RecommendationBucketLike {
  key: string;
  tracks: RecommendationTrackLike[];
  count?: number;
}

export type RecommendationMaturity = 'new' | 'learning' | 'personalized';

type BucketRole = 'personal' | 'discovery' | 'familiar' | 'context' | 'library';

type BucketPolicy = {
  role: BucketRole;
  group: string;
  priority: number;
  rotation: number;
  utilityOnly?: boolean;
};

const EXACT_POLICIES: Record<string, BucketPolicy> = {
  made_for_you: { role: 'personal', group: 'personal', priority: 120, rotation: 0 },
  top_picks: { role: 'personal', group: 'personal', priority: 70, rotation: 0 },
  library_mix: { role: 'personal', group: 'personal', priority: 45, rotation: 2 },
  popular_library: { role: 'familiar', group: 'cold-start', priority: 110, rotation: 2 },

  discover_weekly: { role: 'discovery', group: 'discovery', priority: 112, rotation: 1 },
  listenbrainz_picks: { role: 'discovery', group: 'external-discovery', priority: 104, rotation: 4 },
  new_from_artists: { role: 'discovery', group: 'artist-discovery', priority: 98, rotation: 6 },
  deep_cuts: { role: 'discovery', group: 'artist-discovery', priority: 92, rotation: 8 },
  fresh_finds: { role: 'discovery', group: 'discovery', priority: 58, rotation: 8 },

  on_repeat: { role: 'familiar', group: 'familiar', priority: 104, rotation: 12 },
  rediscover: { role: 'familiar', group: 'familiar', priority: 100, rotation: 12 },
  jump_back_in: { role: 'familiar', group: 'familiar', priority: 96, rotation: 12 },
  favorites: { role: 'library', group: 'utility', priority: 42, rotation: 0, utilityOnly: true },

  search_suggestions: { role: 'context', group: 'recent-intent', priority: 76, rotation: 12 },
  tempo_match: { role: 'context', group: 'listening-context', priority: 72, rotation: 14 },
  recently_added: { role: 'library', group: 'utility', priority: 62, rotation: 2, utilityOnly: true },
};

const PREFIX_POLICIES: Array<[string, BucketPolicy]> = [
  ['similar_to_', { role: 'discovery', group: 'similar-artist', priority: 94, rotation: 10 }],
  ['because_', { role: 'context', group: 'because-album', priority: 91, rotation: 13 }],
  ['daily_mix_', { role: 'context', group: 'daily-mix', priority: 90, rotation: 14 }],
  ['genre_country_', { role: 'context', group: 'taste-slice', priority: 88, rotation: 16 }],
  ['language_', { role: 'context', group: 'taste-slice', priority: 86, rotation: 16 }],
  ['decade_', { role: 'context', group: 'taste-slice', priority: 84, rotation: 16 }],
  ['mood_', { role: 'context', group: 'listening-context', priority: 74, rotation: 16 }],
];

const ROLE_CAPS: Record<BucketRole, number> = {
  personal: 1,
  discovery: 2,
  familiar: 2,
  context: 2,
  library: 1,
};

const GROUP_CAPS: Record<string, number> = {
  personal: 1,
  familiar: 2,
  discovery: 1,
  'external-discovery': 1,
  'artist-discovery': 1,
  'similar-artist': 1,
  'recent-intent': 1,
  'because-album': 1,
  'daily-mix': 1,
  'taste-slice': 1,
  'listening-context': 1,
  utility: 1,
  'cold-start': 1,
};

const MAX_TRACKS_PER_BUCKET = 30;
const MAX_TRACKS_PER_ARTIST_ACROSS_SLATE = 6;
const MAX_TRACKS_PER_ALBUM_ACROSS_SLATE = 6;

function fallbackPolicy(): BucketPolicy {
  return { role: 'context', group: 'other', priority: 55, rotation: 18 };
}

function policyFor(key: string): BucketPolicy {
  const exact = EXACT_POLICIES[key];
  if (exact) return exact;
  return PREFIX_POLICIES.find(([prefix]) => key.startsWith(prefix))?.[1] ?? fallbackPolicy();
}

function hashNoise(seed: number, value: string): number {
  let hash = (seed ^ 0x811c9dc5) >>> 0;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d) >>> 0;
  hash ^= hash >>> 15;
  return (hash >>> 0) / 0xffffffff;
}

/**
 * Produce a client-safe key without collapsing non-Latin titles to the same
 * underscore-only slug. The short hash keeps differently-spelled albums
 * distinct even when their display names cannot be represented in the slug.
 */
export function stableRecommendationBucketKey(prefix: string, value: string): string {
  const safePrefix = prefix.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'mix';
  const slug = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/gi, 'l')
    .replace(/ø/gi, 'o')
    .replace(/ß/g, 'ss')
    .replace(/æ/gi, 'ae')
    .replace(/œ/gi, 'oe')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24) || 'mix';

  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${safePrefix}_${slug}_${hash.toString(16).padStart(8, '0')}`;
}

function overlapRatio(a: RecommendationBucketLike, b: RecommendationBucketLike): number {
  if (a.tracks.length === 0 || b.tracks.length === 0) return 0;
  const aIds = new Set(a.tracks.map((track) => track.id));
  let shared = 0;
  const bIds = new Set<number>();
  for (const track of b.tracks) {
    if (bIds.has(track.id)) continue;
    bIds.add(track.id);
    if (aIds.has(track.id)) shared++;
  }
  return shared / Math.min(aIds.size, bIds.size);
}

function normalizedArtists(value: string | null | undefined): string[] {
  if (!value) return [];
  return [...new Set(
    value
      .split(/\s*(?:;|\||•|\0|\uFEFF)\s*/)
      .map((artist) => artist.trim().replace(/\s+/g, ' ').toLocaleLowerCase())
      .filter(Boolean),
  )];
}

function normalizedAlbum(track: RecommendationTrackLike): string | null {
  const album = track.album?.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  if (!album) return null;
  return `${normalizedArtists(track.artist)[0] || 'unknown'}::${album}`;
}

function minimumTracksForBucket(key: string): number {
  if (key === 'on_repeat') return 4;
  if (key === 'new_from_artists') return 8;
  return 8;
}

function artistLimitForBucket(key: string): number {
  if (key === 'on_repeat') return 3;
  if (key === 'jump_back_in') return 6;
  if (key === 'deep_cuts') return 4;
  if (key === 'new_from_artists') return 2;
  if (key === 'fresh_finds' || key === 'recently_added') return 3;
  if (key.startsWith('daily_mix_') || key.startsWith('genre_country_') || key.startsWith('language_')) return 3;
  return 2;
}

function albumLimitForBucket(key: string): number {
  if (key === 'jump_back_in') return 3;
  if (key === 'recently_added' || key === 'fresh_finds') return 4;
  return 3;
}

export function recommendationMaturity(confidence: number): RecommendationMaturity {
  if (confidence < 0.2) return 'new';
  if (confidence < 0.55) return 'learning';
  return 'personalized';
}

export function recommendationBucketLimit(confidence: number): number {
  const maturity = recommendationMaturity(confidence);
  if (maturity === 'new') return 4;
  if (maturity === 'learning') return 5;
  return 6;
}

/** Blend a trusted pool with an exploration pool in a predictable 2:1 ratio. */
export function interleaveRecommendationTracks<T>(primary: T[], secondary: T[], limit: number): T[] {
  const result: T[] = [];
  let primaryIndex = 0;
  let secondaryIndex = 0;
  while (result.length < limit && (primaryIndex < primary.length || secondaryIndex < secondary.length)) {
    const preferSecondary = result.length % 3 === 2;
    const next = preferSecondary
      ? secondary[secondaryIndex++] ?? primary[primaryIndex++]
      : primary[primaryIndex++] ?? secondary[secondaryIndex++];
    if (next !== undefined) result.push(next);
  }
  return result;
}

/**
 * Turn all eligible bucket ideas into a small recommendation slate. The API
 * intentionally generates more ideas than it presents so weak or repetitive
 * buckets can be dropped without making the home screen sparse.
 */
export function curateRecommendationBuckets<T extends RecommendationBucketLike>(
  candidates: T[],
  options: { confidence: number; seed: number; maxBuckets?: number },
): T[] {
  const maturity = recommendationMaturity(options.confidence);
  const limit = Math.max(1, options.maxBuckets ?? recommendationBucketLimit(options.confidence));
  const unique = new Map<string, T>();
  for (const bucket of candidates) {
    if (!bucket.key || bucket.tracks.length < 4 || unique.has(bucket.key)) continue;
    unique.set(bucket.key, bucket);
  }

  const all = [...unique.values()];
  const selected: T[] = [];
  const selectedKeys = new Set<string>();
  const roleCounts = new Map<BucketRole, number>();
  const groupCounts = new Map<string, number>();
  const usedTrackIds = new Set<number>();
  const slateArtistCounts = new Map<string, number>();
  const slateAlbumCounts = new Map<string, number>();
  const hasBetterColdStart = unique.has('popular_library') && unique.has('recently_added');

  const isAllowed = (bucket: T): boolean => {
    if (selectedKeys.has(bucket.key)) return false;
    const policy = policyFor(bucket.key);

    // Favorites and Recently Added already have first-class screens. They are
    // useful onboarding material, but become redundant once taste is learned.
    if (policy.utilityOnly && maturity !== 'new') return false;
    if (maturity === 'new' && bucket.key === 'fresh_finds' && hasBetterColdStart) return false;
    if ((roleCounts.get(policy.role) || 0) >= ROLE_CAPS[policy.role]) return false;
    if ((groupCounts.get(policy.group) || 0) >= (GROUP_CAPS[policy.group] ?? 1)) return false;
    return true;
  };

  const ranked = (pool: T[]): T[] => [...pool].sort((a, b) => {
    const aPolicy = policyFor(a.key);
    const bPolicy = policyFor(b.key);
    const aScore = aPolicy.priority + hashNoise(options.seed, a.key) * aPolicy.rotation;
    const bScore = bPolicy.priority + hashNoise(options.seed, b.key) * bPolicy.rotation;
    if (aScore !== bScore) return bScore - aScore;
    return a.key.localeCompare(b.key);
  });

  const prepare = (bucket: T): T | null => {
    const artistCounts = new Map<string, number>();
    const albumCounts = new Map<string, number>();
    const artistLimit = artistLimitForBucket(bucket.key);
    const albumLimit = albumLimitForBucket(bucket.key);
    const tracks: RecommendationTrackLike[] = [];

    for (const track of bucket.tracks) {
      if (usedTrackIds.has(track.id)) continue;
      const artists = normalizedArtists(track.artist);
      const album = normalizedAlbum(track);
      if (artists.some((artist) => (artistCounts.get(artist) || 0) >= artistLimit)) continue;
      if (artists.some((artist) => (slateArtistCounts.get(artist) || 0) >= MAX_TRACKS_PER_ARTIST_ACROSS_SLATE)) continue;
      if (album && (albumCounts.get(album) || 0) >= albumLimit) continue;
      if (album && (slateAlbumCounts.get(album) || 0) >= MAX_TRACKS_PER_ALBUM_ACROSS_SLATE) continue;

      tracks.push(track);
      for (const artist of artists) artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
      if (album) albumCounts.set(album, (albumCounts.get(album) || 0) + 1);
      if (tracks.length >= MAX_TRACKS_PER_BUCKET) break;
    }

    if (tracks.length < minimumTracksForBucket(bucket.key)) return null;
    return { ...bucket, tracks, count: tracks.length } as T;
  };

  const add = (bucket: T, overlapLimit: number): boolean => {
    const prepared = prepare(bucket);
    if (!prepared) return false;
    if (!selected.every((existing) => overlapRatio(existing, prepared) <= overlapLimit)) return false;
    const policy = policyFor(bucket.key);
    selected.push(prepared);
    selectedKeys.add(bucket.key);
    roleCounts.set(policy.role, (roleCounts.get(policy.role) || 0) + 1);
    groupCounts.set(policy.group, (groupCounts.get(policy.group) || 0) + 1);
    for (const track of prepared.tracks) {
      usedTrackIds.add(track.id);
      for (const artist of normalizedArtists(track.artist)) {
        slateArtistCounts.set(artist, (slateArtistCounts.get(artist) || 0) + 1);
      }
      const album = normalizedAlbum(track);
      if (album) slateAlbumCounts.set(album, (slateAlbumCounts.get(album) || 0) + 1);
    }
    return true;
  };

  const addBestForRole = (role: BucketRole, overlapLimit = 0.5) => {
    for (const candidate of ranked(all.filter((bucket) => policyFor(bucket.key).role === role))) {
      if (isAllowed(candidate) && add(candidate, overlapLimit)) return;
    }
  };

  // The first row has a predictable shape while the chosen bucket inside each
  // role can rotate as the user's recent behaviour changes.
  const coreRoles: BucketRole[] = maturity === 'new'
    ? ['personal', 'familiar', 'library', 'discovery']
    : ['personal', 'discovery', 'familiar', 'context'];
  for (const role of coreRoles) {
    if (selected.length >= limit) break;
    addBestForRole(role);
  }

  for (const bucket of ranked(all)) {
    if (selected.length >= limit) break;
    if (isAllowed(bucket)) add(bucket, 0.5);
  }

  // Small libraries often have unavoidable overlap. A relaxed second pass is
  // preferable to empty space, while role and concept caps still prevent a
  // wall of near-identical mixes.
  for (const bucket of ranked(all)) {
    if (selected.length >= limit) break;
    if (isAllowed(bucket)) add(bucket, 0.75);
  }

  return selected;
}
