import assert from 'node:assert/strict';
import test from 'node:test';
import {
  curateRecommendationBuckets,
  interleaveRecommendationTracks,
  recommendationBucketLimit,
  recommendationMaturity,
  spaceRecommendationTracks,
  stableRecommendationBucketKey,
} from '../dist/recommendationCuration.js';

function bucket(key, start, count = 12) {
  return {
    key,
    tracks: Array.from({ length: count }, (_, index) => ({ id: start + index })),
  };
}

test('adapts the amount of choice to taste-profile maturity', () => {
  assert.equal(recommendationMaturity(0), 'new');
  assert.equal(recommendationMaturity(0.2), 'learning');
  assert.equal(recommendationMaturity(0.8), 'personalized');
  assert.equal(recommendationBucketLimit(0), 4);
  assert.equal(recommendationBucketLimit(0.2), 5);
  assert.equal(recommendationBucketLimit(0.8), 6);
});

test('keeps sparse taste signals in onboarding', () => {
  assert.equal(recommendationMaturity(0.9, 1), 'new');
  assert.equal(recommendationMaturity(0.9, 4), 'new');
  assert.equal(recommendationMaturity(0.2, 5), 'learning');
  assert.equal(recommendationBucketLimit(0.9, 1), 4);

  const result = curateRecommendationBuckets([
    bucket('library_mix', 1),
    bucket('popular_library', 20),
    bucket('recently_added', 40),
    bucket('made_for_you', 60),
  ], { confidence: 0.9, positiveSamples: 1, seed: 9 });

  assert.ok(result.some((item) => item.key === 'recently_added'));
  assert.equal(result.some((item) => item.key === 'made_for_you'), false);
  assert.equal(result.length <= 4, true);
});

test('builds a compact slate with personal, discovery, familiar and context roles', () => {
  const candidates = [
    bucket('made_for_you', 1),
    bucket('top_picks', 20),
    bucket('discover_weekly', 40),
    bucket('listenbrainz_picks', 60),
    bucket('on_repeat', 80),
    bucket('rediscover', 100),
    bucket('daily_mix_rock', 120),
    bucket('daily_mix_pop', 140),
    bucket('decade_1990', 160),
    bucket('language_polish', 180),
    bucket('recently_added', 200),
    bucket('favorites', 220),
  ];

  const result = curateRecommendationBuckets(candidates, { confidence: 0.8, seed: 123 });
  const keys = result.map((item) => item.key);

  assert.equal(result.length, 6);
  assert.equal(keys[0], 'made_for_you');
  assert.ok(keys.includes('discover_weekly'));
  assert.ok(keys.some((key) => key === 'on_repeat' || key === 'rediscover'));
  assert.ok(keys.some((key) => key.startsWith('daily_mix_') || key.startsWith('decade_') || key.startsWith('language_')));
  assert.equal(keys.filter((key) => key.startsWith('daily_mix_')).length <= 1, true);
  assert.equal(keys.filter((key) => key.startsWith('decade_') || key.startsWith('language_')).length <= 1, true);
  assert.equal(keys.includes('top_picks'), false);
  assert.equal(keys.includes('recently_added'), false);
  assert.equal(keys.includes('favorites'), false);
});

test('rotates between eligible familiar choices without losing determinism', () => {
  const candidates = [bucket('on_repeat', 1), bucket('rediscover', 20)];
  const choices = new Set();
  for (let seed = 1; seed <= 100; seed++) {
    const first = curateRecommendationBuckets(candidates, {
      confidence: 0.8,
      seed,
      maxBuckets: 1,
    })[0];
    choices.add(first?.key);
  }

  assert.deepEqual(choices, new Set(['on_repeat', 'rediscover']));
  assert.equal(
    curateRecommendationBuckets(candidates, { confidence: 0.8, seed: 15, maxBuckets: 1 })[0].key,
    curateRecommendationBuckets(candidates, { confidence: 0.8, seed: 15, maxBuckets: 1 })[0].key,
  );
});

test('keeps onboarding buckets for a new listener', () => {
  const result = curateRecommendationBuckets([
    bucket('library_mix', 1),
    bucket('fresh_finds', 20),
    bucket('recently_added', 40),
    bucket('favorites', 60),
    bucket('mood_evening', 80),
  ], { confidence: 0, seed: 9 });

  assert.equal(result.length, 3);
  assert.ok(result.some((item) => item.key === 'recently_added' || item.key === 'favorites'));
  assert.equal(result.some((item) => item.key === 'mood_evening'), false);
});

test('rejects buckets that substantially repeat an earlier mix', () => {
  const result = curateRecommendationBuckets([
    bucket('made_for_you', 1, 20),
    bucket('discover_weekly', 1, 20),
    bucket('listenbrainz_picks', 40, 20),
    bucket('on_repeat', 80, 20),
    bucket('daily_mix_rock', 120, 20),
  ], { confidence: 0.8, seed: 42, maxBuckets: 4 });

  assert.equal(result.some((item) => item.key === 'discover_weekly'), false);
  assert.equal(result.some((item) => item.key === 'listenbrainz_picks'), true);
});

