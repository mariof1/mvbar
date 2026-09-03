export interface RecommendationTrackLike {
  id: number;
}

export interface RecommendationBucketLike {
  key: string;
  tracks: RecommendationTrackLike[];
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
};

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

  const isAllowed = (bucket: T, overlapLimit: number): boolean => {
    if (selectedKeys.has(bucket.key)) return false;
    const policy = policyFor(bucket.key);

    // Favorites and Recently Added already have first-class screens. They are
    // useful onboarding material, but become redundant once taste is learned.
    if (policy.utilityOnly && maturity !== 'new') return false;
    if ((roleCounts.get(policy.role) || 0) >= ROLE_CAPS[policy.role]) return false;
    if ((groupCounts.get(policy.group) || 0) >= (GROUP_CAPS[policy.group] ?? 1)) return false;
    return selected.every((existing) => overlapRatio(existing, bucket) <= overlapLimit);
  };

  const ranked = (pool: T[]): T[] => [...pool].sort((a, b) => {
    const aPolicy = policyFor(a.key);
    const bPolicy = policyFor(b.key);
    const aScore = aPolicy.priority + hashNoise(options.seed, a.key) * aPolicy.rotation;
    const bScore = bPolicy.priority + hashNoise(options.seed, b.key) * bPolicy.rotation;
    if (aScore !== bScore) return bScore - aScore;
    return a.key.localeCompare(b.key);
  });

  const add = (bucket: T) => {
    const policy = policyFor(bucket.key);
    selected.push(bucket);
    selectedKeys.add(bucket.key);
    roleCounts.set(policy.role, (roleCounts.get(policy.role) || 0) + 1);
    groupCounts.set(policy.group, (groupCounts.get(policy.group) || 0) + 1);
  };

  const addBestForRole = (role: BucketRole, overlapLimit = 0.5) => {
    const candidate = ranked(all.filter((bucket) => policyFor(bucket.key).role === role))
      .find((bucket) => isAllowed(bucket, overlapLimit));
    if (candidate) add(candidate);
  };

  // The first row has a predictable shape while the chosen bucket inside each
  // role can rotate as the user's recent behaviour changes.
  const coreRoles: BucketRole[] = maturity === 'new'
    ? ['personal', 'discovery', 'library', 'context']
    : ['personal', 'discovery', 'familiar', 'context'];
  for (const role of coreRoles) {
    if (selected.length >= limit) break;
    addBestForRole(role);
  }

  for (const bucket of ranked(all)) {
    if (selected.length >= limit) break;
    if (isAllowed(bucket, 0.5)) add(bucket);
  }

  // Small libraries often have unavoidable overlap. A relaxed second pass is
  // preferable to empty space, while role and concept caps still prevent a
  // wall of near-identical mixes.
  for (const bucket of ranked(all)) {
    if (selected.length >= limit) break;
    if (isAllowed(bucket, 0.75)) add(bucket);
  }

  return selected;
}
