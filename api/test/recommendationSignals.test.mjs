import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeRecommendationFeature,
  recommendationArtistKeys,
  splitRecommendationFeatures,
} from '../dist/recommendationFeatures.js';
import { normalizeCompletionRatio, normalizePlaybackSignal } from '../dist/playbackSignal.js';

test('normalizes recommendation features consistently across accents and artist separators', () => {
  assert.equal(normalizeRecommendationFeature('  Sokół  '), 'sokol');
  assert.deepEqual(recommendationArtistKeys('Sokół; Marysia Starosta | Sokół'), ['sokol', 'marysia starosta']);
  assert.deepEqual(splitRecommendationFeatures('Hip-Hop; Pop/Rock | hip-hop'), ['hip-hop', 'pop', 'rock']);
});

test('normalizes a measured completion without counting a seek as listened time', () => {
  assert.deepEqual(normalizePlaybackSignal({
    currentMs: 200_000,
    durationMs: 240_000,
    listenedMs: 45_000,
    slateId: 'slate-1',
    bucketKey: 'made_for_you',
  }, 240_000, null), {
    listenedMs: 45_000,
    completionPct: 200_000 / 240_000,
    context: { slateId: 'slate-1', bucketKey: 'made_for_you' },
  });
});

test('keeps legacy completed-play calls meaningful and bounds untrusted values', () => {
  assert.deepEqual(normalizePlaybackSignal(undefined, 180_000, 1), {
    listenedMs: 180_000,
    completionPct: 1,
    context: { slateId: null, bucketKey: null },
  });
  const bounded = normalizePlaybackSignal({ currentMs: 999_999, listenedMs: 999_999, completionPct: 300 }, 200_000, null);
  assert.equal(bounded.listenedMs, 200_000);
  assert.equal(bounded.completionPct, 1);
});

test('normalizes both legacy whole percentages and modern completion ratios', () => {
  assert.equal(normalizeCompletionRatio(12), 0.12);
  assert.equal(normalizeCompletionRatio(0.12), 0.12);
  assert.equal(normalizeCompletionRatio(150), 1);
  assert.equal(normalizeCompletionRatio('invalid'), null);
});
