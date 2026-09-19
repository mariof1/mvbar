import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import unzipper from 'unzipper';
import { assertDeezerStagingReady, cleanupLegacyStagedAlbumArchives, createStagedAlbumArchive, enrichDeezerTrackForImport, publishStagedTrack, resolveDeezerTrackTagMetadata, searchDeezerAlbums, searchDeezerTracks, stagedAlbumComplete, validStagedAlbumIdentifier, verifiedDeezerAlbum, verifiedDeezerTrack, validStagedFilename } from '../dist/pluginSystem/deezerStaging.js';

async function streamBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}


test('Deezer staging refuses to recreate a missing mount path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mvbar-staging-mount-'));
  const missing = path.join(root, 'missing-mount');
  const oldDirectory = process.env.DEEZER_DOWNLOAD_DIR;
  const oldArl = process.env.DEEZER_ARL;
  const oldMusicDir = process.env.MUSIC_DIR;
  process.env.DEEZER_DOWNLOAD_DIR = missing;
  process.env.DEEZER_ARL = 'test-arl';
  process.env.MUSIC_DIR = path.join(root, 'music');
  try {
    await assert.rejects(assertDeezerStagingReady(), /staging directory is unavailable/i);
    await assert.rejects(stat(missing), error => error?.code === 'ENOENT');
  } finally {
    if (oldDirectory === undefined) delete process.env.DEEZER_DOWNLOAD_DIR;
    else process.env.DEEZER_DOWNLOAD_DIR = oldDirectory;
    if (oldArl === undefined) delete process.env.DEEZER_ARL;
    else process.env.DEEZER_ARL = oldArl;
    if (oldMusicDir === undefined) delete process.env.MUSIC_DIR;
    else process.env.MUSIC_DIR = oldMusicDir;
    await rm(root, { recursive: true, force: true });
  }
});

test('Deezer staging rejects a filesystem alias of the main music library', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mvbar-staging-alias-'));
  const music = path.join(root, 'music');
  const alias = path.join(root, 'staging-alias');
  const oldDirectory = process.env.DEEZER_DOWNLOAD_DIR;
  const oldArl = process.env.DEEZER_ARL;
  const oldMusicDir = process.env.MUSIC_DIR;
  await mkdir(music);
  await symlink(music, alias, process.platform === 'win32' ? 'junction' : 'dir');
  process.env.DEEZER_DOWNLOAD_DIR = alias;
  process.env.DEEZER_ARL = 'test-arl';
  process.env.MUSIC_DIR = music;
  try {
    await assert.rejects(assertDeezerStagingReady(), /separate from MUSIC_DIRS/i);
  } finally {
    if (oldDirectory === undefined) delete process.env.DEEZER_DOWNLOAD_DIR;
    else process.env.DEEZER_DOWNLOAD_DIR = oldDirectory;
    if (oldArl === undefined) delete process.env.DEEZER_ARL;
    else process.env.DEEZER_ARL = oldArl;
    if (oldMusicDir === undefined) delete process.env.MUSIC_DIR;
    else process.env.MUSIC_DIR = oldMusicDir;
    await rm(root, { recursive: true, force: true });
  }
});

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
      { id: 5, title: 'One More Time', artist: { name: 'Daft Punk Tribute' }, album: { title: 'Discovery' } },
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

