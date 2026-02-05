import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { db } from './db.js';
import logger from './logger.js';

const LB_API = 'https://api.listenbrainz.org';

interface ListenBrainzConfig {
  token: string;
  username: string;
}

// Validate token with ListenBrainz
async function validateToken(token: string): Promise<{ valid: boolean; username?: string }> {
  try {
    const res = await fetch(`${LB_API}/1/validate-token`, {
      headers: { Authorization: `Token ${token}` },
    });
    const data = await res.json() as { valid: boolean; user_name?: string };
    return { valid: data.valid, username: data.user_name };
  } catch {
    return { valid: false };
  }
}

// Submit a listen to ListenBrainz
export async function submitListen(
  token: string,
  track: { title: string; artist: string; album?: string; duration_ms?: number },
  listenedAt: number
) {
  try {
    const payload = {
      listen_type: 'single',
      payload: [
        {
          listened_at: listenedAt,
          track_metadata: {
            artist_name: track.artist,
            track_name: track.title,
            release_name: track.album || undefined,
            additional_info: {
              media_player: 'mvbar',
              submission_client: 'mvbar',
              submission_client_version: '1.0',
              duration_ms: track.duration_ms,
            },
          },
        },
      ],
    };

    const res = await fetch(`${LB_API}/1/submit-listens`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    return res.ok;
  } catch {
    logger.error('listenbrainz', 'Submit error');
    return false;
  }
}

// Submit "now playing" to ListenBrainz
export async function submitNowPlaying(
  token: string,
  track: { title: string; artist: string; album?: string; duration_ms?: number }
) {
  try {
    const payload = {
      listen_type: 'playing_now',
      payload: [
        {
          track_metadata: {
            artist_name: track.artist,
            track_name: track.title,
            release_name: track.album || undefined,
            additional_info: {
              media_player: 'mvbar',
              submission_client: 'mvbar',
              submission_client_version: '1.0',
              duration_ms: track.duration_ms,
            },
          },
        },
      ],
    };

    const res = await fetch(`${LB_API}/1/submit-listens`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    return res.ok;
  } catch {
    logger.error('listenbrainz', 'Now playing error');
    return false;
  }
}

// Fetch recommendations from ListenBrainz
export async function fetchRecommendations(
  username: string,
  count = 25
): Promise<Array<{ recording_mbid: string; score: number }>> {
  try {
    const res = await fetch(
      `${LB_API}/1/cf/recommendation/user/${encodeURIComponent(username)}/recording?count=${count}`
    );
    if (!res.ok) return [];
    const data = await res.json() as { payload?: { mbids?: Array<{ recording_mbid: string; score: number }> } };
    return data.payload?.mbids ?? [];
  } catch {
    logger.error('listenbrainz', 'Recommendations error');
    return [];
  }
}

// Submit feedback (love/hate) to ListenBrainz
// score: 1 = love, -1 = hate, 0 = remove feedback
export async function submitFeedback(
  token: string,
  track: { title: string; artist: string },
  score: 1 | -1 | 0
): Promise<boolean> {
  try {
    // First, we need to look up the recording MBID from MusicBrainz
    const searchRes = await fetch(
      `https://musicbrainz.org/ws/2/recording/?query=recording:"${encodeURIComponent(track.title)}" AND artist:"${encodeURIComponent(track.artist)}"&limit=1&fmt=json`,
      { headers: { 'User-Agent': 'mvbar/1.0 (https://github.com/mvbar)' } }
    );
    
    if (!searchRes.ok) {
      logger.error('listenbrainz', 'MusicBrainz search failed');
      return false;
    }
    
    const searchData = await searchRes.json() as { recordings?: Array<{ id: string }> };
    const recordingMbid = searchData.recordings?.[0]?.id;
    
    if (!recordingMbid) {
      logger.debug('listenbrainz', `No MBID found for: ${track.title}`);
      return false;
    }

    // Now submit the feedback to ListenBrainz
    const payload = {
      recording_mbid: recordingMbid,
      score,
    };

    const res = await fetch(`${LB_API}/1/feedback/recording-feedback`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      logger.error('listenbrainz', 'Feedback submit failed');
      return false;
    }

    logger.success('listenbrainz', `Feedback: ${score === 1 ? 'love' : score === -1 ? 'hate' : 'remove'} - ${track.title}`);
    return true;
  } catch {
    logger.error('listenbrainz', 'Feedback error');
    return false;
  }
}

// Lookup recording info by MBID
export async function lookupRecording(mbid: string): Promise<{ title?: string; artist?: string } | null> {
  try {
    const res = await fetch(
      `https://musicbrainz.org/ws/2/recording/${mbid}?inc=artists&fmt=json`,
      { headers: { 'User-Agent': 'mvbar/1.0 (https://github.com/mariof1/mvbar)' } }
    );
    if (!res.ok) return null;
    const data = await res.json() as { title?: string; 'artist-credit'?: Array<{ name: string }> };
    return {
      title: data.title,
      artist: data['artist-credit']?.[0]?.name,
    };
  } catch {
    return null;
  }
}

// Get user's ListenBrainz config
async function getUserLBConfig(userId: string): Promise<ListenBrainzConfig | null> {
  const r = await db().query<{ listenbrainz_token: string | null; listenbrainz_username: string | null }>(
    'SELECT listenbrainz_token, listenbrainz_username FROM users WHERE id = $1',
    [userId]
  );
  if (!r.rows[0]?.listenbrainz_token) return null;
  return {
    token: r.rows[0].listenbrainz_token,
    username: r.rows[0].listenbrainz_username || '',
  };
}

export const listenbrainzPlugin: FastifyPluginAsync = fp(async (app) => {
  // Get user's ListenBrainz settings
  app.get('/api/listenbrainz/settings', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    const r = await db().query<{ listenbrainz_token: string | null; listenbrainz_username: string | null }>(
      'SELECT listenbrainz_token, listenbrainz_username FROM users WHERE id = $1',
      [req.user.userId]
    );
    
    return {
      ok: true,
      connected: !!r.rows[0]?.listenbrainz_token,
      username: r.rows[0]?.listenbrainz_username || null,
    };
  });

  // Save ListenBrainz token
  app.post('/api/listenbrainz/connect', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    const body = req.body as { token?: string };
    const token = (body.token ?? '').trim();
    
    if (!token) {
      return reply.code(400).send({ ok: false, error: 'Token required' });
    }

    // Validate token with ListenBrainz
    const validation = await validateToken(token);
    if (!validation.valid) {
      return reply.code(400).send({ ok: false, error: 'Invalid token' });
    }

    await db().query(
      'UPDATE users SET listenbrainz_token = $1, listenbrainz_username = $2 WHERE id = $3',
      [token, validation.username, req.user.userId]
    );

    return { ok: true, username: validation.username };
  });

  // Disconnect ListenBrainz
  app.post('/api/listenbrainz/disconnect', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    await db().query(
      'UPDATE users SET listenbrainz_token = NULL, listenbrainz_username = NULL WHERE id = $1',
      [req.user.userId]
    );

    return { ok: true };
  });

  // Get recommendations from ListenBrainz
  app.get('/api/listenbrainz/recommendations', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    const config = await getUserLBConfig(req.user.userId);
    if (!config) {
      return { ok: true, recommendations: [], connected: false };
    }

    const mbids = await fetchRecommendations(config.username, 20);
    
    // Try to match recommendations to local library
    const recommendations: Array<{
      mbid: string;
      title: string;
      artist: string;
      score: number;
      localTrack?: { id: number; title: string; artist: string; album: string | null };
    }> = [];

    for (const rec of mbids.slice(0, 20)) {
      // Look up recording info from MusicBrainz
      const info = await lookupRecording(rec.recording_mbid);
      if (!info?.title || !info?.artist) continue;

      // Try to find in local library
      const localMatch = await db().query<{ id: number; title: string; artist: string; album: string | null }>(
        `SELECT id, title, artist, album from active_tracks 
         WHERE LOWER(title) = LOWER($1) AND LOWER(artist) LIKE LOWER($2 || '%')
         LIMIT 1`,
        [info.title, info.artist]
      );

      recommendations.push({
        mbid: rec.recording_mbid,
        title: info.title,
        artist: info.artist,
        score: rec.score,
        localTrack: localMatch.rows[0] || undefined,
      });
    }

    return { ok: true, recommendations, connected: true, username: config.username };
  });

  // Scrobble endpoint (called when track finishes)
  app.post('/api/listenbrainz/scrobble', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    const body = req.body as { trackId?: number; listenedAt?: number };
    if (!body.trackId) return reply.code(400).send({ ok: false });

    const config = await getUserLBConfig(req.user.userId);
    if (!config) {
      return { ok: true, scrobbled: false, reason: 'not_connected' };
    }

    // Get track info
    const track = await db().query<{ title: string; artist: string; album: string | null; duration_ms: number | null }>(
      'SELECT title, artist, album, duration_ms from active_tracks WHERE id = $1',
      [body.trackId]
    );

    if (!track.rows[0]) {
      return reply.code(404).send({ ok: false });
    }

    const t = track.rows[0];
    const listenedAt = body.listenedAt ?? Math.floor(Date.now() / 1000);
    
    const success = await submitListen(config.token, {
      title: t.title,
      artist: t.artist,
      album: t.album ?? undefined,
      duration_ms: t.duration_ms ?? undefined,
    }, listenedAt);

    return { ok: true, scrobbled: success };
  });

  // Now playing endpoint
  app.post('/api/listenbrainz/now-playing', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    
    const body = req.body as { trackId?: number };
    if (!body.trackId) return reply.code(400).send({ ok: false });

    const config = await getUserLBConfig(req.user.userId);
    if (!config) {
      return { ok: true, submitted: false };
    }

    // Get track info
    const track = await db().query<{ title: string; artist: string; album: string | null; duration_ms: number | null }>(
      'SELECT title, artist, album, duration_ms from active_tracks WHERE id = $1',
      [body.trackId]
    );

    if (!track.rows[0]) {
      return reply.code(404).send({ ok: false });
    }

    const t = track.rows[0];
    const success = await submitNowPlaying(config.token, {
      title: t.title,
      artist: t.artist,
      album: t.album ?? undefined,
      duration_ms: t.duration_ms ?? undefined,
    });

    return { ok: true, submitted: success };
  });
});
