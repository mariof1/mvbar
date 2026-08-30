import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isCurrentMusicArtPath,
  MUSIC_ART_MAX_DIMENSION,
} from '../dist/art.js';

test('music artwork recognizes only versioned normalized paths', () => {
  assert.equal(MUSIC_ART_MAX_DIMENSION, 800);
  assert.equal(isCurrentMusicArtPath('v2/ab/abcdef.jpg'), true);
  assert.equal(isCurrentMusicArtPath('v2\\ab\\abcdef.jpg'), true);
  assert.equal(isCurrentMusicArtPath('ab/abcdef.jpg'), false);
  assert.equal(isCurrentMusicArtPath('artists/ab/abcdef.png'), false);
  assert.equal(isCurrentMusicArtPath(null), false);
});
