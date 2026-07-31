import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import { allowedLibrariesForUser } from './access.js';
import { db } from './db.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'google/gemini-2.5-flash-lite';
const MAX_QUERY_LENGTH = 500;
const MAX_REQUESTS_PER_MINUTE = 10;
const MAX_CANDIDATES = 1_200;

export type MusicIntentAction = 'play' | 'queue' | 'search';
export type MusicEnergy = 'low' | 'medium' | 'high' | 'any';

export type MusicIntent = {
  action: MusicIntentAction;
  textQuery: string;
  searchQuery: string;
  moods: string[];
  genres: string[];
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
    'find', 'show me', 'search for', 'look for', 'music', 'songs', 'tracks',
    'something', 'some', 'please', 'for me', 'kind of', 'a bit of',
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

  const textQuery = textQueryWithoutFiller(query, semanticWords);
  const searchQuery = cleanText([textQuery, genres[0] || moods[0]].filter(Boolean).join(' '), 200) || cleanText(query, 200);

  return {
    action: inferAction(query),
    textQuery,
    searchQuery,
    moods,
    genres,
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
    const textQuery = cleanText(typeof parsed.textQuery === 'string' ? parsed.textQuery : fallback.textQuery, 160);
    const moods = normalizedTerms(parsed.moods);
    const genres = normalizedTerms(parsed.genres);
    const searchQuery = cleanText(
      typeof parsed.searchQuery === 'string' ? parsed.searchQuery : [textQuery, genres[0], moods[0]].filter(Boolean).join(' '),
      200
    ) || fallback.searchQuery;
    const trackCountRaw = Number(parsed.trackCount);

    return applyEnergyDefaults({
      action,
      textQuery,
      searchQuery,
      moods: moods.length > 0 ? moods : fallback.moods,
      genres: genres.length > 0 ? genres : fallback.genres,
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

function featureText(...values: Array<string | null>): string {
  return values.filter(Boolean).join(' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function termMatches(text: string, term: string): boolean {
  return text.includes(term.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
}

export function scoreSemanticCandidate(candidate: SemanticCandidate, intent: MusicIntent, now = Date.now()): number {
  const genre = featureText(candidate.genre);
  const mood = featureText(candidate.mood);
  const identity = featureText(candidate.title, candidate.artist, candidate.album);
  const allMetadata = `${genre} ${mood} ${identity}`;
  let score = 0;

  for (const term of intent.moods) {
    if (termMatches(mood, term)) score += 16;
    else if (termMatches(genre, term)) score += 6;
  }
  for (const term of intent.genres) {
    if (termMatches(genre, term)) score += 12;
    else if (termMatches(mood, term)) score += 5;
  }
  for (const term of intent.avoid) {
    if (termMatches(allMetadata, term)) score -= 28;
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
  return Array.from(new Set(terms.map((term) => `%${term.replace(/[\\%_]/g, '')}%`).filter((term) => term !== '%%')));
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

  if (allowed !== null) {
    params.push(allowed);
    accessConditions.push(`t.library_id = any($${params.length}::bigint[])`);
  }

  const semanticPatterns = patternsForTerms([...intent.moods, ...intent.genres]);
  if (semanticPatterns.length > 0) {
    params.push(semanticPatterns);
    matchConditions.push(`(
      lower(concat_ws(' ', coalesce(t.genre, ''), coalesce(t.mood, ''))) like any($${params.length}::text[])
      or exists (
        select 1 from track_genres matched_genre
        where matched_genre.track_id = t.id
          and lower(matched_genre.genre) like any($${params.length}::text[])
      )
    )`);
  }

  if (intent.textQuery) {
    const identityTerms = [intent.textQuery, ...intent.textQuery.split(/\s+/).filter((word) => word.length > 1)];
    params.push(patternsForTerms(identityTerms));
    matchConditions.push(`lower(concat_ws(' ', coalesce(t.title, ''), coalesce(t.artist, ''), coalesce(t.album_artist, ''), coalesce(t.album, ''))) like any($${params.length}::text[])`);
  }

  if (intent.bpmMin !== null || intent.bpmMax !== null) {
    if (intent.bpmMin !== null && intent.bpmMax !== null) {
      params.push(intent.bpmMin, intent.bpmMax);
      matchConditions.push(`t.bpm between $${params.length - 1} and $${params.length}`);
    } else if (intent.bpmMin !== null) {
      params.push(intent.bpmMin);
      matchConditions.push(`t.bpm >= $${params.length}`);
    } else if (intent.bpmMax !== null) {
      params.push(intent.bpmMax);
      matchConditions.push(`t.bpm <= $${params.length}`);
    }
  }

  params.push(seed);
  const seedParam = params.length;
  const whereParts = [
    ...accessConditions,
    ...(matchConditions.length > 0 ? [`(${matchConditions.join(' or ')})`] : []),
  ];

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
    bpm: number | null;
    play_count: number;
    skip_count: number;
    last_played_at: Date | null;
    is_favorite: boolean;
  }>(
    `select t.id::int, t.title, t.artist, t.album_artist, t.album, t.path, t.ext, t.duration_ms,
            concat_ws(' ', t.genre, genre_tags.genres) as genre, t.mood, t.bpm,
            coalesce(uts.play_count, 0)::int as play_count,
            coalesce(uts.skip_count, 0)::int as skip_count,
            uts.last_played_at,
            (ft.track_id is not null) as is_favorite
     from active_tracks t
     left join lateral (
       select string_agg(tg.genre, ' ') as genres
       from track_genres tg
       where tg.track_id = t.id
     ) genre_tags on true
     left join user_track_stats uts on uts.track_id = t.id and uts.user_id = $1
     left join favorite_tracks ft on ft.track_id = t.id and ft.user_id = $1
     ${whereParts.length > 0 ? `where ${whereParts.join(' and ')}` : ''}
     order by md5(t.id::text || $${seedParam})
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
      max_tokens: 500,
      provider: {
        require_parameters: true,
        data_collection: 'deny',
      },
      messages: [
        {
          role: 'system',
          content: [
            'You are a music programming engine, not a chat assistant.',
            'Translate the user request into musical attributes that can select tracks from a local library.',
            'Understand abstract concepts such as soft, warm, dark, dreamy, romantic, focused or energetic.',
            'Never merely copy an abstract adjective into textQuery. Expand it into real mood tags, genres, energy and BPM.',
            'textQuery must contain only explicitly named artists, songs or albums; otherwise it must be empty.',
            'Choose action play for requests such as play, put on, start or give me; queue for add/queue; search otherwise.',
            'For "play soft music", use low energy, roughly 50-105 BPM, moods such as gentle/calm/mellow/soothing,',
            'genres such as ambient/acoustic/downtempo/folk/classical/smooth jazz, and avoid aggressive genres.',
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
              genres: { type: 'array', items: { type: 'string' }, maxItems: 12 },
              avoid: { type: 'array', items: { type: 'string' }, maxItems: 12 },
              energy: { type: 'string', enum: ['low', 'medium', 'high', 'any'] },
              bpmMin: { type: ['number', 'null'] },
              bpmMax: { type: ['number', 'null'] },
              targetBpm: { type: ['number', 'null'] },
              trackCount: { type: 'number' },
              explanation: { type: 'string' },
            },
            required: [
              'action', 'textQuery', 'searchQuery', 'moods', 'genres', 'avoid',
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
      const intent = await requestMusicIntent(apiKey, model, query, controller.signal);
      const allowed = await allowedLibrariesForUser(req.user.userId, req.user.role);
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
