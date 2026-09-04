import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import crypto from 'crypto';
import { db, redis } from './db.js';
import { allowedLibrariesForUser } from './access.js';
import { findSimilarLocalArtists, isLastfmEnabled } from './lastfm.js';
import { fetchRecommendations as fetchLBRecommendations, lookupRecording, getUserLBConfig } from './listenbrainz.js';
import { artistDisplay } from './artistDisplay.js';
import {
  normalizeRecommendationFeature as normalizeFeature,
  recommendationArtistKeys as artistKeys,
} from './recommendationFeatures.js';
import { recommendationRevision } from './recommendationCache.js';
import {
  curateRecommendationBuckets,
  interleaveRecommendationTracks,
  recommendationMaturity,
  stableRecommendationBucketKey,
} from './recommendationCuration.js';
import {
  recommendationSlateId,
  recordRecommendationImpressions,
} from './recommendationTelemetry.js';
import {
  GENRE_FAMILIES,
  tokenToFamily,
  tempoLabel,
  dailySeed,
  weeklySeed,
  seededShuffle,
  seededWeightedOrder,
  seededNoise,
  buildTasteProfile,
  scoreTrack,
  diversify,
  trackGenreList,
  type TrackData,
  type Bucket,
  type ScoringOptions,
} from './recommendationEngine.js';

// ============================================================================
// MAIN PLUGIN
// ============================================================================

