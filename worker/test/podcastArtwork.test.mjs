import test from 'node:test';
import assert from 'node:assert/strict';
import { isCurrentPodcastArtPath } from '../dist/podcastRefresh.js';

test('podcast artwork cache paths distinguish resized files from legacy originals', () => {
  assert.equal(isCurrentPodcastArtPath('v2/ab/abcdef.jpg'), true);
  assert.equal(isCurrentPodcastArtPath('v2\\ab\\abcdef.jpg'), true);
  assert.equal(isCurrentPodcastArtPath('episodes/ab/abcdef.jpg'), false);
  assert.equal(isCurrentPodcastArtPath(null), false);
});
