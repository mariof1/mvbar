import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { allowedLibrariesForUser } from './access.js';
import { db } from './db.js';
import { getSimilarArtists, isLastfmEnabled } from './lastfm.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemini-3.6-flash';
const MAX_QUERY_LENGTH = 500;
const MAX_REQUESTS_PER_MINUTE = 10;
const MAX_CANDIDATES = 1_200;

export type MusicIntentAction = 'play' | 'queue' | 'search';
export type MusicEnergy = 'low' | 'medium' | 'high' | 'any';
export type CountryMode = 'strict' | 'prefer' | 'any';

export type MusicIntent = {
  action: MusicIntentAction;
  textQuery: string;
  searchQuery: string;
  moods: string[];
  genres: string[];
  relatedGenres: string[];
  countries: string[];
  countryMode: CountryMode;
  yearStart: number | null;
  yearEnd: number | null;
  namedArtists: string[];
  similarToArtists: string[];
  referenceArtists: string[];
  similarArtists: string[];
  includeSimilar: boolean;
  avoid: string[];
  energy: MusicEnergy;
  bpmMin: number | null;
  bpmMax: number | null;
  targetBpm: number | null;
  trackCount: number;
  explanation: string;
};

export type AiTrack = {
  id: number;
  title: string | null;
  artist: string | null;
  albumArtist: string | null;
  displayArtist: string | null;
  album: string | null;
  path: string;
  ext: string;
  durationMs: number | null;
};

export type SemanticCandidate = AiTrack & {
  genre: string | null;
  mood: string | null;
  country: string | null;
  year: number | null;
  bpm: number | null;
  playCount: number;
  skipCount: number;
  lastPlayedAt: Date | string | null;
  isFavorite: boolean;
};

type RateWindow = {
  startedAt: number;
  count: number;
};

type OpenRouterResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
};

const rateWindows = new Map<string, RateWindow>();

const COUNTRY_ALIASES: Record<string, string> = {
  american: 'united states', america: 'united states', usa: 'united states', us: 'united states', 'united states of america': 'united states',
  british: 'united kingdom', britain: 'united kingdom', uk: 'united kingdom', 'great britain': 'united kingdom',
  english: 'united kingdom', england: 'united kingdom', scottish: 'united kingdom', scotland: 'united kingdom',
  welsh: 'united kingdom', wales: 'united kingdom', 'northern irish': 'united kingdom', 'northern ireland': 'united kingdom',
  polish: 'poland', polska: 'poland', german: 'germany', deutsch: 'germany', french: 'france',
  spanish: 'spain', italian: 'italy', japanese: 'japan', korean: 'south korea', brazilian: 'brazil',
  russian: 'russia', dutch: 'netherlands', swedish: 'sweden', norwegian: 'norway', danish: 'denmark',
  finnish: 'finland', canadian: 'canada', australian: 'australia', irish: 'ireland', mexican: 'mexico',
  jamaican: 'jamaica', portuguese: 'portugal', czech: 'czech republic', ukrainian: 'ukraine',
};

const COUNTRY_GROUPS: Record<string, string[]> = {
  'united kingdom': ['united kingdom', 'uk', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland'],
  'united states': ['united states', 'united states of america', 'usa', 'us', 'america'],
};

const DECADE_PATTERNS: Array<{ pattern: RegExp; start: number; end: number; words: string[] }> = [
  { pattern: /\b(?:50s|fifties|1950s?)\b/i, start: 1950, end: 1959, words: ['50s', 'fifties', '1950', '1950s'] },
  { pattern: /\b(?:60s|sixties|1960s?)\b/i, start: 1960, end: 1969, words: ['60s', 'sixties', '1960', '1960s'] },
  { pattern: /\b(?:70s|seventies|1970s?)\b/i, start: 1970, end: 1979, words: ['70s', 'seventies', '1970', '1970s'] },
  { pattern: /\b(?:80s|eighties|1980s?)\b/i, start: 1980, end: 1989, words: ['80s', 'eighties', '1980', '1980s'] },
  { pattern: /\b(?:90s|nineties|1990s?)\b/i, start: 1990, end: 1999, words: ['90s', 'nineties', '1990', '1990s'] },
  { pattern: /\b(?:2000s|zeroes|noughties)\b/i, start: 2000, end: 2009, words: ['2000s', 'zeroes', 'noughties'] },
  { pattern: /\b(?:2010s|tens)\b/i, start: 2010, end: 2019, words: ['2010s', 'tens'] },
  { pattern: /\b(?:2020s|twenties)\b/i, start: 2020, end: 2029, words: ['2020s', 'twenties'] },
];

function cleanText(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizedTerm(value: unknown): string {
  return cleanText(typeof value === 'string' ? value : '', 60).toLowerCase();
}

function normalizedTerms(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map(normalizedTerm).filter(Boolean))).slice(0, limit);
}

function boundedBpm(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(Math.max(30, Math.min(240, parsed)));
}

function boundedYear(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(Math.max(1900, Math.min(2100, parsed)));
}

function canonicalCountry(value: string): string {
  const normalized = normalizedTerm(value);
  return COUNTRY_ALIASES[normalized] || normalized;
}

export function normalizeCountryTerms(value: unknown): string[] {
  return Array.from(new Set(normalizedTerms(value, 10).map(canonicalCountry).filter(Boolean)));
}

function expandedCountryTerms(countries: string[]): string[] {
  const terms = new Set<string>();
  for (const value of countries) {
    const canonical = canonicalCountry(value);
    terms.add(canonical);
    for (const alias of COUNTRY_GROUPS[canonical] || []) terms.add(alias);
  }
  return [...terms];
}

function mergeTerms(...lists: string[][]): string[] {
  return Array.from(new Set(lists.flat().map(normalizedTerm).filter(Boolean)));
}

