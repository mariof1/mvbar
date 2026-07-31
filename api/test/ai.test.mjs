import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseSemanticTracks,
  fallbackMusicIntent,
  parseMusicIntent,
  scoreSemanticCandidate,
} from '../dist/ai.js';

test('fallbackMusicIntent understands soft as musical attributes', () => {
  const intent = fallbackMusicIntent('play soft music');
  assert.equal(intent.action, 'play');
  assert.equal(intent.textQuery, '');
  assert.equal(intent.energy, 'low');
  assert.ok(intent.moods.includes('calm'));
  assert.ok(intent.genres.includes('ambient'));
  assert.ok(intent.bpmMax <= 110);
});

test('parseMusicIntent accepts a structured OpenRouter response', () => {
  const intent = parseMusicIntent(JSON.stringify({
    action: 'queue',
    textQuery: '',
    searchQuery: 'ambient calm',
    moods: ['gentle', 'calm'],
    genres: ['ambient', 'acoustic'],
    avoid: ['metal'],
    energy: 'low',
    bpmMin: 50,
    bpmMax: 100,
    targetBpm: 72,
    trackCount: 20,
    explanation: 'Selected gentle, low-energy music.',
  }), 'queue soft music');

  assert.equal(intent.action, 'queue');
  assert.deepEqual(intent.moods, ['gentle', 'calm']);
  assert.equal(intent.targetBpm, 72);
  assert.equal(intent.trackCount, 20);
});

test('parseMusicIntent safely falls back when the response is invalid', () => {
  const intent = parseMusicIntent('not-json', 'play soft music');
  assert.equal(intent.action, 'play');
  assert.equal(intent.energy, 'low');
  assert.ok(intent.genres.includes('downtempo'));
});

function candidate(overrides) {
  return {
    id: 1,
    title: 'Track',
    artist: 'Artist',
    albumArtist: 'Artist',
    displayArtist: 'Artist',
    album: 'Album',
    path: '/music/track.flac',
    ext: 'flac',
    durationMs: 180000,
    genre: null,
    mood: null,
    bpm: null,
    playCount: 0,
    skipCount: 0,
    lastPlayedAt: null,
    isFavorite: false,
    ...overrides,
  };
}

test('semantic scoring prefers genuinely soft tracks over aggressive tracks', () => {
  const intent = fallbackMusicIntent('play soft music');
  const soft = candidate({ id: 1, genre: 'ambient acoustic', mood: 'calm gentle soothing', bpm: 72 });
  const aggressive = candidate({ id: 2, genre: 'industrial metal', mood: 'aggressive intense', bpm: 168 });

  assert.ok(scoreSemanticCandidate(soft, intent) > scoreSemanticCandidate(aggressive, intent) + 50);
});

test('semantic selection returns a varied playable queue', () => {
  const intent = { ...fallbackMusicIntent('play soft music'), trackCount: 5 };
  const candidates = Array.from({ length: 8 }, (_, index) => candidate({
    id: index + 1,
    artist: index < 5 ? 'Same Artist' : `Artist ${index}`,
    displayArtist: index < 5 ? 'Same Artist' : `Artist ${index}`,
    album: index < 4 ? 'Same Album' : `Album ${index}`,
    genre: 'ambient',
    mood: 'calm',
    bpm: 70 + index,
  }));
  const tracks = chooseSemanticTracks(candidates, intent, 'test-seed', Date.UTC(2026, 0, 1));

  assert.equal(tracks.length, 5);
  assert.ok(tracks.filter((track) => track.artist === 'Same Artist').length <= 3);
});
