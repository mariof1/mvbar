import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import unzipper from 'unzipper';
import { publishStagedTrack, refreshStagedAlbumArchive, searchDeezerAlbums, searchDeezerTracks, stagedAlbumComplete, verifiedDeezerAlbum, verifiedDeezerTrack, validStagedFilename } from '../dist/pluginSystem/deezerStaging.js';

test('Deezer matching keeps the main recording and rejects alternate versions', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ data: [
      { id: 1, title: 'One More Time', title_short: 'One More Time', artist: { name: 'Daft Punk' }, album: { title: 'Discovery', cover_xl: 'https://cdn-images.dzcdn.net/images/cover/example/1000x1000.jpg' }, duration: 320, disk_number: 1, track_position: 8 },
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
    assert.equal(tracks[0].discNumber, 1);
    assert.equal(tracks[0].trackNumber, 8);
    assert.equal(tracks[0].cover, 'https://cdn-images.dzcdn.net/images/cover/example/1000x1000.jpg');
    assert.match(urls[0], /^https:\/\/api\.deezer\.com\/search\?/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('verified song artwork uses Deezer CDN and rejects lookalike hosts', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 42, title: 'One More Time', artist: { name: 'Daft Punk' },
    album: {
      title: 'Discovery',
      cover_xl: 'https://cdn-images.dzcdn.net.evil.test/images/cover/fake.jpg',
      cover_big: 'https://cdn-images.dzcdn.net/images/cover/real/500x500.jpg',
    },
  }), { status: 200 });
  try {
    const track = await verifiedDeezerTrack('42', 'Daft Punk', 'One More Time');
    assert.equal(track.cover, 'https://cdn-images.dzcdn.net/images/cover/real/500x500.jpg');
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
  assert.equal(validStagedFilename('Daft Punk/Discovery/01-08 One More Time.mp3'), true);
  assert.equal(validStagedFilename('Daft Punk/Discovery.zip'), true);
  assert.equal(validStagedFilename('../secrets.mp3'), false);
  assert.equal(validStagedFilename('Daft Punk/../secrets.mp3'), false);
  assert.equal(validStagedFilename('Daft Punk\\Discovery\\song.mp3'), false);
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
      cover_medium: 'https://cdn-images.dzcdn.net/images/cover/discovery/250x250.jpg',
      cover_xl: 'https://cdn-images.dzcdn.net/images/cover/discovery/1000x1000.jpg',
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
    assert.equal(album.cover, 'https://cdn-images.dzcdn.net/images/cover/discovery/250x250.jpg');
    assert.equal(album.artwork, 'https://cdn-images.dzcdn.net/images/cover/discovery/1000x1000.jpg');
    assert.equal(album.tracks.length, 101);
    assert.equal(album.tracks[100].discNumber, 2);
    assert.equal(album.tracks[100].trackNumber, 1);
    assert.ok(urls.some(url => url.includes('index=100')));
    await assert.rejects(verifiedDeezerAlbum('42', 'Other Artist', 'Discovery'), /does not match/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('album downloads are repackaged from edited staged files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mvbar-staged-'));
  const oldDirectory = process.env.DEEZER_DOWNLOAD_DIR;
  process.env.DEEZER_DOWNLOAD_DIR = directory;
  try {
    const album = path.join(directory, 'Artist', 'Album');
    await mkdir(album, { recursive: true });
    await writeFile(path.join(album, '01-01 Song.flac'), 'before');
    await refreshStagedAlbumArchive('Artist/Album.zip');
    await writeFile(path.join(album, '01-01 Song.flac'), 'after');
    await refreshStagedAlbumArchive('Artist/Album.zip');
    const archive = await unzipper.Open.file(path.join(directory, 'Artist', 'Album.zip'));
    assert.deepEqual(archive.files.map(file => file.path), ['Artist/Album/01-01 Song.flac']);
    assert.equal((await archive.files[0].buffer()).toString(), 'after');
    assert.equal((await readFile(path.join(album, '01-01 Song.flac'))).toString(), 'after');
  } finally {
    if (oldDirectory === undefined) delete process.env.DEEZER_DOWNLOAD_DIR;
    else process.env.DEEZER_DOWNLOAD_DIR = oldDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('staged albums reject missing tracks even when other audio files remain', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mvbar-staged-manifest-'));
  const oldDirectory = process.env.DEEZER_DOWNLOAD_DIR;
  process.env.DEEZER_DOWNLOAD_DIR = directory;
  try {
    const album = path.join(directory, 'Artist', 'Album');
    const expected = ['01-01 First.flac', '01-02 Second.flac'];
    await mkdir(album, { recursive: true });
    await writeFile(path.join(album, expected[0]), 'first');
    await writeFile(path.join(album, expected[1]), 'second');
    assert.equal(await stagedAlbumComplete('Artist/Album.zip', expected, 2), true);
    await refreshStagedAlbumArchive('Artist/Album.zip', expected, 2);
    await rm(path.join(album, expected[1]));
    await writeFile(path.join(album, '01-03 Extra.flac'), 'extra');
    assert.equal(await stagedAlbumComplete('Artist/Album.zip', expected, 2), false);
    await assert.rejects(refreshStagedAlbumArchive('Artist/Album.zip', expected, 2), /incomplete/);
    await writeFile(path.join(album, expected[1]), 'second again');
    await refreshStagedAlbumArchive('Artist/Album.zip', expected, 2);
    const archive = await unzipper.Open.file(path.join(directory, 'Artist', 'Album.zip'));
    assert.deepEqual(archive.files.map(file => file.path), expected.map(name => `Artist/Album/${name}`));
  } finally {
    if (oldDirectory === undefined) delete process.env.DEEZER_DOWNLOAD_DIR;
    else process.env.DEEZER_DOWNLOAD_DIR = oldDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('single-song staging uses disc-track filenames and preserves colliding tracks', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mvbar-track-'));
  try {
    const track = { id: '42', artist: 'Daft Punk', album: 'Discovery', title: 'One More Time', discNumber: 1, trackNumber: 8 };
    const firstSource = path.join(directory, 'first.mp3');
    const secondSource = path.join(directory, 'second.mp3');
    await writeFile(firstSource, 'first recording');
    await writeFile(secondSource, 'second recording');
    const first = await publishStagedTrack(directory, firstSource, track, 'mp3');
    const second = await publishStagedTrack(directory, secondSource, track, 'mp3');
    assert.equal(first, 'Daft Punk/Discovery/01-08 One More Time.mp3');
    assert.equal(second, 'Daft Punk/Discovery/01-08 One More Time [deezer-42].mp3');
    assert.equal((await readFile(path.join(directory, ...first.split('/')))).toString(), 'first recording');
    assert.equal((await readFile(path.join(directory, ...second.split('/')))).toString(), 'second recording');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
