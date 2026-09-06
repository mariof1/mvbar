import { redis } from './db.js';

const revisionKey = (userId: string) => `reco:revision:${userId}`;
const LIBRARY_REVISION_KEY = 'reco:library_revision';

/**
 * Recommendation responses include this revision in their cache key. Any
 * taste-changing action can therefore invalidate a user's slate without a
 * broad Redis key scan.
 */
export async function recommendationRevision(userId: string): Promise<string> {
  try {
    const [userRevision, libraryRevision] = await redis().mget(revisionKey(userId), LIBRARY_REVISION_KEY);
    return `${userRevision ?? '0'}:${libraryRevision ?? '0'}`;
  } catch {
    return '0';
  }
}

export async function invalidateRecommendationCache(userId: string): Promise<void> {
  try {
    await redis().incr(revisionKey(userId));
  } catch {
    // Recommendations already tolerate Redis being unavailable.
  }
}

export async function invalidateRecommendationCaches(userIds: Iterable<string>): Promise<void> {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0) return;
  try {
    const pipeline = redis().pipeline();
    for (const userId of unique) pipeline.incr(revisionKey(userId));
    await pipeline.exec();
  } catch {
    // Recommendations already tolerate Redis being unavailable.
  }
}