function consumeRateLimit(userId: string): boolean {
  const now = Date.now();
  const current = rateWindows.get(userId);

  if (!current || now - current.startedAt >= 60_000) {
    rateWindows.set(userId, { startedAt: now, count: 1 });
    return true;
  }

  if (current.count >= MAX_REQUESTS_PER_MINUTE) return false;
  current.count += 1;
  return true;
}

function inferAction(query: string): MusicIntentAction {
  if (/\b(queue|enqueue|add(?: it| this| them)? to (?:the )?queue)\b/i.test(query)) return 'queue';
  if (/\b(play|put on|start|listen to|give me|spin)\b/i.test(query)) return 'play';
  return 'search';
}

function textQueryWithoutFiller(query: string, semanticWords: string[]): string {
  let result = query.toLowerCase();
  const removable = [
    'play', 'put on', 'start', 'listen to', 'give me', 'spin', 'queue', 'enqueue',
    'find', 'show me', 'search for', 'look for', 'from the', 'from', 'music', 'songs', 'tracks',
    'something', 'some', 'please', 'for me', 'kind of', 'a bit of', 'and',
    ...semanticWords,
  ].sort((a, b) => b.length - a.length);

  for (const phrase of removable) {
    result = result.replace(new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'gi'), ' ');
  }

  return cleanText(result, 160);
}

export function fallbackMusicIntent(query: string): MusicIntent {
  const lower = query.toLowerCase();
  let moods: string[] = [];
  let genres: string[] = [];
  let relatedGenres: string[] = [];
  let countries: string[] = [];
  let countryMode: CountryMode = 'any';
  let yearStart: number | null = null;
  let yearEnd: number | null = null;
  const namedArtists: string[] = [];
  const similarToArtists: string[] = [];
  const referenceArtists: string[] = [];
  let avoid: string[] = [];
  let energy: MusicEnergy = 'any';
  let bpmMin: number | null = null;
  let bpmMax: number | null = null;
  let targetBpm: number | null = null;
  let semanticWords: string[] = [];
  let concept = 'your request';

  if (/\b(soft|gentle|calm|quiet|soothing|relax(?:ed|ing)?|mellow|peaceful|easy)\b/.test(lower)) {
    moods = ['soft', 'gentle', 'calm', 'quiet', 'soothing', 'relaxed', 'mellow', 'peaceful', 'warm'];
    genres = ['ambient', 'chill', 'chillout', 'downtempo', 'acoustic', 'folk', 'classical', 'smooth jazz', 'new age'];
    avoid = ['metal', 'hardcore', 'punk', 'industrial', 'gabber', 'noise'];
    energy = 'low';
    bpmMin = 50;
    bpmMax = 105;
    targetBpm = 76;
    semanticWords = ['soft', 'gentle', 'calm', 'quiet', 'soothing', 'relaxed', 'relaxing', 'mellow', 'peaceful', 'easy'];
    concept = 'soft, calm and low-energy music';
  } else if (/\b(sleep|bedtime|fall asleep|night music)\b/.test(lower)) {
    moods = ['sleep', 'calm', 'peaceful', 'quiet', 'soothing', 'dreamy', 'meditative'];
    genres = ['ambient', 'drone', 'new age', 'meditation', 'minimalist', 'piano'];
    avoid = ['metal', 'punk', 'dance', 'edm', 'hardcore'];
    energy = 'low';
    bpmMin = 40;
    bpmMax = 85;
    targetBpm = 62;
    semanticWords = ['sleep', 'bedtime', 'night'];
    concept = 'very calm music suitable for sleep';
  } else if (/\b(focus|study|work|concentrat(?:e|ion)|reading)\b/.test(lower)) {
    moods = ['focused', 'calm', 'instrumental', 'minimal', 'steady', 'atmospheric'];
    genres = ['ambient', 'classical', 'minimalist', 'lofi', 'downtempo', 'instrumental', 'post-rock'];
    avoid = ['party', 'hardcore', 'gabber'];
    energy = 'low';
    bpmMin = 55;
    bpmMax = 115;
    targetBpm = 82;
    semanticWords = ['focus', 'study', 'work', 'concentrate', 'concentration', 'reading'];
    concept = 'steady, unobtrusive music for focus';
  } else if (/\b(energetic|energy|workout|gym|running|intense|pump me up|party)\b/.test(lower)) {
    moods = ['energetic', 'powerful', 'upbeat', 'driving', 'intense', 'excited'];
    genres = ['dance', 'edm', 'rock', 'metal', 'hip hop', 'drum and bass', 'techno', 'punk'];
    avoid = ['ambient', 'sleep', 'meditation', 'slowcore'];
    energy = 'high';
    bpmMin = 115;
    bpmMax = 185;
    targetBpm = 138;
    semanticWords = ['energetic', 'energy', 'workout', 'gym', 'running', 'intense', 'party'];
    concept = 'high-energy, driving music';
  } else if (/\b(happy|cheerful|feel good|uplifting|sunny|positive)\b/.test(lower)) {
    moods = ['happy', 'cheerful', 'uplifting', 'positive', 'bright', 'feel good'];
    genres = ['pop', 'soul', 'funk', 'disco', 'indie pop', 'reggae'];
    avoid = ['dark ambient', 'funeral doom', 'sadcore'];
    energy = 'medium';
    bpmMin = 90;
    bpmMax = 145;
    targetBpm = 118;
    semanticWords = ['happy', 'cheerful', 'feel good', 'uplifting', 'sunny', 'positive'];
    concept = 'happy and uplifting music';
  } else if (/\b(sad|melanchol(?:y|ic)|heartbreak|blue|gloomy|somber)\b/.test(lower)) {
    moods = ['sad', 'melancholic', 'somber', 'reflective', 'emotional', 'wistful'];
    genres = ['slowcore', 'indie folk', 'acoustic', 'blues', 'piano', 'ambient'];
    avoid = ['party', 'happy hardcore'];
    energy = 'low';
    bpmMin = 45;
    bpmMax = 105;
    targetBpm = 72;
    semanticWords = ['sad', 'melancholy', 'melancholic', 'heartbreak', 'blue', 'gloomy', 'somber'];
    concept = 'sad, reflective and low-energy music';
  } else if (/\b(romantic|date night|love songs?|sensual|intimate)\b/.test(lower)) {
    moods = ['romantic', 'intimate', 'sensual', 'warm', 'tender', 'love'];
    genres = ['soul', 'r&b', 'smooth jazz', 'acoustic', 'ballad', 'bossa nova'];
    avoid = ['hardcore', 'death metal', 'gabber'];
    energy = 'low';
    bpmMin = 55;
    bpmMax = 115;
    targetBpm = 82;
    semanticWords = ['romantic', 'date night', 'love', 'sensual', 'intimate'];
    concept = 'warm and romantic music';
  }

  if (/\bgrunge\b/.test(lower)) {
    genres = mergeTerms(['grunge'], genres);
    relatedGenres = mergeTerms(relatedGenres, ['post-grunge', 'alternative rock', 'noise rock', 'garage rock', 'sludge rock', 'hard rock']);
    moods = mergeTerms(moods, ['raw', 'gritty', 'brooding', 'distorted', 'angst']);
    if (energy === 'any') {
      energy = 'medium';
      bpmMin = 70;
      bpmMax = 165;
      targetBpm = 118;
    }
    semanticWords.push('grunge');
    concept = 'grunge first, followed by closely related alternative and post-grunge music';
  }

  const countryAliases = Object.keys(COUNTRY_ALIASES).sort((a, b) => b.length - a.length);
  const countryAlias = countryAliases.find((alias) => new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'i').test(lower));
  if (countryAlias) {
    countries = [canonicalCountry(countryAlias)];
    countryMode = /\b(?:only|exclusively|strictly)\b/i.test(query) ? 'strict' : 'prefer';
    semanticWords.push(countryAlias);
    const countryLabel = countries[0] === 'united kingdom' ? 'British' : countries[0];
    concept = `${countryLabel} ${concept}`;
  }

  for (const decade of DECADE_PATTERNS) {
    if (!decade.pattern.test(query)) continue;
    yearStart = decade.start;
    yearEnd = decade.end;
    semanticWords.push(...decade.words);
    break;
  }

  if (yearStart === null) {
    const yearMatch = query.match(/\b(19[0-9]{2}|20[0-9]{2}|2100)\b/);
    if (yearMatch) {
      yearStart = Number(yearMatch[1]);
      yearEnd = yearStart;
      semanticWords.push(yearMatch[1]);
    }
  }

  const includeSimilar = /\b(?:similar|related|adjacent|like this|more like|in the vein of|in the style of)\b/i.test(query);
  if (includeSimilar) semanticWords.push('similar', 'related', 'adjacent', 'like this', 'more like', 'in the vein of', 'in the style of');

  const textQuery = textQueryWithoutFiller(query, semanticWords);
  const searchQuery = cleanText([textQuery, countries[0], genres[0] || moods[0]].filter(Boolean).join(' '), 200) || cleanText(query, 200);

  return {
    action: inferAction(query),
    textQuery,
    searchQuery,
    moods,
    genres,
    relatedGenres,
    countries,
    countryMode,
    yearStart,
    yearEnd,
    namedArtists,
    similarToArtists,
    referenceArtists,
    similarArtists: [],
    includeSimilar,
    avoid,
    energy,
    bpmMin,
    bpmMax,
    targetBpm,
    trackCount: 24,
    explanation: `Interpreted this as ${concept}.`,
  };
}

