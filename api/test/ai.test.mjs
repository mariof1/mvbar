import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseSemanticTracks,
  fallbackMusicIntent,
  normalizeCountryTerms,
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
    relatedGenres: ['downtempo'],
    countries: [],
    countryMode: 'any',
    yearStart: null,
    yearEnd: null,
    namedArtists: [],
    similarToArtists: [],
    referenceArtists: [],
    includeSimilar: false,
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

test('fallbackMusicIntent decomposes British grunge and similar into provenance and close genres', () => {
  const intent = fallbackMusicIntent('play British grunge from the nineties and similar');
  assert.equal(intent.action, 'play');
  assert.equal(intent.textQuery, '');
  assert.deepEqual(intent.countries, ['united kingdom']);
  assert.equal(intent.countryMode, 'prefer');
  assert.deepEqual(intent.genres, ['grunge']);
  assert.ok(intent.relatedGenres.includes('post-grunge'));
  assert.ok(intent.relatedGenres.includes('alternative rock'));
  assert.equal(intent.yearStart, 1990);
  assert.equal(intent.yearEnd, 1999);
  assert.equal(intent.includeSimilar, true);
});

test('country normalization treats UK nations and nationality aliases as one provenance group', () => {
  assert.deepEqual(normalizeCountryTerms(['British', 'England', 'United Kingdom']), ['united kingdom']);
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
    country: null,
    year: null,
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

test('semantic scoring prioritizes country and exact genre before adjacent or foreign matches', () => {
  const intent = fallbackMusicIntent('play British grunge and similar');
  const britishGrunge = candidate({ id: 1, genre: 'grunge', country: 'England', bpm: 120 });
  const britishAdjacent = candidate({ id: 2, genre: 'alternative rock', country: 'United Kingdom', bpm: 120 });
  const americanGrunge = candidate({ id: 3, genre: 'grunge', country: 'United States', bpm: 120 });
  const unrelated = candidate({ id: 4, genre: 'dance pop', country: 'United States', bpm: 120 });

  const exactScore = scoreSemanticCandidate(britishGrunge, intent);
  const adjacentScore = scoreSemanticCandidate(britishAdjacent, intent);
  const foreignScore = scoreSemanticCandidate(americanGrunge, intent);
  const unrelatedScore = scoreSemanticCandidate(unrelated, intent);
  assert.ok(exactScore > adjacentScore);
  assert.ok(adjacentScore > foreignScore);
  assert.ok(foreignScore > unrelatedScore);
});

test('semantic scoring recognizes reference and Last.fm-similar artists without substring collisions', () => {
  const intent = {
    ...fallbackMusicIntent('play British grunge and similar'),
    referenceArtists: ['Bush'],
    similarArtists: ['Feeder'],
  };
  const bush = candidate({ id: 1, artist: 'Bush', displayArtist: 'Bush', genre: 'grunge' });
  const kateBush = candidate({ id: 2, artist: 'Kate Bush', displayArtist: 'Kate Bush', genre: 'art pop' });
  const feeder = candidate({ id: 3, artist: 'Feeder', displayArtist: 'Feeder', genre: 'alternative rock' });

  assert.ok(scoreSemanticCandidate(bush, intent) > scoreSemanticCandidate(kateBush, intent));
  assert.ok(scoreSemanticCandidate(feeder, intent) > scoreSemanticCandidate(kateBush, intent));
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