export const recommendationsPlugin: FastifyPluginAsync = fp(async (app) => {
  const backgroundRefreshes = new Set<string>();
  const revalidationToken = crypto.randomUUID();

  app.get('/api/recommendations', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const userId = req.user.userId;
    const allowed = await allowedLibrariesForUser(userId, req.user.role);

    // ========================================================================
    // REDIS CACHE – keep the current slate stable, and serve the last good
    // slate immediately while an invalidated revision is rebuilt in-process.
    // ========================================================================
    const RECO_CACHE_TTL = 1800;
    const RECO_LAST_GOOD_TTL = 7 * 24 * 60 * 60;
    const allowedKey = allowed === null ? 'all' : (allowed.length > 0 ? [...allowed].sort((a, b) => a - b).join(',') : 'none');
    const revision = await recommendationRevision(userId);
    const cacheKey = `reco:v10:${userId}:${allowedKey}:${revision}`;
    const lastGoodKey = `reco:v10:last:${userId}:${allowedKey}`;
    const isBackgroundRevalidation = req.headers['x-mvbar-revalidate'] === revalidationToken;
    const query = req.query as { refresh?: string };
    const forceRefresh = req.user.role === 'admin' && query.refresh === '1';

    const observeSlate = async (result: { slateId?: string; buckets?: Bucket[] }) => {
      if (!result.slateId || !Array.isArray(result.buckets)) return;
      try {
        await recordRecommendationImpressions(userId, result.slateId, result.buckets);
      } catch (error) {
        app.log.warn({ err: error, userId }, 'Unable to record recommendation impressions');
      }
    };

    const scheduleBackgroundRefresh = () => {
      if (backgroundRefreshes.has(cacheKey)) return;
      const authorization = req.headers.authorization;
      const cookie = req.headers.cookie;
      if (!authorization && !cookie) return;
      backgroundRefreshes.add(cacheKey);
      setImmediate(() => {
        const headers: Record<string, string> = { 'x-mvbar-revalidate': revalidationToken };
        if (authorization) headers.authorization = authorization;
        if (cookie) headers.cookie = cookie;
        void app.inject({ method: 'GET', url: '/api/recommendations', headers })
          .then((response) => {
            if (response.statusCode >= 400) {
              app.log.warn({ userId, statusCode: response.statusCode }, 'Background recommendation refresh failed');
            }
          })
          .catch((error) => app.log.warn({ err: error, userId }, 'Background recommendation refresh failed'))
          .finally(() => backgroundRefreshes.delete(cacheKey));
      });
    };

    if (!forceRefresh) {
      try {
        const cached = await redis().get(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          parsed._cached = true;
          parsed._stale = false;
          await observeSlate(parsed);
          return parsed;
        }

        if (!isBackgroundRevalidation) {
          const lastGood = await redis().get(lastGoodKey);
          if (lastGood) {
            const parsed = JSON.parse(lastGood);
            parsed._cached = true;
            parsed._stale = true;
            parsed._refreshing = true;
            scheduleBackgroundRefresh();
            await observeSlate(parsed);
            return parsed;
          }
        }
      } catch (error) {
        app.log.debug({ err: error, userId }, 'Recommendation cache unavailable; computing a fresh slate');
      }
    }

    const now = Date.now();
    const buckets: Bucket[] = [];

    // ========================================================================
    // HELPER FUNCTIONS
    // ========================================================================

    async function getBucketArt(ids: number[]): Promise<{ art_paths: string[]; art_hashes: string[] }> {
      if (ids.length === 0) return { art_paths: [], art_hashes: [] };
      const r = await db().query<{ art_path: string | null; art_hash: string | null }>(
        `with ranked(id, ord) as (
           select id::bigint, ord
           from unnest($1::bigint[]) with ordinality as u(id, ord)
         ),
         album_art as (
           select distinct on (coalesce(nullif(t.album, ''), 'track:' || t.id::text))
                  t.art_path, t.art_hash, r.ord
           from ranked r
           join active_tracks t on t.id = r.id
           where t.art_path is not null and t.art_path != ''
           order by coalesce(nullif(t.album, ''), 'track:' || t.id::text), r.ord
         )
         select art_path, art_hash
         from album_art
         order by ord
         limit 4`,
        [ids]
      );
      const rows = r.rows.filter((row) => Boolean(row.art_path));
      return {
        art_paths: rows.map((row) => row.art_path as string),
        art_hashes: rows.map((row) => row.art_hash ?? '')
      };
    }

    function addBucket(key: string, name: string, tracks: TrackData[], subtitle?: string, reason?: string): boolean {
      if (buckets.some((bucket) => bucket.key === key)) return false;

      const seen = new Set<number>();
      const uniqueTracks = tracks.filter((track) => {
        if (
          !Number.isFinite(Number(track.id))
          || seen.has(track.id)
          || tasteProfile.blockedTrackIds.has(Number(track.id))
        ) return false;
        seen.add(track.id);
        return true;
      }).slice(0, 80);

      if (uniqueTracks.length < 4) return false;

      buckets.push({
        key, name, subtitle, reason: reason ?? subtitle,
        count: uniqueTracks.length,
        tracks: uniqueTracks.map(t => ({
          id: t.id,
          title: t.title || 'Untitled Track',
          artist: artistDisplay(t.artist),
          album: t.album ?? null,
          art_path: t.art_path ?? null,
          art_hash: t.art_hash ?? null,
          duration_ms: t.duration_ms ?? null,
        })),
        art_paths: [],
        art_hashes: [],
      });
      return true;
    }

    function currentBucketTrackIds(): Set<number> {
      return new Set(buckets.flatMap((bucket) => bucket.tracks.map((track) => track.id)));
    }

    async function loadCandidatePool(order: 'newest' | 'balanced'): Promise<TrackData[]> {
      const orderBy = order === 'newest'
        ? `coalesce(t.birthtime_ms, (extract(epoch from t.created_at) * 1000)::bigint) desc nulls last`
        : `coalesce(s.play_count, 0) asc,
           coalesce(s.last_played_at, 'epoch'::timestamptz) asc,
           coalesce(t.birthtime_ms, (extract(epoch from t.created_at) * 1000)::bigint) desc nulls last`;

      const r = await db().query<TrackData>(
        `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                t.genre, t.country, t.language, t.year, t.bpm, t.duration_ms, t.updated_at,
                coalesce(s.play_count, 0)::int as play_count,
                coalesce(s.skip_count, 0)::int as skip_count,
                s.last_played_at,
                case when f.track_id is not null then true else false end as is_favorite
         from active_tracks t
         left join user_track_stats s on s.track_id = t.id and s.user_id = $1
         left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
         where (t.duration_ms is null or t.duration_ms between 45000 and 1200000)
           ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
         order by ${orderBy}
         limit 700`,
        allowed ? [userId, allowed] : [userId]
      );
      return r.rows;
    }

    async function ensureFallbackBuckets() {
      const hasPersonal = buckets.some((bucket) =>
        bucket.key === 'made_for_you' || bucket.key === 'top_picks' || bucket.key === 'library_mix'
      );
      if (!hasPersonal) {
        const used = currentBucketTrackIds();
        const seed = dailySeed(userId, 'library_mix');
        const poolRows = (await loadCandidatePool('balanced')).filter((track) => !used.has(track.id));
        const scored = poolRows.map((track) => ({
          ...track,
          score:
            scoreTrack(track, { ...scoringOpts, purpose: 'mixed' }) +
            (track.is_favorite ? 5 : 0) +
            seededNoise(seed, track.id) * 14
        }));
        const diverse = diversify(scored, { maxPerArtist: 2, maxPerAlbum: 3, limit: 60, seed });
        addBucket('library_mix', 'Library Mix', diverse, 'A balanced shuffle from your library');
      }

      const hasDiscovery = buckets.some((bucket) =>
        bucket.key === 'discover_weekly' ||
        bucket.key === 'listenbrainz_picks' ||
        bucket.key === 'new_from_artists' ||
        bucket.key === 'deep_cuts' ||
        bucket.key.startsWith('similar_to_')
      );
      const hasColdStartPopular = buckets.some((bucket) => bucket.key === 'popular_library');
      if (!hasDiscovery && !hasColdStartPopular) {
        const used = currentBucketTrackIds();
        const seed = dailySeed(userId, 'fresh_finds');
        const freshRows = (await loadCandidatePool('newest')).filter((track) => !used.has(track.id));
        const scored = freshRows.map((track, idx) => ({
          ...track,
          score:
            scoreTrack(track, { ...scoringOpts, purpose: 'discovery' }) +
            Math.max(0, 28 - idx * 0.25) +
            seededNoise(seed, track.id) * 2
        }));
        const diverse = diversify(scored, { maxPerArtist: 3, maxPerAlbum: 4, limit: 60, seed });
        addBucket('fresh_finds', 'Fresh Finds', diverse, 'Recent and underplayed tracks');
      }
    }

    // ========================================================================
    // LOAD USER DATA
    // ========================================================================

    const [favR, recentR, tasteProfile] = await Promise.all([
      db().query<{ track_id: number }>(
        `select f.track_id
         from favorite_tracks f
         join active_tracks t on t.id = f.track_id
         where f.user_id = $1 ${allowed ? `and t.library_id = any($2::bigint[])` : ''}`,
        allowed ? [userId, allowed] : [userId]
      ),
      db().query<{ track_id: number }>(
        `select distinct ph.track_id
         from play_history ph
         join active_tracks t on t.id = ph.track_id
         where ph.user_id = $1 and ph.played_at > now() - interval '24 hours'
           ${allowed ? `and t.library_id = any($2::bigint[])` : ''}`,
        allowed ? [userId, allowed] : [userId]
      ),
      buildTasteProfile(userId, allowed, now),
    ]);
    const favoriteIds = new Set(favR.rows.map(r => r.track_id));
    const recentlyPlayedIds = new Set(recentR.rows.map(r => r.track_id));
    const recommendationProfile = recommendationMaturity(
      tasteProfile.confidence,
      tasteProfile.positiveSamples,
    );
    const canPersonalize = recommendationProfile !== 'new';

    const scoringOpts: ScoringOptions = { purpose: 'mixed', now, recentlyPlayedIds, favoriteIds };
    scoringOpts.tasteProfile = tasteProfile;

    // New listeners do not yet have enough private interaction data for a
    // personal mix. Give them one proven, aggregate library starting point;
    // no other user's identity or listening history is exposed.
    if (recommendationProfile === 'new') {
      const popularSeed = weeklySeed(userId, 'popular_library');
      const popularR = await db().query<TrackData & { global_score: number }>(
        `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                t.genre, t.country, t.language, t.year, t.bpm, t.duration_ms, t.updated_at,
                coalesce(us.play_count, 0)::int as play_count,
                coalesce(us.skip_count, 0)::int as skip_count,
                us.last_played_at,
                case when uf.track_id is not null then true else false end as is_favorite,
                (coalesce(gs.plays, 0) + coalesce(gf.favorites, 0) * 7 - coalesce(gs.skips, 0) * 2)::float as global_score
         from active_tracks t
         left join user_track_stats us on us.track_id = t.id and us.user_id = $1
         left join favorite_tracks uf on uf.track_id = t.id and uf.user_id = $1
         left join (
           select track_id, sum(play_count)::float as plays, sum(skip_count)::float as skips
           from user_track_stats
           group by track_id
         ) gs on gs.track_id = t.id
         left join (
           select track_id, count(*)::float as favorites
           from favorite_tracks
           group by track_id
         ) gf on gf.track_id = t.id
         where (coalesce(gs.plays, 0) > 0 or coalesce(gf.favorites, 0) > 0)
           and (t.duration_ms is null or t.duration_ms between 45000 and 1200000)
           ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
         order by global_score desc
         limit 500`,
        allowed ? [userId, allowed] : [userId]
      );
      const popular = diversify(
        popularR.rows.map((track) => ({
          ...track,
          score: Number(track.global_score) + seededNoise(popularSeed, track.id) * 4,
        })),
        { maxPerArtist: 2, maxPerAlbum: 3, limit: 60, seed: popularSeed, filterSkips: false }
      );
      if (popular.length >= 8) {
        addBucket('popular_library', 'Popular in Your Library', popular, 'A strong starting point while mvbar learns your taste');
      }
    }

    const [topArtistsR, topGenresR] = await Promise.all([
      db().query<{ artist: string; plays: number }>(
        `select a.name as artist,
                sum(s.play_count * case when ta.position = 0 then 1.0 else 0.5 end)::int as plays
         from user_track_stats s
         join active_tracks t on t.id = s.track_id
         join track_artists ta on ta.track_id = t.id and ta.role = 'artist'
         join artists a on a.id = ta.artist_id
         where s.user_id = $1 and s.play_count > 0
           ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
         group by a.id, a.name order by plays desc limit 20`,
        allowed ? [userId, allowed] : [userId]
      ),
      db().query<{ genre: string; plays: number }>(
        `select tg.genre, sum(s.play_count)::int as plays
         from user_track_stats s
         join active_tracks t on t.id = s.track_id
         join track_genres tg on tg.track_id = s.track_id
         where s.user_id = $1 and s.play_count > 0
           ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
         group by tg.genre order by plays desc limit 30`,
        allowed ? [userId, allowed] : [userId]
      ),
    ]);

    // Build liked genre families for affinity scoring
    const likedGenreFamilies = new Set<string>();
    for (const g of topGenresR.rows.slice(0, 15)) {
      const fam = tokenToFamily.get(g.genre.toLowerCase());
      if (fam) likedGenreFamilies.add(fam.key);
    }
    scoringOpts.likedGenreFamilies = likedGenreFamilies;

    // ========================================================================
    // BUCKET: MADE FOR YOU (strongest personalized taste match)
    // ========================================================================

    if (canPersonalize) {
      const seed = dailySeed(userId, 'made_for_you');
      const [familiarR, unplayedR] = await Promise.all([
        db().query<TrackData>(
        `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                t.genre, t.country, t.language, t.year, t.bpm, t.duration_ms, t.updated_at,
                coalesce(s.play_count, 0)::int as play_count,
                coalesce(s.skip_count, 0)::int as skip_count,
                s.last_played_at,
                case when f.track_id is not null then true else false end as is_favorite
         from active_tracks t
         left join user_track_stats s on s.track_id = t.id and s.user_id = $1
         left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
         where (coalesce(s.play_count, 0) > 0 or f.track_id is not null)
           and (s.last_played_at is null or s.last_played_at < now() - interval '18 hours')
           and (t.duration_ms is null or t.duration_ms between 45000 and 1200000)
           ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
         order by greatest(
                    coalesce(s.last_played_at, 'epoch'::timestamptz),
                    coalesce(f.added_at, 'epoch'::timestamptz)
                  ) desc
         limit 1500`,
        allowed ? [userId, allowed] : [userId]
        ),
        db().query<TrackData>(
          `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                  t.genre, t.country, t.language, t.year, t.bpm, t.duration_ms, t.updated_at,
                  0::int as play_count,
                  coalesce(s.skip_count, 0)::int as skip_count,
                  s.last_played_at,
                  false as is_favorite
           from active_tracks t
           left join user_track_stats s on s.track_id = t.id and s.user_id = $1
           left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
           where (s.track_id is null or s.play_count = 0)
             and f.track_id is null
             and (t.duration_ms is null or t.duration_ms between 45000 and 1200000)
             ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
           order by hashtextextended(t.id::text, $2::bigint)
           limit 1600`,
          allowed ? [userId, String(seed), allowed] : [userId, String(seed)]
        ),
      ]);

      const familiarScored = familiarR.rows
        .map(t => ({
          ...t,
          score:
            scoreTrack(t, scoringOpts) +
            seededNoise(seed, t.id) * 3
        }))
        .filter(t => (t.score || 0) > 4);
      const unplayedScored = unplayedR.rows
        .map(t => ({
          ...t,
          score:
            scoreTrack(t, { ...scoringOpts, purpose: 'discovery' }) +
            6 +
            seededNoise(seed + 1, t.id) * 3
        }))
        .filter(t => (t.score || 0) > 4);

      // Keep the anchor mix familiar enough to trust while reserving roughly
      // one in three positions for a relevant unplayed track. This also keeps
      // it meaningfully distinct from the all-unplayed Discover Weekly mix.
      const familiar = diversify(
        familiarScored,
        { maxPerArtist: 2, maxPerAlbum: 3, limit: 40, seed, rotationStrength: 6 },
      );
      const unplayed = diversify(
        unplayedScored,
        { maxPerArtist: 2, maxPerAlbum: 3, limit: 20, seed: seed + 1, rotationStrength: 7 },
      );
      // Do not label an all-discovery slate as "Made For You". Start with a
      // smaller but trustworthy 2:1 mix, then grow it to 30 as familiar tracks
      // clear the recent-play cooldown.
      if (familiar.length >= 6 && unplayed.length >= 3) {
        const blendLimit = Math.min(
          30,
          familiar.length + Math.min(unplayed.length, Math.floor(familiar.length / 2)),
        );
        const blended = interleaveRecommendationTracks(familiar, unplayed, blendLimit);
        await addBucket('made_for_you', 'Made For You', blended, 'Your taste, balanced with a few new discoveries');
      }
    }

    const [genreCountryR, decadesR, languagesR, topPicksR] = await Promise.all([
      db().query<{ genre: string; country: string; plays: number }>(
        `select tg.genre, t.country, sum(s.play_count)::int as plays
         from user_track_stats s
         join active_tracks t on t.id = s.track_id
         join track_genres tg on tg.track_id = t.id
         where s.user_id = $1 and s.play_count > 0 and t.country is not null and t.country != ''
           ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
         group by tg.genre, t.country
         having sum(s.play_count) >= 3
         order by plays desc limit 10`,
        allowed ? [userId, allowed] : [userId]
      ),
      db().query<{ decade: number; plays: number }>(
        `select (t.year / 10 * 10)::int as decade, sum(s.play_count)::int as plays
         from user_track_stats s join active_tracks t on t.id = s.track_id
         where s.user_id = $1 and s.play_count > 0 and t.year is not null and t.year >= 1950
           ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
         group by decade order by plays desc limit 5`,
        allowed ? [userId, allowed] : [userId]
      ),
      db().query<{ language: string; plays: number }>(
        `select t.language, sum(s.play_count)::int as plays
         from user_track_stats s join active_tracks t on t.id = s.track_id
         where s.user_id = $1 and s.play_count > 0 and t.language is not null and t.language != ''
           ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
         group by t.language order by plays desc limit 5`,
        allowed ? [userId, allowed] : [userId]
      ),
      db().query<TrackData>(
        `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                t.genre, t.country, t.language, t.year, t.bpm, t.duration_ms, t.updated_at,
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
      ),
    ]);

    // ========================================================================
    // BUCKET: TOP PICKS FOR YOU
    // ========================================================================

    if (topPicksR.rows.length > 0) {
      const scored = topPicksR.rows.map(t => ({ ...t, score: scoreTrack(t, scoringOpts) }));
      const diverse = diversify(scored, { limit: 50, seed: dailySeed(userId, 'top_picks') });
      await addBucket('top_picks', 'Top Picks For You', diverse, 'Personalized just for you');
    }

    // ========================================================================
    // BUCKET: LISTENBRAINZ RECOMMENDED
    // ========================================================================

    try {
      const lbConfig = await getUserLBConfig(userId);
      if (lbConfig?.username) {
        const lbMbids = await fetchLBRecommendations(lbConfig.username, 50);
        if (lbMbids.length > 0) {
          // Look up recordings in parallel (batched to avoid rate limits)
          const lbTracks: TrackData[] = [];
          const BATCH_SIZE = 5;
          for (let i = 0; i < lbMbids.length && lbTracks.length < 20; i += BATCH_SIZE) {
            const batch = lbMbids.slice(i, i + BATCH_SIZE);
            const infos = await Promise.all(batch.map(m => lookupRecording(m.recording_mbid)));
            for (let j = 0; j < infos.length; j++) {
              const info = infos[j];
              if (!info?.title || !info?.artist) continue;
              // Match against local library
              const match = await db().query<TrackData>(
                `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                        0 as play_count, 0 as skip_count, null as last_played_at,
                        false as is_favorite, null as updated_at
                 from active_tracks t
                 where lower(t.title) = lower($1)
                   and (lower(t.artist) like lower($2 || '%') or lower(t.album_artist) like lower($2 || '%'))
                   ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
                 limit 1`,
                allowed ? [info.title, info.artist, allowed] : [info.title, info.artist]
              );
              if (match.rows[0]) lbTracks.push(match.rows[0]);
            }
          }
          if (lbTracks.length >= 4) {
            // Deduplicate by track id
            const seen = new Set<number>();
            const unique = lbTracks.filter(t => { if (seen.has(t.id)) return false; seen.add(t.id); return true; });
            await addBucket('listenbrainz_picks', 'Recommended by ListenBrainz', unique, `Based on your listening profile`);
          }
        }
      }
    } catch {
      // LB unavailable — skip bucket silently
    }

    // ========================================================================
    // BUCKET: ON REPEAT
    // ========================================================================

    const onRepeatR = await db().query<TrackData>(
      `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
              count(*)::int as play_count,
              coalesce(s.skip_count, 0)::int as skip_count,
              max(ph.played_at) as last_played_at,
              false as is_favorite, null as updated_at
       from play_history ph
       join active_tracks t on t.id = ph.track_id
       left join user_track_stats s on s.track_id = t.id and s.user_id = $1
       where ph.user_id = $1 and ph.played_at > now() - interval '14 days'
         ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
       group by t.id, t.title, t.artist, t.album, t.art_path, t.art_hash, s.skip_count
       having count(*) >= 2
       order by play_count desc, last_played_at desc limit 100`,
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
    // BUCKET: BECAUSE YOU SEARCHED "X" (up to 5)
    // ========================================================================

    // Get recent searches with results (most recent first)
    const searchLogsR = await db().query<{ query: string; query_normalized: string }>(
      `select query, query_normalized
       from (
         select query, query_normalized, max(created_at) as latest
         from search_logs 
         where user_id = $1
           and created_at > now() - interval '30 days'
           and result_count >= 5 and length(query_normalized) >= 3
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

    const searchCombinedById = new Map<number, TrackData & { score: number }>();

    for (const [idx, search] of chosenSearches.entries()) {
      const term = search.query.trim();
      const termFold = normalizeFeature(term);
      const termLower = term.toLowerCase();
      let matchedTracks: TrackData[] = [];

      // Try year match
      if (/^\d{4}$/.test(term) && parseInt(term) >= 1900 && parseInt(term) <= 2100) {
        const year = parseInt(term);
        const yearR = await db().query<TrackData>(
          `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                  coalesce(s.play_count, 0)::int as play_count, coalesce(s.skip_count, 0)::int as skip_count,
                  s.last_played_at, false as is_favorite, null as updated_at
           from active_tracks t left join user_track_stats s on s.track_id = t.id and s.user_id = $1
           where t.year = $2 ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
           order by coalesce(s.play_count, 0) desc limit 50`,
          allowed ? [userId, year, allowed] : [userId, year]
        );
        matchedTracks = yearR.rows;
      }

      // Try genre match (partial)
      if (matchedTracks.length === 0) {
        const genreR = await db().query<TrackData>(
          `select *
           from (
             select distinct on (t.id)
                    t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                    coalesce(s.play_count, 0)::int as play_count, coalesce(s.skip_count, 0)::int as skip_count,
                    s.last_played_at, false as is_favorite, null as updated_at
             from active_tracks t join track_genres tg on tg.track_id = t.id
             left join user_track_stats s on s.track_id = t.id and s.user_id = $1
             where lower(tg.genre) like $2 ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
             order by t.id, coalesce(s.play_count, 0) desc
           ) matches
           order by play_count desc limit 50`,
          allowed ? [userId, `%${termLower}%`, allowed] : [userId, `%${termLower}%`]
        );
        matchedTracks = genreR.rows;
      }

      // Try country match
      if (matchedTracks.length === 0) {
        const countryR = await db().query<TrackData>(
          `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                  coalesce(s.play_count, 0)::int as play_count, coalesce(s.skip_count, 0)::int as skip_count,
                  s.last_played_at, false as is_favorite, null as updated_at
           from active_tracks t left join user_track_stats s on s.track_id = t.id and s.user_id = $1
           where lower(t.country) = $2 ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
           order by coalesce(s.play_count, 0) desc limit 50`,
          allowed ? [userId, termLower, allowed] : [userId, termLower]
        );
        matchedTracks = countryR.rows;
      }

      // Try artist match (with diacritics folding)
      if (matchedTracks.length === 0) {
        const artistR = await db().query<TrackData>(
          `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                  coalesce(s.play_count, 0)::int as play_count, coalesce(s.skip_count, 0)::int as skip_count,
                  s.last_played_at, false as is_favorite, null as updated_at
           from active_tracks t left join user_track_stats s on s.track_id = t.id and s.user_id = $1
           where (lower(t.artist) like $2 or lower(t.artist) like $3)
             ${allowed ? `and t.library_id = any($4::bigint[])` : ''}
           order by coalesce(s.play_count, 0) desc limit 50`,
          allowed ? [userId, `%${termLower}%`, `%${termFold}%`, allowed] : [userId, `%${termLower}%`, `%${termFold}%`]
        );
        matchedTracks = artistR.rows;
      }

      // Try album match
      if (matchedTracks.length === 0) {
        const albumR = await db().query<TrackData>(
          `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                  coalesce(s.play_count, 0)::int as play_count, coalesce(s.skip_count, 0)::int as skip_count,
                  s.last_played_at, false as is_favorite, null as updated_at
           from active_tracks t left join user_track_stats s on s.track_id = t.id and s.user_id = $1
           where lower(t.album) like $2 ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
           order by t.album, coalesce(s.play_count, 0) desc limit 50`,
          allowed ? [userId, `%${termLower}%`, allowed] : [userId, `%${termLower}%`]
        );
        matchedTracks = albumR.rows;
      }

      if (matchedTracks.length >= 5) {
        const recencyBoost = (chosenSearches.length - idx) * 2;
        for (const t of matchedTracks) {
          const base = t.play_count === 0 ? 12 : Math.max(1, 6 - Math.min(t.play_count, 5));
          const score = base + recencyBoost;
          const existing = searchCombinedById.get(t.id);
          if (!existing || score > existing.score) {
            searchCombinedById.set(t.id, { ...t, score });
          }
        }
      }
    }

    if (searchCombinedById.size >= 10) {
      const seed = dailySeed(userId, 'search_suggestions');
      const scored = [...searchCombinedById.values()].map(t => ({
        ...t,
        score: t.score + seededNoise(seed, t.id) * 2
      }));
      const diverse = diversify(scored, { maxPerArtist: 3, maxPerAlbum: 3, limit: 50, seed });
      await addBucket('search_suggestions', 'Tracks you might like', diverse, 'From your recent searches');
    }

    // ========================================================================
    // BUCKET: BECAUSE YOU LISTEN TO X (Last.fm similar artists)
    // ========================================================================

    if (isLastfmEnabled() && topArtistsR.rows.length >= 3) {
      // Rotate through top artists daily — pick 2-3 different artists each day
      const artistPool = topArtistsR.rows.slice(0, 8);
      const artistSeed = dailySeed(userId, 'similar_artists');
      const shuffledArtists = seededWeightedOrder(artistPool, artistSeed, (artist) => artist.plays);
      const artistsToUse = shuffledArtists.slice(0, 3);
      const similarOptions = await Promise.all(artistsToUse.map(async (topArtist) => ({
        topArtist,
        similarLocal: await findSimilarLocalArtists(topArtist.artist, 10),
      })));

      for (const { topArtist, similarLocal } of similarOptions) {
        if (similarLocal.length >= 2) {
          const similarNames = similarLocal.map(s => s.name.toLowerCase());
          const similarR = await db().query<TrackData>(
            `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                    coalesce(s.play_count, 0)::int as play_count, coalesce(s.skip_count, 0)::int as skip_count,
                    s.last_played_at, false as is_favorite, null as updated_at
             from active_tracks t left join user_track_stats s on s.track_id = t.id and s.user_id = $1
             where exists (
                     select 1
                     from track_artists ta
                     join artists a on a.id = ta.artist_id
                     where ta.track_id = t.id and ta.role = 'artist' and lower(a.name) = any($2::text[])
                   )
               ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
             order by coalesce(s.play_count, 0) desc limit 150`,
            allowed ? [userId, similarNames, allowed] : [userId, similarNames]
          );

          if (similarR.rows.length >= 10) {
            const scored = similarR.rows.map(t => ({
              ...t,
              score: t.play_count === 0 ? 20 : 10 - Math.min(t.play_count, 5)
            }));
            const diverse = diversify(scored, { maxPerArtist: 3, limit: 50, seed: dailySeed(userId, 'similar', topArtist.artist) });
            const added = await addBucket(
              stableRecommendationBucketKey('similar_to', topArtist.artist),
              `Similar to ${topArtist.artist}`,
              diverse,
              'Artists you might like'
            );
            if (added) break;
          }
        }
      }
    }

    // ========================================================================
    // BUCKET: GENRE + COUNTRY COMBOS (e.g., "Polish Hip-Hop")
    // ========================================================================

    const usedFamilyCountryCombos = new Set<string>();
    const rotatingGenreCountries = seededWeightedOrder(
      genreCountryR.rows.slice(0, 5),
      dailySeed(userId, 'genre_country_bucket'),
      (item) => item.plays,
    );
    for (const gc of rotatingGenreCountries) {
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
      const gcSeed = dailySeed(userId, 'genre_country', familyKey, gc.country);

      const gcR = await db().query<TrackData>(
        `select candidate.*
         from (
           select distinct on (t.id)
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
             and exists (
               select 1
               from track_artists candidate_artist
               where candidate_artist.track_id = t.id
                 and candidate_artist.role = 'artist'
                 and candidate_artist.artist_id in (
                   select supporting_artist.artist_id
                   from track_artists supporting_artist
                   join active_tracks supporting_track on supporting_track.id = supporting_artist.track_id
                   where supporting_artist.role = 'artist'
                     and lower(supporting_track.country) = $3
                   group by supporting_artist.artist_id
                   having count(distinct supporting_track.id) >= 2
                 )
             )
             ${allowed ? `and t.library_id = any($5::bigint[])` : ''}
           order by t.id
         ) candidate
         order by hashtextextended(candidate.id::text, $4::bigint)
         limit 200`,
        allowed
          ? [userId, familyGenres, gc.country.toLowerCase(), String(gcSeed), allowed]
          : [userId, familyGenres, gc.country.toLowerCase(), String(gcSeed)]
      );

      if (gcR.rows.length >= 10) {
        const scored = gcR.rows.map(t => ({ ...t, score: scoreTrack(t, scoringOpts) }));
        const diverse = diversify(scored, { maxPerArtist: 3, limit: 50, seed: gcSeed, rotationStrength: 7 });
        const added = await addBucket(
          stableRecommendationBucketKey('genre_country', `${familyKey}::${gc.country}`),
          `${gc.country} ${genreLabel}`,
          diverse,
          `A ${gc.country} ${genreLabel.toLowerCase()} vibe`
        );
        if (added) break;
      }
    }

    // ========================================================================
    // BUCKET: DECADE FAVORITES (e.g., "Your 90s Favorites")
    // ========================================================================

    const rotatingDecades = seededWeightedOrder(
      decadesR.rows.slice(0, 3),
      dailySeed(userId, 'decade_bucket'),
      (item) => item.plays,
    );
    for (const dec of rotatingDecades) {
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
        const added = await addBucket(
          `decade_${dec.decade}`,
          `Your ${decadeLabel} Mix`,
          diverse,
          `Throwback to the ${decadeLabel}`
        );
        if (added) break;
      }
    }

    // ========================================================================
    // BUCKET: LANGUAGE MIX (e.g., "More Polish Music")
    // ========================================================================

    const rotatingLanguages = seededWeightedOrder(
      languagesR.rows.slice(0, 3),
      dailySeed(userId, 'language_bucket'),
      (item) => item.plays,
    );
    for (const lang of rotatingLanguages) {
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
        const added = await addBucket(
          stableRecommendationBucketKey('language', lang.language),
          `More ${lang.language} Music`,
          diverse,
          `A bit more ${lang.language}`
        );
        if (added) break;
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

    const rotatingFamilies = seededWeightedOrder(
      rankedFamilies,
      dailySeed(userId, 'daily_mix_bucket'),
      ([, family]) => family.score,
    );
    for (const [familyKey, familyData] of rotatingFamilies) {
      const family = GENRE_FAMILIES.find((candidate) => candidate.key === familyKey);
      const genreList = family ? family.tokens : [...familyData.genres];
      
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
      const seed = dailySeed(userId, 'daily_mix', familyKey);
      const diverse = diversify(scored, { maxPerArtist: 3, maxPerAlbum: 3, limit: 50, seed });

      if (diverse.length >= 10) {
        const added = await addBucket(
          `daily_mix_${familyKey.replace(/\W/g, '_')}`,
          `${familyData.label} Mix`,
          diverse,
          'Familiar favourites and new finds • Refreshed daily'
        );
        if (added) break;
      }
    }

    // ========================================================================
    // BUCKET: TEMPO-BASED (if we have BPM data)
    // ========================================================================

    const tempoStatsR = await db().query<{ avg_bpm: number; count: number }>(
      `select avg(t.bpm)::float as avg_bpm, count(*)::int as count
       from user_track_stats s join active_tracks t on t.id = s.track_id
       where s.user_id = $1 and t.bpm is not null and t.bpm > 0 and s.play_count > 0
         and s.last_played_at > now() - interval '30 days'
         ${allowed ? `and t.library_id = any($2::bigint[])` : ''}`,
      allowed ? [userId, allowed] : [userId]
    );

    if (tempoStatsR.rows[0]?.count >= 10) {
      const targetBpm = tempoStatsR.rows[0].avg_bpm;
      const tolerance = 15;
      
      const tempoR = await db().query<TrackData>(
        `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash, t.bpm,
                coalesce(s.play_count, 0)::int as play_count, coalesce(s.skip_count, 0)::int as skip_count,
                s.last_played_at, false as is_favorite, null as updated_at
         from active_tracks t left join user_track_stats s on s.track_id = t.id and s.user_id = $1
         where t.bpm between $2 and $3 ${allowed ? `and t.library_id = any($4::bigint[])` : ''}
         order by abs(t.bpm - ${allowed ? '$5' : '$4'}), coalesce(s.play_count, 0) desc limit 100`,
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
        `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                t.genre, t.country, t.language, t.year, t.bpm, t.duration_ms, t.updated_at,
                coalesce(s.play_count, 0)::int as play_count, coalesce(s.skip_count, 0)::int as skip_count,
                s.last_played_at, false as is_favorite
         from active_tracks t
         left join user_track_stats s on s.track_id = t.id and s.user_id = $1
         left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
         where exists (
                 select 1
                 from track_artists ta
                 join artists a on a.id = ta.artist_id
                 where ta.track_id = t.id and ta.role = 'artist' and lower(a.name) = any($2::text[])
               )
           and coalesce(s.play_count, 0) = 0
           and f.track_id is null
           and coalesce(t.birthtime_ms, extract(epoch from t.created_at) * 1000) > extract(epoch from (now() - interval '180 days')) * 1000
           and (t.duration_ms is null or t.duration_ms between 45000 and 1200000)
           ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
         order by coalesce(t.birthtime_ms, extract(epoch from t.created_at) * 1000) desc limit 150`,
        allowed ? [userId, artistNames, allowed] : [userId, artistNames]
      );

      if (newFromR.rows.length >= 8) {
        const newFromSeed = weeklySeed(userId, 'new_from_artists');
        const diverse = diversify(
          newFromR.rows.map((track, index) => ({
            ...track,
            score:
              scoreTrack(track, { ...scoringOpts, purpose: 'discovery' }) +
              Math.max(0, 12 - index * 0.08),
          })),
          { maxPerArtist: 2, maxPerAlbum: 3, limit: 60, seed: newFromSeed, rotationStrength: 5 }
        );
        if (diverse.length >= 8) {
          addBucket('new_from_artists', 'New in Your Library', diverse, 'Unplayed recent additions from artists you love');
        }
      }
    }

    // ========================================================================
    // BUCKET: DISCOVER WEEKLY
    // ========================================================================

    if (canPersonalize) {
      const likedGenres = new Set(topGenresR.rows.slice(0, 15).map(g => normalizeFeature(g.genre)));
      const topArtistNames = new Set(topArtistsR.rows.slice(0, 15).map(a => normalizeFeature(a.artist)));

      // Use genre family matching for broader coverage, plus artist affinity
      const likedFamilyKeys = new Set<string>();
      for (const g of topGenresR.rows.slice(0, 15)) {
        const fam = tokenToFamily.get(normalizeFeature(g.genre));
        if (fam) likedFamilyKeys.add(fam.key);
      }
      const likedGenreTokens = new Set(likedGenres);
      for (const family of GENRE_FAMILIES) {
        if (!likedFamilyKeys.has(family.key)) continue;
        for (const token of family.tokens) likedGenreTokens.add(token);
      }
      const discoverSeed = weeklySeed(userId, 'discover');

      const discoverSelect = `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                                      t.genre, t.country, t.language, t.year, t.bpm, t.duration_ms, t.updated_at,
                                      0::int as play_count,
                                      coalesce(s.skip_count, 0)::int as skip_count,
                                      s.last_played_at,
                                      false as is_favorite
                               from active_tracks t
                               left join user_track_stats s on s.track_id = t.id and s.user_id = $1
                               left join favorite_tracks f on f.track_id = t.id and f.user_id = $1`;
      const genreOverlap = `exists (
        select 1
        from track_genres discover_genre
        where discover_genre.track_id = t.id
          and lower(discover_genre.genre) = any($2::text[])
      )`;
      const discoverParams: unknown[] = [userId, [...likedGenreTokens], String(discoverSeed)];
      if (allowed) discoverParams.push(allowed);

      // Fetch taste-adjacent and exploratory candidates independently. The old
      // grouped query could spend almost a second aggregating every genre and,
      // when a common genre filled the limit, leave no genuinely adventurous
      // tracks for the promised one-third exploration share.
      const [anchoredR, adventurousR] = await Promise.all([
        db().query<TrackData>(
          `${discoverSelect}
           where (s.track_id is null or s.play_count = 0)
             and f.track_id is null
             and (${genreOverlap})
             and (t.duration_ms is null or t.duration_ms between 45000 and 1200000)
             ${allowed ? `and t.library_id = any($4::bigint[])` : ''}
           order by hashtextextended(t.id::text, $3::bigint)
           limit 1600`,
          discoverParams,
        ),
        db().query<TrackData>(
          `${discoverSelect}
           where (s.track_id is null or s.play_count = 0)
             and f.track_id is null
             and not (${genreOverlap})
             and (t.duration_ms is null or t.duration_ms between 45000 and 1200000)
             ${allowed ? `and t.library_id = any($4::bigint[])` : ''}
           order by hashtextextended(t.id::text, ($3::bigint + 1))
           limit 800`,
          discoverParams,
        ),
      ]);
      const discoverRows = [...anchoredR.rows, ...adventurousR.rows];

      // Keep two-thirds of the weekly mix near established tastes and reserve
      // the remainder for genuinely new artists/genres. The source pool is
      // deterministic for the week and includes older and untagged tracks.
      const scored = discoverRows.map(t => {
        let genreScore = 0;
        let genreAnchor = false;
        for (const g of trackGenreList(t)) {
          const gl = normalizeFeature(g);
          if (likedGenres.has(gl)) {
            genreScore += 5;
            genreAnchor = true;
          } else {
            const fam = tokenToFamily.get(gl);
            if (fam && likedFamilyKeys.has(fam.key)) {
              genreScore += 2;
              genreAnchor = true;
            }
          }
        }
        const artistAnchor = artistKeys(t.artist).some((artist) => topArtistNames.has(artist));
        const freshnessDays = t.updated_at ? (now - new Date(t.updated_at).getTime()) / 86400000 : 365;
        const freshness = Math.max(0, 1 - freshnessDays / 180) * 3;
        return {
          ...t,
          score:
            scoreTrack(t, { ...scoringOpts, purpose: 'discovery' }) +
            genreScore +
            freshness +
            (artistAnchor ? 3 : 0),
          taste_anchor: genreAnchor || artistAnchor,
        };
      }).filter(t => t.score > 0);

      if (scored.length >= 10) {
        const anchored = diversify(
          scored.filter((track) => track.taste_anchor),
          { maxPerArtist: 2, maxPerAlbum: 3, limit: 40, seed: discoverSeed, rotationStrength: 8 }
        );
        const adventurous = diversify(
          scored.filter((track) => !track.taste_anchor),
          { maxPerArtist: 2, maxPerAlbum: 3, limit: 20, seed: discoverSeed + 1, rotationStrength: 10 }
        );
        const weekly = interleaveRecommendationTracks(anchored, adventurous, 60);
        addBucket('discover_weekly', 'Discover Weekly', weekly, 'Unplayed picks based on your taste • Updates Monday');
      }
    }

    // ========================================================================
    // BUCKET: DEEP CUTS
    // ========================================================================

    if (topArtistsR.rows.length >= 3) {
      const topNames = topArtistsR.rows.slice(0, 5).map(a => a.artist.toLowerCase());
      const deepR = await db().query<TrackData>(
        `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                coalesce(s.play_count, 0)::int as play_count, coalesce(s.skip_count, 0)::int as skip_count,
                s.last_played_at, false as is_favorite, null as updated_at
         from active_tracks t left join user_track_stats s on s.track_id = t.id and s.user_id = $1
         where exists (
                 select 1
                 from track_artists ta
                 join artists a on a.id = ta.artist_id
                 where ta.track_id = t.id and ta.role = 'artist' and lower(a.name) = any($2::text[])
               )
           and coalesce(s.play_count, 0) < 2
           ${allowed ? `and t.library_id = any($3::bigint[])` : ''}
         order by t.id limit 300`,
        allowed ? [userId, topNames, allowed] : [userId, topNames]
      );

      if (deepR.rows.length >= 8) {
        const seed = dailySeed(userId, 'deep_cuts');
        const shuffled = seededShuffle(deepR.rows, seed);
        const diverse = diversify(
          shuffled.map(t => ({ ...t, score: 10 - t.play_count })),
          { maxPerArtist: 4, limit: 50, seed }
        );
        await addBucket('deep_cuts', 'Deep Cuts', diverse, 'Hidden gems from artists you love');
      }
    }

    // ========================================================================
    // BUCKET: BECAUSE YOU LIKE [ALBUM]
    // ========================================================================

    {
      // Find albums the user has played heavily or favorited
      const lovedAlbumsR = await db().query<{ album: string; artist: string; genre: string | null; plays: number }>(
        `select t.album, t.artist, min(tg.genre) as genre, sum(s.play_count)::int as plays
         from user_track_stats s
         join active_tracks t on t.id = s.track_id
         left join track_genres tg on tg.track_id = t.id
         where s.user_id = $1 and t.album is not null and t.album != '' and s.play_count >= 2
           ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
         group by t.album, t.artist
         having count(*) >= 3
         order by plays desc limit 10`,
        allowed ? [userId, allowed] : [userId]
      );

      if (lovedAlbumsR.rows.length >= 2) {
        // Pick one album with daily rotation.
        const albumSeed = dailySeed(userId, 'because_album');
        const shuffled = seededWeightedOrder(lovedAlbumsR.rows, albumSeed, (album) => album.plays);

        for (const album of shuffled) {
          const becauseParams: unknown[] = [userId, album.album, album.artist];
          let candidateIdsSql = `select t.id
                                 from active_tracks t
                                 where lower(t.artist) = lower($3)`;

          if (album.genre) {
            becauseParams.push(album.genre);
            candidateIdsSql += `
              union
              select tg.track_id
              from track_genres tg
              where tg.genre = $${becauseParams.length}`;
          }

          if (allowed) {
            becauseParams.push(allowed);
          }

          const becauseR = await db().query<TrackData>(
            `with candidate_ids as (
               ${candidateIdsSql}
             )
             select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash, t.updated_at,
                    coalesce(s.play_count, 0)::int as play_count, coalesce(s.skip_count, 0)::int as skip_count,
                    s.last_played_at, false as is_favorite
             from candidate_ids candidate
             join active_tracks t on t.id = candidate.id
             left join user_track_stats s on s.track_id = t.id and s.user_id = $1
             where t.album is distinct from $2
               ${allowed ? `and t.library_id = any($${becauseParams.length}::bigint[])` : ''}
             order by coalesce(s.play_count, 0) desc,
                      hashtextextended(t.id::text, ${albumSeed}::bigint)
             limit 100`,
            becauseParams
          );

          if (becauseR.rows.length >= 8) {
            const scored = becauseR.rows.map(t => ({
              ...t,
              score: scoreTrack(t, { ...scoringOpts, purpose: 'discovery' }) +
                     (t.artist?.toLowerCase() === album.artist.toLowerCase() ? 10 : 0)
            }));
            const diverse = diversify(scored, { maxPerArtist: 2, limit: 30, seed: albumSeed });
            const added = await addBucket(
              stableRecommendationBucketKey('because', `${album.artist}::${album.album}`),
              `Because You Like "${album.album}"`,
              diverse,
              album.genre ? `Inspired by ${album.artist} and ${album.genre}` : `More from ${album.artist}`
            );
            if (added) break;
          }
        }
      }
    }

    // ========================================================================
    // BUCKET: RECENTLY ADDED
    // ========================================================================

    if (recommendationProfile === 'new') {
      const recentlyAddedR = await db().query<TrackData & { added_ms: number }>(
        `select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
                t.genre, t.country, t.language, t.year, t.bpm, t.duration_ms, t.updated_at,
                coalesce(t.birthtime_ms, (extract(epoch from t.created_at) * 1000)::bigint) as added_ms,
                coalesce(s.play_count, 0)::int as play_count,
                coalesce(s.skip_count, 0)::int as skip_count,
                s.last_played_at,
                case when f.track_id is not null then true else false end as is_favorite
         from active_tracks t
         left join user_track_stats s on s.track_id = t.id and s.user_id = $1
         left join favorite_tracks f on f.track_id = t.id and f.user_id = $1
         where (t.duration_ms is null or t.duration_ms between 45000 and 1200000)
           ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
         order by added_ms desc nulls last
         limit 160`,
        allowed ? [userId, allowed] : [userId]
      );

      const recentlyAddedSorted = diversify(
        recentlyAddedR.rows.map((t, idx) => ({
          ...t,
          score: Math.max(1, 40 - idx * 0.4) + (t.play_count === 0 ? 6 : 0)
        })),
        { maxPerArtist: 3, maxPerAlbum: 4, limit: 60, filterSkips: false }
      );

      if (recentlyAddedSorted.length >= 8) {
        await addBucket('recently_added', 'Recently Added', recentlyAddedSorted, 'A starting point while mvbar learns your taste');
      }
    }

    // ========================================================================
    // BUCKET: JUMP BACK IN
    // ========================================================================

    const jumpBackR = await db().query<TrackData & { total_in_album: number; played_in_album: number }>(
      `with recent_albums as (
        select distinct t.album, t.artist
        from play_history ph join active_tracks t on t.id = ph.track_id
        where ph.user_id = $1 and t.album is not null and t.album != ''
          and ph.played_at > now() - interval '14 days'
          ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
      ),
      album_progress as (
        select ra.album, ra.artist,
               count(distinct t.id) as total_in_album,
               count(distinct case when s.play_count > 0 then t.id end) as played_in_album
        from recent_albums ra
        join active_tracks t on t.album = ra.album and t.artist = ra.artist
          ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
        left join user_track_stats s on s.track_id = t.id and s.user_id = $1
        group by ra.album, ra.artist
        having count(distinct t.id) > count(distinct case when s.play_count > 0 then t.id end)
           and count(distinct t.id) >= 3
      )
      select t.id, t.title, t.artist, t.album, t.art_path, t.art_hash,
             0 as play_count, 0 as skip_count, null::timestamptz as last_played_at,
             false as is_favorite, null::timestamptz as updated_at,
             ap.total_in_album::int, ap.played_in_album::int
      from album_progress ap
      join active_tracks t on t.album = ap.album and t.artist = ap.artist
      left join user_track_stats s on s.track_id = t.id and s.user_id = $1
      where (s.play_count is null or s.play_count = 0)
        ${allowed ? `and t.library_id = any($2::bigint[])` : ''}
      order by ap.total_in_album - ap.played_in_album desc, t.track_number nulls last`,
      allowed ? [userId, allowed] : [userId]
    );

    if (jumpBackR.rows.length >= 3) {
      const diverse = diversify(
        jumpBackR.rows.map(t => ({ ...t, score: 10 })),
        { maxPerAlbum: 3, maxPerArtist: 6, limit: 20 }
      );
      await addBucket('jump_back_in', 'Jump Back In', diverse, 'Albums you haven\'t finished');
    }

    await ensureFallbackBuckets();

    // ========================================================================
    // RETURN
    // ========================================================================

    const curatedBuckets = curateRecommendationBuckets(
      buckets.filter((bucket) => !tasteProfile.hiddenBucketKeys.has(bucket.key)),
      {
      confidence: tasteProfile.confidence,
      positiveSamples: tasteProfile.positiveSamples,
      seed: dailySeed(userId, 'recommendation_slate'),
      },
    );
    const hydratedBuckets = await Promise.all(curatedBuckets.map(async (bucket) => ({
      ...bucket,
      count: bucket.tracks.length,
      ...await getBucketArt(bucket.tracks.map((track) => track.id)),
    })));

    const result = {
      ok: true,
      generatedAt: new Date().toISOString(),
      lastfmEnabled: isLastfmEnabled(),
      recommendationProfile,
      buckets: hydratedBuckets,
      slateId: recommendationSlateId(userId, hydratedBuckets),
    };

    // Cache the computed result
    try {
      const serialized = JSON.stringify(result);
      const pipeline = redis().pipeline();
      pipeline.set(cacheKey, serialized, 'EX', RECO_CACHE_TTL);
      pipeline.set(lastGoodKey, serialized, 'EX', RECO_LAST_GOOD_TTL);
      await pipeline.exec();
    } catch { /* Redis unavailable → skip caching */ }

    await observeSlate(result);

    return result;
  });
});