function applyEnergyDefaults(intent: MusicIntent): MusicIntent {
  if (intent.energy === 'low') {
    intent.bpmMin ??= 45;
    intent.bpmMax ??= 110;
    intent.targetBpm ??= 78;
  } else if (intent.energy === 'medium') {
    intent.bpmMin ??= 80;
    intent.bpmMax ??= 145;
    intent.targetBpm ??= 115;
  } else if (intent.energy === 'high') {
    intent.bpmMin ??= 110;
    intent.bpmMax ??= 200;
    intent.targetBpm ??= 140;
  }

  if (intent.bpmMin !== null && intent.bpmMax !== null && intent.bpmMin > intent.bpmMax) {
    [intent.bpmMin, intent.bpmMax] = [intent.bpmMax, intent.bpmMin];
  }
  if (intent.yearStart !== null && intent.yearEnd !== null && intent.yearStart > intent.yearEnd) {
    [intent.yearStart, intent.yearEnd] = [intent.yearEnd, intent.yearStart];
  }
  return intent;
}

export function parseMusicIntent(content: string, fallbackQuery: string): MusicIntent {
  const fallback = fallbackMusicIntent(fallbackQuery);
  const withoutFence = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  try {
    const parsed = JSON.parse(withoutFence) as Record<string, unknown>;
    const action = parsed.action === 'play' || parsed.action === 'queue' || parsed.action === 'search'
      ? parsed.action
      : fallback.action;
    const energy = parsed.energy === 'low' || parsed.energy === 'medium' || parsed.energy === 'high' || parsed.energy === 'any'
      ? parsed.energy
      : fallback.energy;
    const countryMode = parsed.countryMode === 'strict' || parsed.countryMode === 'prefer' || parsed.countryMode === 'any'
      ? parsed.countryMode
      : fallback.countryMode;
    const textQuery = cleanText(typeof parsed.textQuery === 'string' ? parsed.textQuery : fallback.textQuery, 160);
    const moods = normalizedTerms(parsed.moods);
    const genres = normalizedTerms(parsed.genres);
    const relatedGenres = normalizedTerms(parsed.relatedGenres);
    const countries = normalizeCountryTerms(parsed.countries);
    const namedArtists = normalizedTerms(parsed.namedArtists, 10);
    const similarToArtists = normalizedTerms(parsed.similarToArtists, 6);
    const referenceArtists = normalizedTerms(parsed.referenceArtists, 10);
    const searchQuery = cleanText(
      typeof parsed.searchQuery === 'string'
        ? parsed.searchQuery
        : [textQuery, countries[0], genres[0], moods[0]].filter(Boolean).join(' '),
      200
    ) || fallback.searchQuery;
    const trackCountRaw = Number(parsed.trackCount);

    return applyEnergyDefaults({
      action,
      textQuery,
      searchQuery,
      moods: moods.length > 0 ? moods : fallback.moods,
      genres: genres.length > 0 ? genres : fallback.genres,
      relatedGenres: relatedGenres.length > 0 ? relatedGenres : fallback.relatedGenres,
      countries: countries.length > 0 ? countries : fallback.countries,
      countryMode,
      yearStart: boundedYear(parsed.yearStart) ?? fallback.yearStart,
      yearEnd: boundedYear(parsed.yearEnd) ?? fallback.yearEnd,
      namedArtists: namedArtists.length > 0 ? namedArtists : fallback.namedArtists,
      similarToArtists: similarToArtists.length > 0 ? similarToArtists : fallback.similarToArtists,
      referenceArtists: referenceArtists.length > 0 ? referenceArtists : fallback.referenceArtists,
      similarArtists: [],
      includeSimilar: typeof parsed.includeSimilar === 'boolean' ? parsed.includeSimilar : fallback.includeSimilar,
      avoid: normalizedTerms(parsed.avoid).length > 0 ? normalizedTerms(parsed.avoid) : fallback.avoid,
      energy,
      bpmMin: boundedBpm(parsed.bpmMin) ?? fallback.bpmMin,
      bpmMax: boundedBpm(parsed.bpmMax) ?? fallback.bpmMax,
      targetBpm: boundedBpm(parsed.targetBpm) ?? fallback.targetBpm,
      trackCount: Number.isFinite(trackCountRaw) ? Math.max(5, Math.min(50, Math.round(trackCountRaw))) : fallback.trackCount,
      explanation: cleanText(typeof parsed.explanation === 'string' ? parsed.explanation : fallback.explanation, 300) || fallback.explanation,
    });
  } catch {
    return fallback;
  }
}

