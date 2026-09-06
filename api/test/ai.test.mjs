import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseSemanticTracks,
  fallbackMusicIntent,
  matchesDurationConstraints,
  matchesSemanticConstraints,
  normalizeCountryTerms,
  parseMusicIntent,
  requestMusicIntent,
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
    requireGenreMatch: false,
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
    minDurationMinutes: null,
    maxDurationMinutes: null,
    trackCount: 20,
    explanation: 'Selected gentle, low-energy music.',
  }), 'queue 20 tracks of soft music');

  assert.equal(intent.action, 'queue');
  assert.deepEqual(intent.moods, ['gentle', 'calm']);
  assert.equal(intent.targetBpm, 72);
  assert.equal(intent.trackCount, 20);
});

test('parseMusicIntent rejects model-invented hard filters and exact-match behavior', () => {
  const intent = parseMusicIntent(JSON.stringify({
    action: 'play',
    textQuery: 'flight',
    searchQuery: 'late night flight ambient',
    moods: ['calm', 'reflective', 'dreamy'],
    genres: ['ambient', 'neoclassical', 'post-rock'],
    relatedGenres: ['downtempo'],
    requireGenreMatch: true,
    countries: ['Iceland'],
    countryMode: 'strict',
    yearStart: 2020,
    yearEnd: 2025,
    namedArtists: ['Ólafur Arnalds'],
    similarToArtists: ['Sigur Rós'],
    referenceArtists: [],
    includeSimilar: true,
    avoid: ['metal'],
    energy: 'low',
    bpmMin: 50,
    bpmMax: 105,
    targetBpm: 70,
    minDurationMinutes: 5,
    maxDurationMinutes: 15,
    trackCount: 20,
    explanation: 'A calm flight mix.',
  }), 'Soft music for a late-night flight');

  assert.equal(intent.action, 'search');
  assert.equal(intent.textQuery, '');
  assert.equal(intent.requireGenreMatch, false);
  assert.deepEqual(intent.countries, []);
  assert.equal(intent.countryMode, 'any');
  assert.equal(intent.yearStart, null);
  assert.equal(intent.yearEnd, null);
  assert.deepEqual(intent.namedArtists, []);
  assert.deepEqual(intent.similarToArtists, []);
  assert.equal(intent.includeSimilar, false);
  assert.equal(intent.minDurationMinutes, null);
  assert.equal(intent.maxDurationMinutes, null);
  assert.equal(intent.trackCount, 24);
});

test('parseMusicIntent never lets the model invent a playback side effect', () => {
  const modelResponse = JSON.stringify({
    action: 'play',
    textQuery: '',
    searchQuery: 'ambient calm',
    moods: ['calm'],
    genres: ['ambient'],
    trackCount: 24,
  });

  assert.equal(parseMusicIntent(modelResponse, 'soft music for a late-night flight').action, 'search');
  assert.equal(parseMusicIntent(modelResponse, 'queue soft music for a late-night flight').action, 'queue');
  assert.equal(parseMusicIntent(modelResponse, 'play soft music for a late-night flight').action, 'play');
});

test('parseMusicIntent preserves an explicitly named title while retaining semantic enrichment', () => {
  const intent = parseMusicIntent(JSON.stringify({
    action: 'play',
    textQuery: 'Take It Easy',
    searchQuery: 'Take It Easy Eagles',
    moods: ['easygoing'],
    genres: ['country rock'],
    trackCount: 100,
  }), 'play Take It Easy');

  assert.equal(intent.textQuery, 'Take It Easy');
  assert.equal(intent.action, 'play');
  assert.equal(intent.trackCount, 24);
});

test('explicit artist exclusions are enforced even when the model omits them', () => {
  const intent = parseMusicIntent(JSON.stringify({
    action: 'play',
    textQuery: '',
    searchQuery: 'artists similar to Linkin Park',
    moods: [],
    genres: ['nu metal', 'alternative rock'],
    relatedGenres: ['rap rock'],
    requireGenreMatch: false,
    countries: [],
    countryMode: 'any',
    yearStart: null,
    yearEnd: null,
    namedArtists: [],
    similarToArtists: ['Linkin Park'],
    referenceArtists: [],
    includeSimilar: true,
    avoid: [],
    energy: 'high',
    bpmMin: 90,
    bpmMax: 160,
    targetBpm: 120,
    minDurationMinutes: null,
    maxDurationMinutes: null,
    trackCount: 24,
    explanation: 'Artists similar to Linkin Park.',
  }), 'play songs similar to Linkin Park but exclude Linkin Park');

  assert.ok(intent.avoid.includes('linkin park'));
  assert.equal(matchesSemanticConstraints(candidate({
    artist: 'Linkin Park',
    albumArtist: 'Linkin Park',
    displayArtist: 'Linkin Park',
    genre: 'Nu Metal;Alternative Rock',
  }), intent), false);
  assert.equal(matchesSemanticConstraints(candidate({
    artist: 'Breaking Benjamin',
    albumArtist: 'Breaking Benjamin',
    displayArtist: 'Breaking Benjamin',
    genre: 'Alternative Rock',
  }), intent), true);
});

