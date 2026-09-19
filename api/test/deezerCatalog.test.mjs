import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEEZER_MAX_ALBUM_TRACKS,
  deezerAlbum,
  deezerBaseAlbumTitle,
  deezerSecondaryTypes,
  dedupeDeezerAlbums,
  localAlbumTitleScore,
  matchDeezerTrack,
  normalizeDeezerText,
} from '../dist/pluginSystem/deezerCatalog.js';

test('Deezer catalog normalization keeps international titles usable', () => {
  assert.equal(normalizeDeezerText('Beyoncé — Déjà Vu'), 'beyonce deja vu');
  assert.equal(normalizeDeezerText('世界'), '世界');
});

test('album base-title matching removes editions but keeps genuinely different releases distinct', () => {
  assert.equal(deezerBaseAlbumTitle('Discovery (Deluxe Edition)'), 'discovery');
  assert.equal(deezerBaseAlbumTitle('Discovery - 2001 Remastered Edition'), 'discovery');
  assert.equal(deezerBaseAlbumTitle('Discovery (Live)'), 'discovery live');
  assert.equal(localAlbumTitleScore('Discovery', 'Discovery (Deluxe Edition)'), 85);
  assert.equal(localAlbumTitleScore('Discovery', 'Discovery (Live)'), 0);
});

test('secondary release classification avoids ordinary titles containing live/remix words', () => {
  assert.deepEqual(deezerSecondaryTypes('Live Through This', 'album', 123), []);
  assert.deepEqual(deezerSecondaryTypes('Live at Wembley', 'album', 123), ['Live']);
  assert.deepEqual(deezerSecondaryTypes('Album (Live)', 'album', 123), ['Live']);
  assert.deepEqual(deezerSecondaryTypes('The Remixes', 'album', 123), ['Remix']);
  assert.deepEqual(deezerSecondaryTypes('Soundtrack of My Life', 'album', 123), []);
  assert.deepEqual(deezerSecondaryTypes('Original Motion Picture Soundtrack', 'album', 123), ['Soundtrack']);
  assert.equal(DEEZER_MAX_ALBUM_TRACKS, 200);
});

test('full Deezer album metadata keeps clean, deduplicated genre names', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: 302127,
    title: 'Discovery',
    nb_tracks: 14,
    release_date: '2001-03-07',
    record_type: 'album',
    label: 'Virgin',
    upc: '724384960650',
    gain: -8.2,
    artist: { id: 27, name: 'Daft Punk' },
    genres: { data: [
      { id: 106, name: 'Electro' },
      { id: 113, name: 'Dance' },
      { id: 999, name: ' electro ' },
      { id: 1000, name: '' },
    ] },
  }), { status: 200 });
  try {
    const album = await deezerAlbum('302127');
    assert.deepEqual(album.genres, ['Electro', 'Dance']);
    assert.equal(album.publisher, 'Virgin');
    assert.equal(album.barcode, '724384960650');
    assert.equal(album.gainDb, -8.2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Deezer album dedupe prefers standard editions unless special editions are requested', () => {
  const base = {
    artistId: '27', artist: 'Daft Punk', releaseDate: '2001-03-07',
    recordType: 'Album', secondaryTypes: [], cover: null, explicit: false,
  };
  const standard = { ...base, id: '1', title: 'Discovery', trackCount: 14, baseTitle: 'discovery' };
  const deluxe = { ...base, id: '2', title: 'Discovery (Deluxe Edition)', trackCount: 18, baseTitle: 'discovery', explicit: true };
  assert.equal(dedupeDeezerAlbums([deluxe, standard], false)[0].id, '1');
  assert.equal(dedupeDeezerAlbums([standard, deluxe], true)[0].id, '2');
});

test('track matching prefers ISRC when available', () => {
  const remote = {
    id: '42', title: 'One More Time', artist: 'Daft Punk', artistId: '27',
    albumId: '1', album: 'Discovery', isrc: 'GBDUW0000053',
    durationMs: 320000, discNumber: 1, trackNumber: 1,
  };
  const result = matchDeezerTrack(remote, [{
    id: 9, title: 'Different title', isrc: 'GB-DUW-00-00053',
    duration_ms: 100000, disc_number: 1, track_number: 8,
  }]);
  assert.equal(result.present, true);
  assert.equal(result.confidence, 100);
  assert.equal(result.reason, 'ISRC');
});

test('track matching works without ISRC or MusicBrainz ids for partial albums', () => {
  const remote = {
    id: '43', title: 'Digital Love', artist: 'Daft Punk', artistId: '27',
    albumId: '1', album: 'Discovery', isrc: null,
    durationMs: 301000, discNumber: 1, trackNumber: 3,
  };
  const result = matchDeezerTrack(remote, [{
    id: 10, title: 'Digital Love', isrc: null,
    duration_ms: 303000, disc_number: 1, track_number: 3,
  }]);
  assert.equal(result.present, true);
  assert.ok(result.confidence >= 90);
  assert.match(result.reason, /title/);
  assert.match(result.reason, /track number/);
  assert.match(result.reason, /duration/);
});

test('same track number is not enough to mark a different song present', () => {
  const remote = {
    id: '44', title: 'Aerodynamic', artist: 'Daft Punk', artistId: '27',
    albumId: '1', album: 'Discovery', isrc: null,
    durationMs: 212000, discNumber: 1, trackNumber: 2,
  };
  const result = matchDeezerTrack(remote, [{
    id: 11, title: 'Something Else', isrc: null,
    duration_ms: 212000, disc_number: 1, track_number: 2,
  }]);
  assert.equal(result.present, false);
  assert.equal(result.confidence, 0);
});