function normalizeFeature(value: string): string {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
}

function featureText(...values: Array<string | null>): string {
  return normalizeFeature(values.filter(Boolean).join(' '));
}

function featureValues(...values: Array<string | null>): string[] {
  const result = new Set<string>();
  for (const value of values) {
    for (const part of String(value || '').split(/[;,/|]/)) {
      const normalized = normalizeFeature(part);
      if (normalized) result.add(normalized);
    }
  }
  return [...result];
}

function termMatches(text: string, term: string): boolean {
  const comparable = (value: string) => normalizeFeature(value).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
  return comparable(text).includes(comparable(term));
}

function exactFeatureMatch(values: string[], term: string): boolean {
  const normalized = normalizeFeature(term);
  return values.some((value) => value === normalized);
}

function bestArtistMatch(artistValues: string[], terms: string[]): boolean {
  return terms.some((term) => exactFeatureMatch(artistValues, term));
}

export function scoreSemanticCandidate(candidate: SemanticCandidate, intent: MusicIntent, now = Date.now()): number {
  const genre = featureText(candidate.genre);
  const genreValues = featureValues(candidate.genre);
  const mood = featureText(candidate.mood);
  const countryValues = featureValues(candidate.country).map(canonicalCountry);
  const artistValues = featureValues(candidate.artist, candidate.albumArtist, candidate.displayArtist);
  const identity = featureText(candidate.title, candidate.artist, candidate.album);
  const allMetadata = `${genre} ${mood} ${identity} ${featureText(candidate.country)}`;
  let score = 0;

  let moodScore = 0;
  for (const term of intent.moods) {
    if (termMatches(mood, term)) moodScore += 16;
    else if (termMatches(genre, term)) moodScore += 6;
  }
  score += Math.min(44, moodScore);

  let primaryGenreScore = 0;
  for (const term of intent.genres) {
    if (exactFeatureMatch(genreValues, term)) primaryGenreScore += 30;
    else if (termMatches(genre, term)) primaryGenreScore += 15;
    else if (termMatches(mood, term)) primaryGenreScore += 6;
  }
  score += Math.min(52, primaryGenreScore);

  let relatedGenreScore = 0;
  for (const term of intent.relatedGenres) {
    if (exactFeatureMatch(genreValues, term)) relatedGenreScore += 13;
    else if (termMatches(genre, term)) relatedGenreScore += 7;
  }
  score += Math.min(28, relatedGenreScore);

  for (const term of intent.avoid) {
    if (termMatches(allMetadata, term)) score -= 30;
  }

  if (intent.countries.length > 0 && intent.countryMode !== 'any') {
    const wanted = new Set(intent.countries.map(canonicalCountry));
    const countryMatches = countryValues.some((country) => wanted.has(country));
    if (countryMatches) score += intent.countryMode === 'strict' ? 44 : 34;
    else if (countryValues.length > 0) score -= intent.countryMode === 'strict' ? 52 : 10;
    else if (intent.countryMode === 'strict') score -= 8;
  }

  const candidateYear = Number(candidate.year);
  if (intent.yearStart !== null || intent.yearEnd !== null) {
    const start = intent.yearStart ?? 1900;
    const end = intent.yearEnd ?? 2100;
    if (Number.isFinite(candidateYear) && candidateYear > 0) {
      if (candidateYear >= start && candidateYear <= end) score += 24;
      else {
        const distance = candidateYear < start ? start - candidateYear : candidateYear - end;
        score -= Math.min(30, distance * 2);
      }
    } else {
      score -= 5;
    }
  }

  const namedArtistMatch = bestArtistMatch(artistValues, intent.namedArtists);
  const similarityAnchorMatch = bestArtistMatch(artistValues, intent.similarToArtists);
  const referenceArtistMatch = bestArtistMatch(artistValues, intent.referenceArtists);
  const similarArtistMatch = bestArtistMatch(artistValues, intent.similarArtists);
  if (namedArtistMatch) score += 64;
  if (similarityAnchorMatch) score += intent.includeSimilar ? 8 : 48;
  if (referenceArtistMatch) score += 28;
  if (similarArtistMatch) score += 24;
  if (intent.namedArtists.length > 0 && !namedArtistMatch && !similarArtistMatch && !intent.includeSimilar) {
    score -= 38;
  }

  if (intent.textQuery) {
    const words = intent.textQuery.toLowerCase().split(/\s+/).filter((word) => word.length > 1);
    const matchedWords = words.filter((word) => identity.includes(word)).length;
    score += matchedWords * 15;
    if (words.length > 0 && matchedWords === words.length) score += 20;
    if (words.length > 0 && matchedWords === 0) score -= 35;
  }

  const bpm = Number(candidate.bpm);
  if (Number.isFinite(bpm) && bpm > 0) {
    if (intent.bpmMin !== null && bpm < intent.bpmMin) score -= Math.min(20, (intent.bpmMin - bpm) * 0.35);
    if (intent.bpmMax !== null && bpm > intent.bpmMax) score -= Math.min(25, (bpm - intent.bpmMax) * 0.4);
    if ((intent.bpmMin === null || bpm >= intent.bpmMin) && (intent.bpmMax === null || bpm <= intent.bpmMax)) score += 12;
    if (intent.targetBpm !== null) score += Math.max(0, 12 - Math.abs(bpm - intent.targetBpm) * 0.3);

    if (intent.energy === 'low') {
      if (bpm <= 90) score += 9;
      else if (bpm > 125) score -= 16;
    } else if (intent.energy === 'high') {
      if (bpm >= 120) score += 9;
      else if (bpm < 90) score -= 14;
    }
  }

  if (candidate.isFavorite) score += 3;
  score += Math.min(5, Math.log2(Math.max(0, Number(candidate.playCount)) + 1));

  const plays = Math.max(0, Number(candidate.playCount));
  const skips = Math.max(0, Number(candidate.skipCount));
  if (skips > 0) score -= (skips / Math.max(1, plays + skips)) * 10;

  if (candidate.lastPlayedAt) {
    const ageDays = (now - new Date(candidate.lastPlayedAt).getTime()) / 86_400_000;
    if (ageDays < 1) score -= 12;
    else if (ageDays < 3) score -= 7;
    else if (ageDays < 14) score -= 2;
  }

  return score;
}