test('rich Deezer track import adds BPM, contributors and LRCLIB lyrics', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'api.deezer.com' && url.pathname === '/track/42') {
      return new Response(JSON.stringify({
        id: 42,
        title: 'One More Time',
        duration: 320,
        bpm: 123.6,
        gain: -7.25,
        artist: { id: 27, name: 'Daft Punk' },
        contributors: [
          { id: 27, name: 'Daft Punk', role: 'Main' },
          { id: 99, name: 'Romanthony', role: 'Featured' },
          { id: 100, name: 'daft punk', role: 'Duplicate' },
        ],
        album: { id: 1, title: 'Discovery' },
      }), { status: 200 });
    }
    if (url.hostname === 'lrclib.net') {
      return new Response(JSON.stringify({
        syncedLyrics: '[00:01.00]One more time\n[00:03.00]Music got me feeling so free',
      }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  try {
    const base = {
      id: '42',
      title: 'One More Time',
      artist: 'Daft Punk',
      album: 'Discovery',
      durationMs: 320000,
      isrc: null,
      link: null,
      score: 100,
      discNumber: 1,
      trackNumber: 8,
      cover: null,
      albumId: '1',
      artists: ['Daft Punk'],
      bpm: null,
      gainDb: null,
    };
    const track = await enrichDeezerTrackForImport(base, { fetchDetail: true, lyrics: true });
    assert.deepEqual(track.artists, ['Daft Punk', 'Romanthony']);
    assert.equal(track.bpm, 124);
    assert.equal(track.gainDb, -7.25);
    assert.equal(track.lyrics?.synced, true);
    assert.match(track.lyrics?.text ?? '', /One more time/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('verified song artwork uses Deezer CDN and rejects lookalike hosts', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 42, title: 'One More Time', bpm: 123.4, gain: -6.5,
    artist: { name: 'Daft Punk' },
    contributors: [{ name: 'Daft Punk' }, { name: 'Romanthony' }],
    album: {
      title: 'Discovery',
      cover_xl: 'https://cdn-images.dzcdn.net.evil.test/images/cover/fake.jpg',
      cover_big: 'https://cdn-images.dzcdn.net/images/cover/real/500x500.jpg',
    },
  }), { status: 200 });
  try {
    const track = await verifiedDeezerTrack('42', 'Daft Punk', 'One More Time');
    assert.equal(track.cover, 'https://cdn-images.dzcdn.net/images/cover/real/500x500.jpg');
    assert.equal(track.bpm, 123);
    assert.equal(track.gainDb, -6.5);
    assert.deepEqual(track.artists, ['Daft Punk', 'Romanthony']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Deezer download selection validates the current catalog item', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 42, title: 'Wrong song', artist: { id: 27, name: 'Daft Punk' }, album: { id: 1, title: 'Discovery' } }), { status: 200 });
  try {
    await assert.rejects(verifiedDeezerTrack('42', 'Daft Punk', 'One More Time'), /does not match/);
    await assert.rejects(verifiedDeezerTrack('../42', 'Daft Punk', 'One More Time'), /Invalid Deezer track id/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 42, title: 'One More Time',
    artist: { id: 99, name: 'Daft Punk Tribute' },
    album: { id: 2, title: 'Discovery Tribute' },
  }), { status: 200 });
  try {
    await assert.rejects(
      verifiedDeezerTrack('42', 'Daft Punk', 'One More Time', 'Discovery', '27', '1'),
      /does not match/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(validStagedFilename('Daft Punk - One More Time [deezer-42].mp3'), true);
  assert.equal(validStagedFilename('Daft Punk - Discovery [deezer-album-42].zip'), true);
  assert.equal(validStagedFilename('Daft Punk/Discovery/01-08 One More Time.mp3'), true);
  assert.equal(validStagedFilename('Daft Punk/Discovery.zip'), true);
  assert.equal(validStagedAlbumIdentifier('Daft Punk/Discovery'), true);
  assert.equal(validStagedAlbumIdentifier('Daft Punk/Discovery.zip'), true);
  assert.equal(validStagedAlbumIdentifier('Discovery'), false);
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
      label: 'Virgin',
      upc: '724384960650',
      gain: -8.2,
      genres: { data: [{ id: 106, name: 'Electro' }, { id: 113, name: 'Dance' }] },
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
    assert.deepEqual(album.genres, ['Electro', 'Dance']);
    assert.equal(album.publisher, 'Virgin');
    assert.equal(album.barcode, '724384960650');
    assert.equal(album.recordType, 'album');
    assert.equal(album.gainDb, -8.2);
    assert.equal(album.tracks.length, 101);
    assert.equal(album.tracks[100].discNumber, 2);
    assert.equal(album.tracks[100].trackNumber, 1);
    assert.ok(urls.some(url => url.includes('index=100')));
    await assert.rejects(verifiedDeezerAlbum('42', 'Other Artist', 'Discovery'), /does not match/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('verified Deezer releases allow catalog singles while keeping exact matching', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/album/45') return new Response(JSON.stringify({
      id: 45,
      title: 'Harder, Better, Faster, Stronger',
      artist: { name: 'Daft Punk' },
      record_type: 'single',
      nb_tracks: 2,
      release_date: '2010-04-05',
    }), { status: 200 });
    if (url.pathname === '/album/45/tracks') return new Response(JSON.stringify({
      total: 2,
      data: [
        { id: 451, title: 'Harder, Better, Faster, Stronger', artist: { name: 'Daft Punk' }, disk_number: 1, track_position: 1 },
        { id: 452, title: 'Harder, Better, Faster, Stronger (Remix)', artist: { name: 'Daft Punk' }, disk_number: 1, track_position: 2 },
      ],
    }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  try {
    const release = await verifiedDeezerAlbum('45', 'Daft Punk', 'Harder, Better, Faster, Stronger');
    assert.equal(release.recordType, 'single');
    assert.equal(release.tracks.length, 2);
    await assert.rejects(
      verifiedDeezerAlbum('45', 'Other Artist', 'Harder, Better, Faster, Stronger'),
      /does not match/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('single-track tag metadata prefers local genre and falls back to Deezer album genres', () => {
  const remote = { artist: 'Daft Punk', releaseDate: '2001-03-07', genres: ['Electro', 'Dance'] };
  assert.deepEqual(resolveDeezerTrackTagMetadata(null, remote), {
    albumArtist: 'Daft Punk',
    releaseDate: '2001-03-07',
    genres: ['Electro', 'Dance'],
  });
  assert.deepEqual(resolveDeezerTrackTagMetadata({
    album: 'Discovery',
    album_artist: 'Daft Punk',
    year: 2001,
    genre: 'House; Funk',
    country: null,
    language: null,
  }, remote), {
    albumArtist: 'Daft Punk',
    releaseDate: '2001',
    genres: ['House', 'Funk'],
  });
  assert.deepEqual(resolveDeezerTrackTagMetadata({
    album: 'Discovery',
    album_artist: 'Daft Punk',
    year: 2001,
    genre: null,
    country: null,
    language: null,
  }, remote).genres, ['Electro', 'Dance']);
});

test('oversized Deezer albums are rejected before track pagination', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 42, title: 'Huge Album', artist: { name: 'Artist' }, record_type: 'album', nb_tracks: 201,
  }), { status: 200 });
  try {
    await assert.rejects(verifiedDeezerAlbum('42', 'Artist', 'Huge Album'), /too large/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('album downloads are streamed from edited staged files without a persistent ZIP', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mvbar-staged-'));
  const oldDirectory = process.env.DEEZER_DOWNLOAD_DIR;
  process.env.DEEZER_DOWNLOAD_DIR = directory;
  try {
    const album = path.join(directory, 'Artist', 'Album');
    await mkdir(album, { recursive: true });
    await writeFile(path.join(album, '01-01 Song.flac'), 'before');
    await writeFile(path.join(album, '01-01 Song.flac'), 'after');

    const archive = await unzipper.Open.buffer(await streamBuffer(await createStagedAlbumArchive('Artist/Album')));
    assert.deepEqual(archive.files.map(file => file.path), ['Artist/Album/01-01 Song.flac']);
    assert.equal((await archive.files[0].buffer()).toString(), 'after');
    assert.equal((await readFile(path.join(album, '01-01 Song.flac'))).toString(), 'after');
    await assert.rejects(stat(path.join(directory, 'Artist', 'Album.zip')), error => error?.code === 'ENOENT');
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
    assert.equal(await stagedAlbumComplete('Artist/Album', expected, 2), true);

    await rm(path.join(album, expected[1]));
    await writeFile(path.join(album, '01-03 Extra.flac'), 'extra');
    assert.equal(await stagedAlbumComplete('Artist/Album', expected, 2), false);
    await assert.rejects(createStagedAlbumArchive('Artist/Album', expected, 2), /incomplete/);

    await writeFile(path.join(album, expected[1]), 'second again');
    const archive = await unzipper.Open.buffer(await streamBuffer(await createStagedAlbumArchive('Artist/Album', expected, 2)));
    assert.deepEqual(
      archive.files.map(file => file.path).sort(),
      expected.map(name => `Artist/Album/${name}`).sort(),
    );
  } finally {
    if (oldDirectory === undefined) delete process.env.DEEZER_DOWNLOAD_DIR;
    else process.env.DEEZER_DOWNLOAD_DIR = oldDirectory;
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy staged album ZIPs are removed only when the extracted album folder is valid', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mvbar-staged-cleanup-'));
  const oldDirectory = process.env.DEEZER_DOWNLOAD_DIR;
  process.env.DEEZER_DOWNLOAD_DIR = directory;
  try {
    const artist = path.join(directory, 'Artist');
    const album = path.join(artist, 'Album');
    await mkdir(album, { recursive: true });
    await writeFile(path.join(album, '01-01 Song.flac'), 'audio');
    await writeFile(path.join(artist, 'Album.zip'), 'legacy duplicate');
    await writeFile(path.join(artist, 'Orphan.zip'), 'keep me');

    assert.equal(await cleanupLegacyStagedAlbumArchives(), 1);
    await assert.rejects(stat(path.join(artist, 'Album.zip')), error => error?.code === 'ENOENT');
    assert.equal((await readFile(path.join(artist, 'Orphan.zip'))).toString(), 'keep me');
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