test('deduplicates tracks across the complete slate and backfills each bucket', () => {
  const result = curateRecommendationBuckets([
    bucket('made_for_you', 1, 40),
    bucket('discover_weekly', 21, 50),
    bucket('on_repeat', 80, 20),
  ], { confidence: 0.8, seed: 12, maxBuckets: 3 });

  const ids = result.flatMap((item) => item.tracks.map((track) => track.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(result.find((item) => item.key === 'discover_weekly')?.tracks.length, 30);
});

test('enforces artist exposure across a bucket', () => {
  const tracks = Array.from({ length: 40 }, (_, index) => ({
    id: index + 1,
    artist: `Artist ${Math.floor(index / 4)}`,
    album: `Album ${Math.floor(index / 4)}`,
  }));
  const [result] = curateRecommendationBuckets([
    { key: 'made_for_you', tracks },
  ], { confidence: 0.8, seed: 4, maxBuckets: 1 });

  const counts = new Map();
  for (const track of result.tracks) counts.set(track.artist, (counts.get(track.artist) || 0) + 1);
  assert.ok([...counts.values()].every((count) => count <= 2));
});

test('does not overshoot slate exposure caps while preparing a later bucket', () => {
  const sharedArtistTracks = (start, count, artist, albumPrefix) => Array.from(
    { length: count },
    (_, index) => ({
      id: start + index,
      artist,
      album: `${albumPrefix} ${index}`,
    }),
  );
  const fillTracks = (start, count, prefix) => Array.from(
    { length: count },
    (_, index) => ({
      id: start + index,
      artist: `${prefix} Artist ${index}`,
      album: `${prefix} Album ${index}`,
    }),
  );

  const result = curateRecommendationBuckets([
    {
      key: 'made_for_you',
      tracks: [
        ...sharedArtistTracks(1, 2, 'Shared Artist', 'Personal'),
        ...fillTracks(10, 8, 'Personal'),
      ],
    },
    {
      key: 'discover_weekly',
      tracks: [
        ...sharedArtistTracks(30, 2, 'Shared Artist', 'Discover'),
        ...fillTracks(40, 8, 'Discover'),
      ],
    },
    {
      key: 'jump_back_in',
      tracks: [
        ...sharedArtistTracks(60, 6, 'Shared Artist', 'Familiar'),
        ...fillTracks(70, 8, 'Familiar'),
      ],
    },
    bucket('daily_mix_rock', 100),
  ], { confidence: 0.9, positiveSamples: 20, seed: 4 });

  const sharedArtistCount = result
    .flatMap((item) => item.tracks)
    .filter((track) => track.artist === 'Shared Artist')
    .length;
  assert.equal(sharedArtistCount, 6);
});

test('uses popular and recently added instead of two freshness buckets for onboarding', () => {
  const result = curateRecommendationBuckets([
    bucket('library_mix', 1),
    bucket('popular_library', 20),
    bucket('recently_added', 40),
    bucket('fresh_finds', 60),
  ], { confidence: 0, seed: 7 });

  const keys = result.map((item) => item.key);
  assert.ok(keys.includes('popular_library'));
  assert.ok(keys.includes('recently_added'));
  assert.equal(keys.includes('fresh_finds'), false);
});

test('does not show an undersized recommendation bucket', () => {
  const result = curateRecommendationBuckets([
    bucket('made_for_you', 1),
    bucket('new_from_artists', 30, 4),
  ], { confidence: 0.8, seed: 1 });

  assert.equal(result.some((item) => item.key === 'new_from_artists'), false);
});

test('builds stable distinct keys for non-Latin bucket names', () => {
  const first = stableRecommendationBucketKey('because', 'АК-47::Третий');
  const again = stableRecommendationBucketKey('because', 'АК-47::Третий');
  const different = stableRecommendationBucketKey('because', 'АК-47::Новый');

  assert.equal(first, again);
  assert.notEqual(first, different);
  assert.match(first, /^because_[a-z0-9_]+_[a-f0-9]{8}$/);
});

test('keeps the personal anchor at a two-to-one familiar/discovery blend', () => {
  const familiar = Array.from({ length: 40 }, (_, index) => `known-${index}`);
  const unplayed = Array.from({ length: 20 }, (_, index) => `new-${index}`);
  const result = interleaveRecommendationTracks(familiar, unplayed, 30);

  assert.equal(result.filter((item) => item.startsWith('known-')).length, 20);
  assert.equal(result.filter((item) => item.startsWith('new-')).length, 10);
});

test('spaces artists in playback order without changing the track set', () => {
  const tracks = [
    { id: 1, artist: 'Artist A' },
    { id: 2, artist: 'Artist A' },
    { id: 3, artist: 'Artist A' },
    { id: 4, artist: 'Artist B' },
    { id: 5, artist: 'Artist B' },
    { id: 6, artist: 'Artist C' },
  ];

  const result = spaceRecommendationTracks(tracks);
  assert.deepEqual(result.map((track) => track.id).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  for (let index = 1; index < result.length; index++) {
    assert.notEqual(result[index - 1].artist, result[index].artist);
  }
  assert.deepEqual(spaceRecommendationTracks(tracks), result);
});

test('spaces a same-artist cluster at the end when alternatives exist', () => {
  const tracks = [
    { id: 1, artist: 'Artist A' },
    { id: 2, artist: 'Artist B' },
    { id: 3, artist: 'Artist C' },
    { id: 4, artist: 'Artist D' },
    { id: 5, artist: 'Artist E' },
    { id: 6, artist: 'Artist Z' },
    { id: 7, artist: 'Artist Z' },
    { id: 8, artist: 'Artist Z' },
  ];

  const result = spaceRecommendationTracks(tracks);
  assert.deepEqual(result.map((track) => track.id).sort((a, b) => a - b), tracks.map((track) => track.id));
  for (let index = 1; index < result.length; index++) {
    assert.notEqual(result[index - 1].artist, result[index].artist);
  }
});