function deterministicNoise(id: number, seed: string): number {
  let hash = 2166136261;
  const input = `${seed}:${id}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

export function chooseSemanticTracks(
  candidates: SemanticCandidate[],
  intent: MusicIntent,
  seed: string,
  now = Date.now()
): AiTrack[] {
  const ranked = candidates
    .map((track) => ({ track, score: scoreSemanticCandidate(track, intent, now) + deterministicNoise(track.id, seed) * 2 }))
    .sort((a, b) => b.score - a.score);

  const selected: AiTrack[] = [];
  const artistCounts = new Map<string, number>();
  const albumCounts = new Map<string, number>();
  const seenIds = new Set<number>();

  const add = (track: SemanticCandidate, enforceVariety: boolean) => {
    if (seenIds.has(track.id)) return false;
    const artistKey = (track.displayArtist || track.artist || '').toLowerCase();
    const albumKey = `${artistKey}::${(track.album || '').toLowerCase()}`;
    if (enforceVariety && artistKey && (artistCounts.get(artistKey) || 0) >= 3) return false;
    if (enforceVariety && track.album && (albumCounts.get(albumKey) || 0) >= 2) return false;

    seenIds.add(track.id);
    artistCounts.set(artistKey, (artistCounts.get(artistKey) || 0) + 1);
    albumCounts.set(albumKey, (albumCounts.get(albumKey) || 0) + 1);
    selected.push({
      id: track.id,
      title: track.title,
      artist: track.artist,
      albumArtist: track.albumArtist,
      displayArtist: track.displayArtist,
      album: track.album,
      path: track.path,
      ext: track.ext,
      durationMs: track.durationMs,
    });
    return true;
  };

  for (const item of ranked) {
    if (selected.length >= intent.trackCount) break;
    if (item.score < -5) continue;
    add(item.track, true);
  }
  for (const item of ranked) {
    if (selected.length >= intent.trackCount) break;
    if (item.score < -5) continue;
    add(item.track, false);
  }

  return selected;
}

function patternsForTerms(terms: string[]): string[] {
  const variants = terms.flatMap((term) => {
    const cleaned = term.replace(/[\\%_]/g, '');
    return [cleaned, cleaned.replace(/[-_]+/g, ' '), cleaned.replace(/\s+/g, '-')];
  });
  return Array.from(new Set(variants.map((term) => `%${term}%`).filter((term) => term !== '%%')));
}

async function enrichSimilarity(intent: MusicIntent): Promise<MusicIntent> {
  if (!intent.includeSimilar || !isLastfmEnabled()) return intent;

  const anchors = mergeTerms(intent.similarToArtists, intent.namedArtists, intent.referenceArtists).slice(0, 3);
  if (anchors.length === 0) return intent;

  const settled = await Promise.allSettled(anchors.map((artist) => getSimilarArtists(artist, 20)));
  const anchorSet = new Set(anchors.map(normalizeFeature));
  const similarArtists: string[] = [];
  const seen = new Set<string>();
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const artist of result.value) {
      const name = cleanText(artist.name, 100);
      const key = normalizeFeature(name);
      if (!key || anchorSet.has(key) || seen.has(key)) continue;
      seen.add(key);
      similarArtists.push(name);
      if (similarArtists.length >= 40) break;
    }
    if (similarArtists.length >= 40) break;
  }

  return { ...intent, similarArtists };
}

async function loadSemanticCandidates(
  userId: string,
  allowed: number[] | null,
  intent: MusicIntent,
  seed: string
): Promise<SemanticCandidate[]> {
  const params: unknown[] = [userId];
  const accessConditions: string[] = [];
  const matchConditions: string[] = [];
  const priorityConditions: Array<{ sql: string; weight: number }> = [];

  const addMatch = (sql: string, weight: number) => {
    matchConditions.push(sql);
    priorityConditions.push({ sql, weight });
  };

  if (allowed !== null) {
    params.push(allowed);
    accessConditions.push(`t.library_id = any($${params.length}::bigint[])`);
  }

  const primaryGenrePatterns = patternsForTerms(intent.genres);
  if (primaryGenrePatterns.length > 0) {
    params.push(primaryGenrePatterns);
    addMatch(`(
      lower(concat_ws(' ', coalesce(t.genre, ''), coalesce(t.mood, ''))) like any($${params.length}::text[])
      or exists (
        select 1 from track_genres matched_genre
        where matched_genre.track_id = t.id
          and lower(matched_genre.genre) like any($${params.length}::text[])
      )
    )`, 4);
  }

  const relatedPatterns = patternsForTerms([...intent.relatedGenres, ...intent.moods]);
  if (relatedPatterns.length > 0) {
    params.push(relatedPatterns);
    addMatch(`(
      lower(concat_ws(' ', coalesce(t.genre, ''), coalesce(t.mood, ''))) like any($${params.length}::text[])
      or exists (
        select 1 from track_genres related_genre
        where related_genre.track_id = t.id
          and lower(related_genre.genre) like any($${params.length}::text[])
      )
    )`, 2);
  }

  const countryTerms = expandedCountryTerms(intent.countries);
  if (countryTerms.length > 0) {
    params.push(countryTerms);
    addMatch(`(
      exists (
        select 1 from unnest(regexp_split_to_array(coalesce(t.country, ''), '\\s*[;,|/]\\s*')) raw_country
        where lower(trim(raw_country)) = any($${params.length}::text[])
      )
      or exists (
        select 1 from track_countries matched_country
        where matched_country.track_id = t.id
          and lower(trim(matched_country.country)) = any($${params.length}::text[])
      )
    )`, 4);
  }

  const directArtists = mergeTerms(intent.namedArtists, intent.similarToArtists);
  if (directArtists.length > 0) {
    params.push(directArtists);
    addMatch(`exists (
      select 1 from unnest(regexp_split_to_array(concat_ws(';', t.artist, t.album_artist), '\\s*[;|]\\s*')) direct_artist
      where lower(trim(direct_artist)) = any($${params.length}::text[])
    ) or exists (
      select 1 from track_artists direct_ta
      join artists direct_a on direct_a.id = direct_ta.artist_id
      where direct_ta.track_id = t.id
        and lower(trim(direct_a.name)) = any($${params.length}::text[])
    )`, 5);
  }

  const discoveryArtists = mergeTerms(intent.referenceArtists, intent.similarArtists);
  if (discoveryArtists.length > 0) {
    params.push(discoveryArtists);
    addMatch(`exists (
      select 1 from unnest(regexp_split_to_array(concat_ws(';', t.artist, t.album_artist), '\\s*[;|]\\s*')) discovery_artist
      where lower(trim(discovery_artist)) = any($${params.length}::text[])
    ) or exists (
      select 1 from track_artists discovery_ta
      join artists discovery_a on discovery_a.id = discovery_ta.artist_id
      where discovery_ta.track_id = t.id
        and lower(trim(discovery_a.name)) = any($${params.length}::text[])
    )`, 3);
  }

  if (intent.textQuery) {
    const identityTerms = [intent.textQuery, ...intent.textQuery.split(/\s+/).filter((word) => word.length > 1)];
    params.push(patternsForTerms(identityTerms));
    addMatch(`lower(concat_ws(' ', coalesce(t.title, ''), coalesce(t.artist, ''), coalesce(t.album_artist, ''), coalesce(t.album, ''))) like any($${params.length}::text[])`, 5);
  }

  if (intent.yearStart !== null || intent.yearEnd !== null) {
    const start = intent.yearStart ?? 1900;
    const end = intent.yearEnd ?? 2100;
    params.push(start, end);
    addMatch(`coalesce(t.original_year, t.year) between $${params.length - 1} and $${params.length}`, 3);
  }

  if (intent.bpmMin !== null || intent.bpmMax !== null) {
    if (intent.bpmMin !== null && intent.bpmMax !== null) {
      params.push(intent.bpmMin, intent.bpmMax);
      addMatch(`t.bpm between $${params.length - 1} and $${params.length}`, 1);
    } else if (intent.bpmMin !== null) {
      params.push(intent.bpmMin);
      addMatch(`t.bpm >= $${params.length}`, 1);
    } else if (intent.bpmMax !== null) {
      params.push(intent.bpmMax);
      addMatch(`t.bpm <= $${params.length}`, 1);
    }
  }

  params.push(seed);
  const seedParam = params.length;
  const whereParts = [
    ...accessConditions,
    ...(matchConditions.length > 0 ? [`(${matchConditions.join(' or ')})`] : []),
  ];
  const databasePriority = priorityConditions.length > 0
    ? priorityConditions.map(({ sql, weight }) => `(case when ${sql} then ${weight} else 0 end)`).join(' + ')
    : '0';

  const result = await db().query<{
    id: number;
    title: string | null;
    artist: string | null;
    album_artist: string | null;
    album: string | null;
    path: string;
    ext: string;
    duration_ms: number | null;
    genre: string | null;
    mood: string | null;
    country: string | null;
    year: number | null;
    bpm: number | null;
    play_count: number;
    skip_count: number;
    last_played_at: Date | null;
    is_favorite: boolean;
  }>(
    `select t.id::int, t.title, t.artist, t.album_artist, t.album, t.path, t.ext, t.duration_ms,
            concat_ws(';', nullif(t.genre, ''), genre_tags.genres) as genre,
            t.mood,
            concat_ws(';', nullif(t.country, ''), country_tags.countries) as country,
            coalesce(t.original_year, t.year) as year,
            t.bpm,
            coalesce(uts.play_count, 0)::int as play_count,
            coalesce(uts.skip_count, 0)::int as skip_count,
            uts.last_played_at,
            (ft.track_id is not null) as is_favorite
     from active_tracks t
     left join lateral (
       select string_agg(tg.genre, ';') as genres
       from track_genres tg
       where tg.track_id = t.id
     ) genre_tags on true
     left join lateral (
       select string_agg(tc.country, ';') as countries
       from track_countries tc
       where tc.track_id = t.id
     ) country_tags on true
     left join user_track_stats uts on uts.track_id = t.id and uts.user_id = $1
     left join favorite_tracks ft on ft.track_id = t.id and ft.user_id = $1
     ${whereParts.length > 0 ? `where ${whereParts.join(' and ')}` : ''}
     order by (${databasePriority}) desc, md5(t.id::text || $${seedParam})
     limit ${MAX_CANDIDATES}`,
    params
  );

  return result.rows.map((row) => {
    const albumArtist = row.album_artist?.split(/[;|]/)[0]?.trim() || null;
    const firstArtist = row.artist?.split(/[;|]/)[0]?.trim() || null;
    return {
      id: Number(row.id),
      title: row.title,
      artist: row.artist,
      albumArtist: row.album_artist,
      displayArtist: albumArtist || firstArtist || 'Unknown Artist',
      album: row.album,
      path: row.path,
      ext: row.ext,
      durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
      genre: row.genre,
      mood: row.mood,
      country: row.country,
      year: row.year == null ? null : Number(row.year),
      bpm: row.bpm == null ? null : Number(row.bpm),
      playCount: Number(row.play_count || 0),
      skipCount: Number(row.skip_count || 0),
      lastPlayedAt: row.last_played_at,
      isFavorite: Boolean(row.is_favorite),
    };
  });
}

function openRouterError(status: number): { status: number; message: string } {
  switch (status) {
    case 401:
      return { status: 400, message: 'The OpenRouter API key is invalid. Update it in Settings → Integrations.' };
    case 402:
      return { status: 402, message: 'The OpenRouter account does not have enough credit for this request.' };
    case 429:
      return { status: 429, message: 'OpenRouter is rate limiting requests. Please try again shortly.' };
    case 503:
      return { status: 503, message: 'No compatible OpenRouter provider is currently available.' };
    default:
      return { status: 502, message: 'OpenRouter could not interpret the music request.' };
  }
}

async function requestMusicIntent(apiKey: string, model: string, query: string, signal: AbortSignal): Promise<MusicIntent> {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'MVBar AI Music',
    },
    signal,
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 2_000,
      provider: {
        require_parameters: true,
        data_collection: 'deny',
      },
      messages: [
        {
          role: 'system',
          content: [
            'You are a music programming engine, not a chat assistant.',
            'Use accurate music knowledge to translate the request into attributes that can rank tracks in a local library.',
            'Understand abstract concepts such as soft, warm, dark, dreamy, romantic, focused or energetic.',
            'Never merely copy an abstract adjective into textQuery. Expand it into real mood tags, genres, energy and BPM.',
            'Keep primary genres narrow and exact. Put plausible neighbouring styles in relatedGenres; do not flatten a request into a broad family like rock.',
            'Use canonical country names for artist provenance. British means United Kingdom and covers England, Scotland, Wales and Northern Ireland.',
            'countryMode is strict only when the user says only/exclusively; use prefer for a nationality adjective, otherwise any.',
            'namedArtists contains artists the user explicitly wants to hear. similarToArtists contains explicit similarity seeds.',
            'referenceArtists may contain up to eight well-established representatives of a broad scene when this materially improves identification.',
            'Never invent an artist. Leave all artist arrays empty when uncertain.',
            'textQuery contains only an explicitly named song or album not represented elsewhere; otherwise it is empty.',
            'Set includeSimilar when the user says similar, related, adjacent, in the vein of, or equivalent wording.',
            'Choose action play for requests such as play, put on, start or give me; queue for add/queue; search otherwise.',
            'For "play soft music", use low energy, roughly 50-105 BPM, moods such as gentle/calm/mellow/soothing,',
            'genres such as ambient/acoustic/downtempo/folk/classical/smooth jazz, and avoid aggressive genres.',
            'For "play British grunge and similar", use grunge as the primary genre; post-grunge, alternative rock, noise rock,',
            'garage rock and sludge rock as related genres; United Kingdom with prefer mode; includeSimilar true; and only factual UK scene references.',
            'Return 20-30 tracks by default and explain the musical interpretation briefly.',
          ].join(' '),
        },
        { role: 'user', content: query },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'mvbar_music_intent',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['play', 'queue', 'search'] },
              textQuery: { type: 'string', description: 'Only named artist, title or album text, otherwise empty.' },
              searchQuery: { type: 'string', description: 'Concise fallback query for normal MVBar search.' },
              moods: { type: 'array', items: { type: 'string' }, maxItems: 12 },
              genres: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Narrow primary genre tags.' },
              relatedGenres: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'Close musical neighbours, ordered by relevance.' },
              countries: { type: 'array', items: { type: 'string' }, maxItems: 6, description: 'Canonical artist-origin countries.' },
              countryMode: { type: 'string', enum: ['strict', 'prefer', 'any'] },
              yearStart: { type: ['number', 'null'] },
              yearEnd: { type: ['number', 'null'] },
              namedArtists: { type: 'array', items: { type: 'string' }, maxItems: 10 },
              similarToArtists: { type: 'array', items: { type: 'string' }, maxItems: 6 },
              referenceArtists: { type: 'array', items: { type: 'string' }, maxItems: 8 },
              includeSimilar: { type: 'boolean' },
              avoid: { type: 'array', items: { type: 'string' }, maxItems: 12 },
              energy: { type: 'string', enum: ['low', 'medium', 'high', 'any'] },
              bpmMin: { type: ['number', 'null'] },
              bpmMax: { type: ['number', 'null'] },
              targetBpm: { type: ['number', 'null'] },
              trackCount: { type: 'number' },
              explanation: { type: 'string' },
            },
            required: [
              'action', 'textQuery', 'searchQuery', 'moods', 'genres', 'relatedGenres',
              'countries', 'countryMode', 'yearStart', 'yearEnd', 'namedArtists',
              'similarToArtists', 'referenceArtists', 'includeSimilar', 'avoid',
              'energy', 'bpmMin', 'bpmMax', 'targetBpm', 'trackCount', 'explanation',
            ],
            additionalProperties: false,
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const mapped = openRouterError(response.status);
    throw Object.assign(new Error(mapped.message), { status: mapped.status, retryAfter: response.headers.get('Retry-After') });
  }

  const data = await response.json() as OpenRouterResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw Object.assign(new Error('OpenRouter returned an empty music interpretation.'), { status: 502 });
  return parseMusicIntent(content, query);
}

export const aiPlugin: FastifyPluginAsync = fp(async (app) => {
  app.post('/api/ai/intent', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const rawQuery = (req.body as { query?: unknown } | null)?.query;
    if (typeof rawQuery !== 'string') {
      return reply.code(400).send({ ok: false, error: 'A music request is required.' });
    }

    const query = cleanText(rawQuery, MAX_QUERY_LENGTH + 1);
    if (!query) return reply.code(400).send({ ok: false, error: 'A music request is required.' });
    if (query.length > MAX_QUERY_LENGTH) {
      return reply.code(400).send({ ok: false, error: `Music requests are limited to ${MAX_QUERY_LENGTH} characters.` });
    }

    const keyResult = await db().query<{ openrouter_api_key: string | null }>(
      'select openrouter_api_key from user_preferences where user_id = $1',
      [req.user.userId]
    );
    const apiKey = keyResult.rows[0]?.openrouter_api_key?.trim();
    if (!apiKey) {
      return reply.code(400).send({
        ok: false,
        error: 'OpenRouter is not configured. Add an API key in Settings → Integrations.',
      });
    }

    if (!consumeRateLimit(req.user.userId)) {
      reply.header('Retry-After', '60');
      return reply.code(429).send({ ok: false, error: 'Too many AI requests. Please wait a minute and try again.' });
    }

    const model = process.env.AI_SEARCH_MODEL?.trim() || DEFAULT_MODEL;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const baseIntent = await requestMusicIntent(apiKey, model, query, controller.signal);
      const [intent, allowed] = await Promise.all([
        enrichSimilarity(baseIntent),
        allowedLibrariesForUser(req.user.userId, req.user.role),
      ]);
      const seed = `${req.user.userId}:${query}:${Date.now()}`;
      const candidates = await loadSemanticCandidates(req.user.userId, allowed, intent, seed);
      const tracks = chooseSemanticTracks(candidates, intent, seed);

      return {
        ok: true,
        model,
        originalQuery: query,
        action: intent.action,
        searchQuery: intent.searchQuery,
        explanation: intent.explanation,
        interpretation: {
          moods: intent.moods,
          genres: intent.genres,
          relatedGenres: intent.relatedGenres,
          countries: intent.countries,
          countryMode: intent.countryMode,
          yearStart: intent.yearStart,
          yearEnd: intent.yearEnd,
          namedArtists: intent.namedArtists,
          similarToArtists: intent.similarToArtists,
          referenceArtists: intent.referenceArtists,
          similarArtists: intent.similarArtists,
          includeSimilar: intent.includeSimilar,
          avoid: intent.avoid,
          energy: intent.energy,
          bpmMin: intent.bpmMin,
          bpmMax: intent.bpmMax,
          targetBpm: intent.targetBpm,
        },
        tracks,
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return reply.code(504).send({ ok: false, error: 'The AI music request timed out.' });
      }

      const status = error instanceof Error && 'status' in error ? Number((error as Error & { status: number }).status) : 502;
      const retryAfter = error instanceof Error && 'retryAfter' in error
        ? (error as Error & { retryAfter?: string | null }).retryAfter
        : null;
      if (retryAfter) reply.header('Retry-After', retryAfter);
      if (status >= 500) app.log.error({ err: error }, 'AI music request failed');
      return reply.code(status).send({
        ok: false,
        error: error instanceof Error ? error.message : 'The AI music service could not be reached.',
      });
    } finally {
      clearTimeout(timeout);
    }
  });
});
