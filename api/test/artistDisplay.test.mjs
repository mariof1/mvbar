import assert from 'node:assert/strict';
import test from 'node:test';
import {
  artistDisplay,
  artistNamesFromValue,
  trackArtistDisplay,
} from '../dist/artistDisplay.js';

test('artist display preserves names containing commas, ampersands, and bare slashes', () => {
  assert.deepEqual(
    artistNamesFromValue('Earth, Wind & Fire; AC/DC'),
    ['Earth, Wind & Fire', 'AC/DC'],
  );
  assert.equal(artistDisplay('Earth, Wind & Fire; AC/DC'), 'Earth, Wind & Fire • AC/DC');
});

test('track relation credits take precedence and preserve their order', () => {
  assert.equal(
    trackArtistDisplay(
      [{ id: 2, name: 'Artist B' }, { id: 1, name: 'Artist A' }],
      'Legacy Artist',
      'Album Artist',
    ),
    'Artist B • Artist A',
  );
});

test('artist display falls back predictably', () => {
  assert.equal(artistDisplay(null, 'Album Artist; Guest'), 'Album Artist • Guest');
  assert.equal(artistDisplay(null, null), 'Unknown Artist');
});

test('formatted album credits can be resolved back to individual artists', () => {
  assert.deepEqual(
    artistNamesFromValue('Album Artist A • Album Artist B'),
    ['Album Artist A', 'Album Artist B'],
  );
});
