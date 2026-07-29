import assert from 'node:assert/strict';
import test from 'node:test';
import { meiliErrorCode, rowToDoc, TRACK_INDEX_VERSION } from '../dist/indexer.js';

test('meiliErrorCode reads API errors nested under cause', () => {
  const error = Object.assign(new Error('Index not found'), {
    cause: { code: 'index_not_found' },
  });

  assert.equal(meiliErrorCode(error), 'index_not_found');
  assert.equal(meiliErrorCode({ code: 'invalid_api_key' }), 'invalid_api_key');
  assert.equal(meiliErrorCode(new Error('network failure')), '');
});

test('rowToDoc normalizes PostgreSQL bigint identifiers', () => {
  const doc = rowToDoc({
    id: '42',
    library_id: '7',
    path: 'Artist/Album/Track.mp3',
    ext: '.mp3',
    title: 'Track',
    artist: 'Sokół',
    album_artist: 'Sokół',
    album: 'Album',
    duration_ms: 123000,
    genre: 'Hip-Hop',
    country: 'Poland',
    year: 2024,
    language: 'Polish',
    composer: null,
    mood: null,
    bpm: null,
    initial_key: null,
  });

  assert.equal(doc.id, 42);
  assert.equal(doc.library_id, 7);
  assert.equal(doc.index_version, TRACK_INDEX_VERSION);
  assert.equal(doc.artist_ascii, 'Sokol');
});
