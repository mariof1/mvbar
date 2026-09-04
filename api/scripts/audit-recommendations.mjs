#!/usr/bin/env node
import process from 'node:process';
import crypto from 'node:crypto';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const baseUrl = String(option('base-url', process.env.MVBAR_AUDIT_URL || 'http://127.0.0.1:8080')).replace(/\/+$/, '');
const email = option('email', process.env.MVBAR_AUDIT_EMAIL);
const password = option('password', process.env.MVBAR_AUDIT_PASSWORD);
const suppliedToken = option('token', process.env.MVBAR_AUDIT_TOKEN);
const runs = Math.max(1, Math.min(5, Number(option('runs', '3')) || 3));
const testMedia = !process.argv.includes('--no-media');

function normalizedArtists(value) {
  return [...new Set(String(value || '')
    .split(/\s*(?:;|\||•|\0|\uFEFF)\s*/)
    .map((artist) => artist.trim().replace(/\s+/g, ' ').toLocaleLowerCase())
    .filter(Boolean))];
}

function slateSignature(result) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(result.buckets.map((bucket) => [bucket.key, bucket.tracks.map((track) => track.id)])))
    .digest('hex')
    .slice(0, 16);
}

async function authenticate() {
  if (suppliedToken) return suppliedToken;
  if (!email || !password) {
    throw new Error('Set MVBAR_AUDIT_TOKEN, or MVBAR_AUDIT_EMAIL and MVBAR_AUDIT_PASSWORD.');
  }
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mvbar-client': 'recommendation-audit' },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();
  if (!response.ok || !body.token) throw new Error(`Authentication failed (${response.status}).`);
  return body.token;
}

async function getRecommendations(token) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/api/recommendations?refresh=1`, {
    headers: { authorization: `Bearer ${token}`, 'x-mvbar-client': 'recommendation-audit' },
  });
  const body = await response.json();
  if (!response.ok || !body.ok || !Array.isArray(body.buckets)) {
    throw new Error(`Recommendations failed (${response.status}): ${body.error || 'invalid response'}`);
  }
  return { body, elapsedMs: Math.round(performance.now() - started) };
}

function inspectSlate(result) {
  const failures = [];
  const allTracks = result.buckets.flatMap((bucket) => bucket.tracks);
  const ids = allTracks.map((track) => String(track.id));
  const maxBuckets = result.recommendationProfile === 'personalized'
    ? 6
    : result.recommendationProfile === 'learning'
      ? 5
      : 4;
  if (result.buckets.length > maxBuckets) failures.push(`bucket limit exceeded (${result.buckets.length}/${maxBuckets})`);
  if (new Set(ids).size !== ids.length) failures.push('duplicate tracks across slate');

  const slateArtists = new Map();
  const slateAlbums = new Map();
  for (const bucket of result.buckets) {
    if (bucket.tracks.length < 4 || bucket.tracks.length > 30) {
      failures.push(`${bucket.key} has invalid size ${bucket.tracks.length}`);
    }
    if (!Array.isArray(bucket.art_paths) || bucket.art_paths.length === 0 || bucket.art_paths.length > 4) {
      failures.push(`${bucket.key} has invalid artwork tile count`);
    }
    for (let index = 0; index < bucket.tracks.length; index++) {
      const track = bucket.tracks[index];
      const artists = normalizedArtists(track.artist);
      for (const artist of artists) slateArtists.set(artist, (slateArtists.get(artist) || 0) + 1);
      const album = String(track.album || '').trim().toLocaleLowerCase();
      if (album) {
        const key = `${artists[0] || 'unknown'}::${album}`;
        slateAlbums.set(key, (slateAlbums.get(key) || 0) + 1);
      }
      if (index > 0) {
        const previousArtists = new Set(normalizedArtists(bucket.tracks[index - 1].artist));
        if (artists.some((artist) => previousArtists.has(artist))) {
          failures.push(`${bucket.key} has adjacent tracks by ${artists.find((artist) => previousArtists.has(artist))}`);
        }
      }
    }
  }
  const maxArtist = Math.max(0, ...slateArtists.values());
  const maxAlbum = Math.max(0, ...slateAlbums.values());
  if (maxArtist > 6) failures.push(`slate artist cap exceeded (${maxArtist}/6)`);
  if (maxAlbum > 6) failures.push(`slate album cap exceeded (${maxAlbum}/6)`);

  return {
    failures,
    buckets: result.buckets.map((bucket) => `${bucket.key}:${bucket.tracks.length}`),
    tracks: allTracks.length,
    uniqueTracks: new Set(ids).size,
    maxArtist,
    maxAlbum,
  };
}

async function inspectMedia(token, result) {
  // Browser media proxies authenticate from the HttpOnly cookie because img
  // and audio elements cannot attach a bearer header themselves.
  const headers = {
    authorization: `Bearer ${token}`,
    cookie: `mvbar_token=${token}`,
    'x-mvbar-client': 'recommendation-audit',
  };
  const artPaths = [...new Set(result.buckets.flatMap((bucket) => bucket.art_paths || []))];
  const trackIds = [...new Set(result.buckets.flatMap((bucket) => bucket.tracks.map((track) => track.id)))].slice(0, 18);
  const artFailures = [];
  for (const path of artPaths) {
    const response = await fetch(`${baseUrl}/api/art/${encodeURIComponent(path)}`, { headers });
    const bytes = (await response.arrayBuffer()).byteLength;
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/') || bytes === 0) {
      artFailures.push({ path, status: response.status, bytes });
    }
  }
  const streamFailures = [];
  for (const trackId of trackIds) {
    const response = await fetch(`${baseUrl}/api/library/tracks/${trackId}/stream`, {
      headers: { ...headers, range: 'bytes=0-1023' },
    });
    const bytes = (await response.arrayBuffer()).byteLength;
    if (response.status !== 206 || bytes !== 1024) streamFailures.push({ trackId, status: response.status, bytes });
  }
  return {
    artwork: { tested: artPaths.length, failures: artFailures },
    streams: { tested: trackIds.length, failures: streamFailures },
  };
}

try {
  const token = await authenticate();
  const results = [];
  for (let run = 0; run < runs; run++) results.push(await getRecommendations(token));
  const inspection = inspectSlate(results[0].body);
  const signatures = results.map(({ body }) => slateSignature(body));
  if (new Set(signatures).size !== 1) inspection.failures.push('fresh runs were not deterministic');
  const media = testMedia ? await inspectMedia(token, results[0].body) : null;
  if (media?.artwork.failures.length) inspection.failures.push(`${media.artwork.failures.length} artwork requests failed`);
  if (media?.streams.failures.length) inspection.failures.push(`${media.streams.failures.length} stream requests failed`);

  const report = {
    ok: inspection.failures.length === 0,
    url: baseUrl,
    profile: results[0].body.recommendationProfile,
    slateId: results[0].body.slateId,
    timingsMs: results.map((result) => result.elapsedMs),
    signatures,
    ...inspection,
    media,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} catch (error) {
  console.error(`Recommendation audit failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
