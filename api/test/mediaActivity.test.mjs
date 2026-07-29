import assert from 'node:assert/strict';
import test from 'node:test';
import {
  boundedPosition,
  continuousListeningDelta,
} from '../dist/mediaActivity.js';

test('boundedPosition rejects malformed values and clamps to duration', () => {
  assert.equal(boundedPosition('1200', 5000), null);
  assert.equal(boundedPosition(Number.NaN, 5000), null);
  assert.equal(boundedPosition(-100, 5000), null);
  assert.equal(boundedPosition(9000, 5000), 5000);
  assert.equal(boundedPosition(1234.9, null), 1234);
});

test('continuousListeningDelta ignores seeks and counts contiguous playback', () => {
  assert.equal(continuousListeningDelta(10_000, 25_000), 15_000);
  assert.equal(continuousListeningDelta(25_000, 10_000), 0);
  assert.equal(continuousListeningDelta(0, 20 * 60_000), 0);
  assert.equal(continuousListeningDelta(null, 20 * 60_000), 15 * 60_000);
});
