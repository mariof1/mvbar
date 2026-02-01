/**
 * User Preferences API
 */

import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { db } from './db.js';
import { findSimilarLocalTracks, findSimilarLocalArtists, isLastfmEnabled } from './lastfm.js';

interface UserPreferences {
  auto_continue: boolean;
  prefer_hls: boolean;
}

const DEFAULT_PREFS: UserPreferences = {
  auto_continue: false,
  prefer_hls: false,
};

export const preferencesPlugin: FastifyPluginAsync = fp(async (app) => {
  // Get user preferences
  app.get('/api/preferences', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const r = await db().query<UserPreferences>(
      'SELECT auto_continue, prefer_hls FROM user_preferences WHERE user_id = $1',
      [req.user.userId]
    );

    if (r.rows.length === 0) {
      return { ok: true, preferences: DEFAULT_PREFS };
    }

    return { ok: true, preferences: r.rows[0] };
  });

  // Update user preferences (upsert)
  app.patch('/api/preferences', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const body = req.body as Partial<UserPreferences>;
    
    // Get current preferences first
    const current = await db().query<UserPreferences>(
      'SELECT auto_continue, prefer_hls FROM user_preferences WHERE user_id = $1',
      [req.user.userId]
    );
    
    const existing = current.rows[0] || DEFAULT_PREFS;
    const newPrefs = {
      auto_continue: typeof body.auto_continue === 'boolean' ? body.auto_continue : existing.auto_continue,
      prefer_hls: typeof body.prefer_hls === 'boolean' ? body.prefer_hls : existing.prefer_hls,
    };

    await db().query(
      `INSERT INTO user_preferences (user_id, auto_continue, prefer_hls, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET 
         auto_continue = $2, prefer_hls = $3, updated_at = now()`,
      [req.user.userId, newPrefs.auto_continue, newPrefs.prefer_hls]
    );

    return { ok: true, preferences: newPrefs };
  });

  // Get similar tracks for auto-continue feature
  // Returns a larger batch (20 tracks) for continuous playback
  app.get('/api/similar-tracks/:trackId', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const trackId = Number((req.params as { trackId: string }).trackId);
    if (!Number.isFinite(trackId)) return reply.code(400).send({ ok: false, error: 'Invalid track ID' });

    // Get track info
    const trackR = await db().query<{ title: string; artist: string }>(
      'SELECT title, artist FROM tracks WHERE id = $1',
      [trackId]
    );
    
    if (trackR.rows.length === 0) {
      return reply.code(404).send({ ok: false, error: 'Track not found' });
    }

    const { title, artist } = trackR.rows[0];
    
    // Get queue track IDs to exclude (passed as query param)
    const excludeIds = ((req.query as any).exclude || '')
      .split(',')
      .map((s: string) => parseInt(s, 10))
      .filter((n: number) => Number.isFinite(n));

    const results: { id: number; title: string; artist: string; source: string }[] = [];
    const limit = 20; // Larger batch for continuous playback

    if (!isLastfmEnabled()) {
      return { ok: true, tracks: [], message: 'Last.fm not configured' };
    }

    // 1. Try Last.fm similar tracks first
    const similarTracks = await findSimilarLocalTracks(artist, title, excludeIds, limit);
    for (const t of similarTracks) {
      if (results.length >= limit) break;
      results.push({ id: t.id, title: t.title, artist: t.artist, source: 'similar_track' });
    }

    // 2. Fallback: Get tracks from similar artists
    if (results.length < limit) {
      const existingIds = [...excludeIds, ...results.map(r => r.id)];
      const similarArtists = await findSimilarLocalArtists(artist, 10);
      
      for (const simArtist of similarArtists) {
        if (results.length >= limit) break;
        
        // Get random tracks from this similar artist
        const artistTracks = await db().query<{ id: number; title: string; artist: string }>(
          `SELECT id, title, artist FROM active_tracks 
           WHERE lower(artist) = lower($1)
             AND id != ALL($2)
           ORDER BY random()
           LIMIT $3`,
          [simArtist.name, existingIds, Math.ceil((limit - results.length) / similarArtists.length) + 1]
        );
        
        for (const t of artistTracks.rows) {
          if (results.length >= limit) break;
          if (!existingIds.includes(t.id)) {
            results.push({ id: t.id, title: t.title, artist: t.artist, source: 'similar_artist' });
            existingIds.push(t.id);
          }
        }
      }
    }

    // Shuffle the results so tracks from different artists are mixed together
    for (let i = results.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [results[i], results[j]] = [results[j], results[i]];
    }

    return {
      ok: true,
      tracks: results.map(t => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
      })),
      sources: results.reduce((acc, t) => {
        acc[t.source] = (acc[t.source] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    };
  });
});
