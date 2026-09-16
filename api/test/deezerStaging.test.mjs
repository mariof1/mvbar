import assert from 'node:assert/strict';
import test from 'node:test';
import { searchDeezerAlbums, searchDeezerTracks, verifiedDeezerAlbum, verifiedDeezerTrack, validStagedFilename } from '../dist/pluginSystem/deezerStaging.js';

test('Deezer matching keeps the main recording and rejects alternate versions', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ data: [
      { id: 1, title: 'One More Time', title_short: 'One More Time', artist: { name: 'Daft Punk' }, album: { title: 'Discovery' }, duration: 320 },
      { id: 2, title: 'One More Time (Live)', title_short: 'One More Time', artist: { name: 'Daft Punk' }, album: { title: 'Live' } },
      { id: 3, title: 'One More Time', artist: { name: 'Other Artist' } },
      { id: 4, title: 'One More Time / Aerodynamic', artist: { name: 'Daft Punk' }, album: { title: 'Alive 2007' } },
    ] }), { status: 200 });
  };
  try {
    const tracks = await searchDeezerTracks('Daft Punk', 'One More Time', 'Discovery');
    assert.deepEqual(tracks.map(track => track.id), ['1']);
    assert.equal(tracks[0].album, 'Discovery');
    assert.equal(tracks[0].durationMs, 320_000);
    assert.equal(tracks[0].score, 110);
    assert.match(urls[0], /^https:\/\/api\.deezer\.com\/search\?/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Deezer download selection validates the current catalog item', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 42, title: 'Wrong song', artist: { name: 'Daft Punk' } }), { status: 200 });
  try {
    await assert.rejects(verifiedDeezerTrack('42', 'Daft Punk', 'One More Time'), /does not match/);
    await assert.rejects(verifiedDeezerTrack('../42', 'Daft Punk', 'One More Time'), /Invalid Deezer track id/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(validStagedFilename('Daft Punk - One More Time [deezer-42].mp3'), true);
  assert.equal(validStagedFilename('Daft Punk - Discovery [deezer-album-42].zip'), true);
  assert.equal(validStagedFilename('../secrets.mp3'), false);
});

test('Deezer album selection rejects other versions and validates every paginated track', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url.pathname + url.search);
    if (url.pathname === '/search/album') return new Response(JSON.stringify({ data: [
      { id: 42, title: 'Discovery', artist: { name: 'Daft Punk' }, record_type: 'album', nb_tracks: 101 },
      { id: 43, title: 'Discovery (Live)', artist: { name: 'Daft Punk' }, record_type: 'album', nb_tracks: 12 },
      { id: 44, title: 'Discovery', artist: { name: 'Data Punk' }, record_type: 'album', nb_tracks: 16 },
      { id: 45, title: 'Discovery', artist: { name: 'Daft Punk' }, record_type: 'single', nb_tracks: 1 },
      { id: 46, title: 'Discovery', artist: { name: 'Daft Punk Tribute' }, record_type: 'album', nb_tracks: 14 },
    ] }), { status: 200 });
    if (url.pathname === '/album/42') return new Response(JSON.stringify({
      id: 42, title: 'Discovery', artist: { name: 'Daft Punk' }, record_type: 'album', nb_tracks: 101,
      release_date: '2001-03-07',
    }), { status: 200 });
    if (url.pathname === '/album/42/tracks') {
      const start = Number(url.searchParams.get('index'));
      const count = start === 0 ? 100 : 1;
      return new Response(JSON.stringify({ total: 101, data: Array.from({ length: count }, (_, index) => ({
        id: start + index + 1000, title: `Track ${start + index + 1}`,
        artist: { name: 'Daft Punk' }, disk_number: start === 0 ? 1 : 2, track_position: index + 1,
      })) }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  try {
    const candidates = await searchDeezerAlbums('Daft Punk', 'Discovery');
    assert.deepEqual(candidates.map(album => album.id), ['42']);
    const album = await verifiedDeezerAlbum('42', 'Daft Punk', 'Discovery');
    assert.equal(album.tracks.length, 101);
    assert.equal(album.tracks[100].discNumber, 2);
    assert.equal(album.tracks[100].trackNumber, 1);
    assert.ok(urls.some(url => url.includes('index=100')));
    await assert.rejects(verifiedDeezerAlbum('42', 'Other Artist', 'Discovery'), /does not match/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