test('natural exclusion wording removes artists and similarity seeds deterministically', () => {
  const modelResponse = JSON.stringify({
    action: 'play',
    textQuery: '',
    searchQuery: 'artists similar to Taco Hemingway',
    moods: [],
    genres: ['hip hop', 'rap'],
    relatedGenres: ['alternative hip hop'],
    requireGenreMatch: false,
    countries: [],
    countryMode: 'any',
    yearStart: null,
    yearEnd: null,
    namedArtists: [],
    similarToArtists: ['Taco Hemingway'],
    referenceArtists: [],
    includeSimilar: true,
    avoid: [],
    energy: 'medium',
    bpmMin: 70,
    bpmMax: 150,
    targetBpm: 105,
    minDurationMinutes: null,
    maxDurationMinutes: null,
    trackCount: 24,
    explanation: 'Polish alternative hip hop.',
  });

  const prompts = [
    "play songs similar to Taco Hemingway but don't play Taco Hemingway",
    'play songs similar to Taco Hemingway but avoid Taco Hemingway',
    'play songs similar to Taco Hemingway but leave out Taco Hemingway',
    'play songs similar to Taco Hemingway but leave Taco Hemingway out',
    'play songs similar to Taco Hemingway but not by him',
    'play songs similar to Taco Hemingway without the original artist',
  ];

  for (const prompt of prompts) {
    const intent = parseMusicIntent(modelResponse, prompt);
    assert.ok(intent.avoid.includes('taco hemingway'), prompt);
    assert.equal(matchesSemanticConstraints(candidate({
      artist: 'Taco Hemingway',
      albumArtist: 'Taco Hemingway',
      displayArtist: 'Taco Hemingway',
      genre: 'Hip Hop;Rap',
    }), intent), false, prompt);
  }
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

test('fallbackMusicIntent treats country western as a genre rather than a text search', () => {
  const intent = fallbackMusicIntent('play country western');
  assert.equal(intent.action, 'play');
  assert.equal(intent.textQuery, '');
  assert.ok(intent.genres.includes('country'));
  assert.ok(intent.genres.includes('country western'));
  assert.ok(intent.relatedGenres.includes('honky tonk'));
  assert.ok(intent.relatedGenres.includes('western swing'));
  assert.equal(intent.requireGenreMatch, true);
  assert.ok(intent.avoid.includes('industrial'));
  assert.ok(intent.avoid.includes('metal'));
});

test('country-western safeguards override an overly broad model interpretation', () => {
  const intent = parseMusicIntent(JSON.stringify({
    action: 'play',
    textQuery: 'country western',
    genres: ['country', 'rock'],
    relatedGenres: ['western swing', 'rock', 'pop'],
    requireGenreMatch: false,
    moods: ['rustic', 'rebellious'],
    avoid: [],
    trackCount: 24,
  }), 'play country western');

  assert.equal(intent.textQuery, '');
  assert.equal(intent.requireGenreMatch, true);
  assert.equal(intent.genres.includes('rock'), false);
  assert.ok(intent.relatedGenres.includes('western swing'));
  assert.equal(intent.relatedGenres.includes('rock'), false);
  assert.equal(intent.relatedGenres.includes('pop'), false);
  assert.ok(intent.avoid.includes('industrial'));
});

test('country normalization treats UK nations and nationality aliases as one provenance group', () => {
  assert.deepEqual(normalizeCountryTerms(['British', 'England', 'United Kingdom']), ['united kingdom']);
});

test('fallbackMusicIntent understands exact count and per-track minimum duration', () => {
  const intent = fallbackMusicIntent('play 10 songs each 10mins or over');
  assert.equal(intent.action, 'play');
  assert.equal(intent.textQuery, '');
  assert.equal(intent.trackCount, 10);
  assert.equal(intent.minDurationMinutes, 10);
  assert.equal(intent.maxDurationMinutes, null);
});

test('fallbackMusicIntent understands duration maximums and ranges', () => {
  const short = fallbackMusicIntent('queue 6 tracks under 4 minutes');
  assert.equal(short.trackCount, 6);
  assert.equal(short.minDurationMinutes, null);
  assert.equal(short.maxDurationMinutes, 4);

  const range = fallbackMusicIntent('play 8 songs between 5 and 9 minutes');
  assert.equal(range.trackCount, 8);
  assert.equal(range.minDurationMinutes, 5);
  assert.equal(range.maxDurationMinutes, 9);
});

test('parseMusicIntent safely falls back when the response is invalid', () => {
  const intent = parseMusicIntent('not-json', 'play soft music');
  assert.equal(intent.action, 'play');
  assert.equal(intent.energy, 'low');
  assert.ok(intent.genres.includes('downtempo'));
});

test('requestMusicIntent retries insufficient credit through the free router', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    requests.push({ model: body.model, dataCollection: body.provider?.data_collection });
    if (requests.length === 1) return new Response('', { status: 402 });

    return new Response(JSON.stringify({
      model: 'nvidia/example:free',
      choices: [{ message: { content: JSON.stringify(fallbackMusicIntent('play soft music')) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await requestMusicIntent(
      'test-key',
      'google/gemini-test',
      'openrouter/free',
      'play soft music',
      new AbortController().signal
    );
    assert.equal(result.usedFreeFallback, true);
    assert.equal(result.model, 'nvidia/example:free');
    assert.deepEqual(requests, [
      { model: 'google/gemini-test', dataCollection: 'deny' },
      { model: 'openrouter/free', dataCollection: 'allow' },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requestMusicIntent permits the documented data policy for the free router', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(String(options?.body));
    return new Response(JSON.stringify({
      model: 'example/free-model:free',
      choices: [{ message: { content: JSON.stringify(fallbackMusicIntent('jazz for a rainy afternoon')) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await requestMusicIntent(
      'test-key',
      'openrouter/free',
      'openrouter/free',
      'jazz for a rainy afternoon',
      new AbortController().signal
    );
    assert.equal(result.usedFreeFallback, false);
    assert.equal(requestBody.model, 'openrouter/free');
    assert.equal(requestBody.provider.data_collection, 'allow');
    assert.equal(requestBody.provider.require_parameters, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requestMusicIntent retries one transient empty response from the free router', async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      return new Response(JSON.stringify({
        model: 'example/empty:free',
        choices: [{ message: { content: '' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      model: 'example/working:free',
      choices: [{ message: { content: JSON.stringify(fallbackMusicIntent('soft music')) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const result = await requestMusicIntent(
      'test-key',
      'openrouter/free',
      'openrouter/free',
      'soft music',
      new AbortController().signal
    );
    assert.equal(requests, 2);
    assert.equal(result.model, 'example/working:free');
    assert.equal(result.intent.action, 'search');
  } finally {
    globalThis.fetch = originalFetch;
  }
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

test('semantic selection never fills a country-western queue with unrelated music', () => {
  const intent = {
    ...fallbackMusicIntent('play country western'),
    moods: ['rustic', 'rebellious'],
    trackCount: 8,
  };
  const candidates = [
    candidate({ id: 1, artist: 'Country Artist', genre: 'Country', bpm: 102 }),
    candidate({ id: 2, artist: 'Western Artist', genre: 'Western Swing', bpm: 110 }),
    candidate({ id: 3, artist: 'Roots Artist', genre: 'Americana', bpm: 96 }),
    candidate({ id: 4, artist: 'Marilyn Manson', genre: 'Industrial Metal;Shock Rock', bpm: 104, playCount: 500, isFavorite: true }),
    candidate({ id: 5, artist: 'Pop Artist', genre: 'Dance Pop', mood: 'rustic;rebellious', bpm: 104, playCount: 500, isFavorite: true }),
  ];

  assert.equal(matchesSemanticConstraints(candidates[3], intent), false);
  assert.equal(matchesSemanticConstraints(candidates[4], intent), false);
  const tracks = chooseSemanticTracks(candidates, intent, 'country-western-test');
  assert.deepEqual(new Set(tracks.map((track) => track.id)), new Set([1, 2, 3]));
});

test('duration constraints are hard filters for every selected track', () => {
  const intent = {
    ...fallbackMusicIntent('play 10 songs each 10mins or over'),
    trackCount: 10,
  };
  assert.equal(matchesDurationConstraints(candidate({ durationMs: 10 * 60_000 }), intent), true);
  assert.equal(matchesDurationConstraints(candidate({ durationMs: 9 * 60_000 + 59_000 }), intent), false);
  assert.equal(matchesDurationConstraints(candidate({ durationMs: null }), intent), false);

  const candidates = Array.from({ length: 14 }, (_, index) => candidate({
    id: index + 1,
    artist: `Artist ${index}`,
    displayArtist: `Artist ${index}`,
    durationMs: (index < 3 ? 8 : 10 + index) * 60_000,
  }));
  const tracks = chooseSemanticTracks(candidates, intent, 'duration-test');
  assert.equal(tracks.length, 10);
  assert.ok(tracks.every((track) => Number(track.durationMs) >= 10 * 60_000));
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
