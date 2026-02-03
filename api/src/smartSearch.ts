import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { meili } from './meili.js';
import { db } from './db.js';
import { allowedLibrariesForUser } from './access.js';

// ============================================================================
// GENRE TAXONOMY (shared with recommendations)
// ============================================================================

const GENRE_FAMILIES: { key: string; label: string; tokens: string[] }[] = [
  { key: 'rock', label: 'Rock', tokens: ['rock', 'hard rock', 'classic rock', 'alternative', 'alternative rock', 'indie rock', 'punk', 'punk rock', 'post-punk', 'grunge', 'garage rock', 'glam rock', 'southern rock', 'psychedelic rock', 'progressive rock', 'prog rock', 'post-rock', 'stoner rock', 'art rock', 'britrock'] },
  { key: 'metal', label: 'Metal', tokens: ['metal', 'heavy metal', 'thrash metal', 'death metal', 'black metal', 'doom metal', 'metalcore', 'hardcore', 'nu metal', 'progressive metal', 'power metal', 'symphonic metal', 'gothic metal', 'industrial metal', 'sludge metal', 'groove metal', 'speed metal', 'deathcore', 'djent'] },
  { key: 'pop', label: 'Pop', tokens: ['pop', 'dance pop', 'synthpop', 'synth pop', 'electropop', 'electro pop', 'indie pop', 'power pop', 'k-pop', 'kpop', 'j-pop', 'jpop', 'britpop', 'teen pop', 'art pop', 'chamber pop', 'dream pop', 'noise pop', 'baroque pop', 'city pop'] },
  { key: 'electronic', label: 'Electronic', tokens: ['dance', 'club', 'edm', 'electronic', 'electronica', 'electro', 'electro house', 'house', 'deep house', 'progressive house', 'tech house', 'techno', 'trance', 'psytrance', 'hardstyle', 'breakbeat', 'breaks', 'dubstep', 'drum and bass', 'dnb', 'd&b', 'jungle', 'uk garage', 'future bass', 'bass music', 'glitch', 'big beat'] },
  { key: 'chill', label: 'Chill & Ambient', tokens: ['ambient', 'chill', 'chillout', 'chill out', 'chillwave', 'downtempo', 'lofi', 'lo-fi', 'lo fi', 'trip hop', 'trip-hop', 'idm', 'new age', 'meditation', 'relaxation', 'drone', 'dark ambient', 'space ambient', 'atmospheric'] },
  { key: 'synthwave', label: 'Synthwave & Retro', tokens: ['synthwave', 'retrowave', 'outrun', 'darksynth', 'dreamwave', 'vaporwave', 'future funk', 'nu disco', 'disco', 'italo disco', 'eurobeat', '80s', 'new wave', 'synth', 'electro funk'] },
  { key: 'hiphop', label: 'Hip-Hop', tokens: ['hip hop', 'hiphop', 'hip-hop', 'rap', 'trap', 'drill', 'grime', 'boom bap', 'gangsta rap', 'conscious rap', 'underground hip hop', 'southern hip hop', 'west coast hip hop', 'east coast hip hop', 'crunk', 'dirty south', 'cloud rap', 'phonk', 'g-funk'] },
  { key: 'rnb', label: 'R&B & Soul', tokens: ['r&b', 'rb', 'rnb', 'rhythm and blues', 'soul', 'neo soul', 'neo-soul', 'funk', 'motown', 'quiet storm', 'contemporary r&b', 'new jack swing', 'urban contemporary'] },
  { key: 'jazz', label: 'Jazz', tokens: ['jazz', 'smooth jazz', 'bebop', 'swing', 'fusion', 'acid jazz', 'cool jazz', 'free jazz', 'modal jazz', 'hard bop', 'latin jazz', 'jazz fusion', 'nu jazz', 'jazz funk', 'big band', 'dixieland', 'bossa nova'] },
  { key: 'blues', label: 'Blues', tokens: ['blues', 'blues rock', 'electric blues', 'delta blues', 'chicago blues', 'texas blues', 'soul blues'] },
  { key: 'classical', label: 'Classical', tokens: ['classical', 'baroque', 'romantic', 'opera', 'symphony', 'symphonic', 'orchestral', 'orchestra', 'chamber music', 'concerto', 'sonata', 'minimalist', 'contemporary classical', 'neoclassical', 'impressionist', 'piano'] },
  { key: 'soundtrack', label: 'Soundtracks', tokens: ['soundtrack', 'score', 'film score', 'movie soundtrack', 'game soundtrack', 'video game', 'ost', 'cinematic', 'epic', 'trailer music', 'musical', 'broadway', 'anime'] },
  { key: 'country', label: 'Country', tokens: ['country', 'country rock', 'alt-country', 'outlaw country', 'country pop', 'honky tonk', 'western', 'americana', 'red dirt', 'texas country', 'bluegrass', 'country folk'] },
  { key: 'folk', label: 'Folk & Acoustic', tokens: ['folk', 'folk rock', 'indie folk', 'contemporary folk', 'traditional folk', 'celtic', 'irish', 'scottish', 'singer songwriter', 'singer-songwriter', 'acoustic', 'unplugged', 'fingerstyle'] },
  { key: 'latin', label: 'Latin', tokens: ['latin', 'reggaeton', 'salsa', 'bachata', 'cumbia', 'latin pop', 'latin rock', 'merengue', 'tango', 'samba', 'tropicalia', 'mariachi', 'urbano', 'dembow', 'latin trap'] },
  { key: 'reggae', label: 'Reggae & Caribbean', tokens: ['reggae', 'ska', 'dub', 'dancehall', 'roots reggae', 'lovers rock', 'rocksteady', 'ragga', 'soca', 'calypso'] },
  { key: 'world', label: 'World Music', tokens: ['world', 'world music', 'african', 'afrobeat', 'afropop', 'afrobeats', 'middle eastern', 'arabic', 'indian', 'bollywood', 'asian', 'flamenco', 'fado', 'chanson', 'balkan', 'klezmer', 'gypsy'] },
  { key: 'punk', label: 'Punk', tokens: ['punk', 'punk rock', 'pop punk', 'skate punk', 'hardcore punk', 'emo', 'screamo', 'post-hardcore', 'melodic hardcore', 'street punk', 'oi'] },
  { key: 'indie', label: 'Indie', tokens: ['indie', 'indie rock', 'indie pop', 'indie folk', 'indie electronic', 'lo-fi indie', 'bedroom pop', 'shoegaze', 'dream pop', 'slowcore', 'sadcore'] },
  { key: 'gospel', label: 'Gospel & Christian', tokens: ['gospel', 'christian', 'christian rock', 'worship', 'ccm', 'contemporary christian', 'praise', 'spiritual'] },
];

// Build lookup maps
const tokenToFamily = new Map<string, { key: string; label: string; tokens: string[] }>();
for (const fam of GENRE_FAMILIES) {
  for (const t of fam.tokens) {
    tokenToFamily.set(t.toLowerCase().trim(), fam);
  }
}

// Country name normalization
const COUNTRY_ALIASES: Record<string, string> = {
  'usa': 'USA', 'us': 'USA', 'united states': 'USA', 'america': 'USA',
  'uk': 'United Kingdom', 'england': 'United Kingdom', 'britain': 'United Kingdom', 'great britain': 'United Kingdom',
  'pl': 'Poland', 'polska': 'Poland',
  'de': 'Germany', 'deutschland': 'Germany',
  'fr': 'France', 'french': 'France',
  'es': 'Spain', 'spanish': 'Spain', 'españa': 'Spain',
  'it': 'Italy', 'italian': 'Italy', 'italia': 'Italy',
  'jp': 'Japan', 'japanese': 'Japan', 'nippon': 'Japan',
  'kr': 'South Korea', 'korean': 'South Korea', 'korea': 'South Korea',
  'br': 'Brazil', 'brazilian': 'Brazil', 'brasil': 'Brazil',
  'ru': 'Russia', 'russian': 'Russia',
  'nl': 'Netherlands', 'dutch': 'Netherlands', 'holland': 'Netherlands',
  'se': 'Sweden', 'swedish': 'Sweden',
  'no': 'Norway', 'norwegian': 'Norway',
  'au': 'Australia', 'australian': 'Australia',
  'ca': 'Canada', 'canadian': 'Canada',
  'mx': 'Mexico', 'mexican': 'Mexico',
  'jamaican': 'Jamaica', 'jamaika': 'Jamaica',
  'polish': 'Poland', 'polskie': 'Poland', 'polski': 'Poland',
  'german': 'Germany',
  'irish': 'Ireland', 'scottish': 'Scotland', 'welsh': 'Wales',
  'african': 'African', 'asian': 'Asian', 'latin': 'Latin',
};

// Decade patterns
const DECADE_PATTERNS: { pattern: RegExp; start: number; end: number; label: string }[] = [
  { pattern: /\b50s\b|\bfifties\b|\b1950s?\b/i, start: 1950, end: 1959, label: '50s' },
  { pattern: /\b60s\b|\bsixties\b|\b1960s?\b/i, start: 1960, end: 1969, label: '60s' },
  { pattern: /\b70s\b|\bseventies\b|\b1970s?\b/i, start: 1970, end: 1979, label: '70s' },
  { pattern: /\b80s\b|\beighties\b|\b1980s?\b/i, start: 1980, end: 1989, label: '80s' },
  { pattern: /\b90s\b|\bnineties\b|\b1990s?\b/i, start: 1990, end: 1999, label: '90s' },
  { pattern: /\b2000s\b|\bzeroes\b|\bnoughties\b/i, start: 2000, end: 2009, label: '2000s' },
  { pattern: /\b2010s\b|\btens\b/i, start: 2010, end: 2019, label: '2010s' },
  { pattern: /\b2020s\b|\btwenties\b/i, start: 2020, end: 2029, label: '2020s' },
];

// ============================================================================
// QUERY PARSER
// ============================================================================

interface ParsedQuery {
  textQuery: string;           // Remaining text to search
  genres: string[];            // Detected genre tokens
  genreFamily: string | null;  // Genre family key if detected
  country: string | null;      // Detected country
  yearStart: number | null;    // Year range start
  yearEnd: number | null;      // Year range end
  decade: string | null;       // Decade label
}

function parseQuery(q: string): ParsedQuery {
  let textQuery = q.trim().toLowerCase();
  const result: ParsedQuery = {
    textQuery: q.trim(),
    genres: [],
    genreFamily: null,
    country: null,
    yearStart: null,
    yearEnd: null,
    decade: null,
  };

  // Check for decade
  for (const dec of DECADE_PATTERNS) {
    if (dec.pattern.test(textQuery)) {
      result.yearStart = dec.start;
      result.yearEnd = dec.end;
      result.decade = dec.label;
      textQuery = textQuery.replace(dec.pattern, '').trim();
      break;
    }
  }

  // Check for specific year
  const yearMatch = textQuery.match(/\b(19[5-9]\d|20[0-2]\d)\b/);
  if (yearMatch && !result.yearStart) {
    const year = parseInt(yearMatch[1]);
    result.yearStart = year;
    result.yearEnd = year;
    // Remove the year token so a "year-only" query can use filters with an empty Meili query
    textQuery = textQuery.replace(new RegExp(`\\b${yearMatch[1]}\\b`), '').trim();
  }

  // Check for country (with aliases)
  const words = textQuery.split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    // Try 2-word combos first
    if (i < words.length - 1) {
      const twoWord = `${words[i]} ${words[i + 1]}`.toLowerCase();
      if (COUNTRY_ALIASES[twoWord]) {
        result.country = COUNTRY_ALIASES[twoWord];
        textQuery = textQuery.replace(new RegExp(`\\b${words[i]}\\s+${words[i + 1]}\\b`, 'i'), '').trim();
      }
    }
    // Single word
    const normalized = COUNTRY_ALIASES[words[i].toLowerCase()];
    if (normalized && !result.country) {
      result.country = normalized;
      textQuery = textQuery.replace(new RegExp(`\\b${words[i]}\\b`, 'i'), '').trim();
    }
  }

  // Check for genre family keywords
  const remainingWords = textQuery.split(/\s+/).filter(w => w.length > 0);
  for (const word of remainingWords) {
    const family = tokenToFamily.get(word);
    if (family) {
      result.genreFamily = family.key;
      result.genres = family.tokens;
      // Don't remove from textQuery - let MeiliSearch also match it
      break;
    }
  }

  // Try multi-word genre matches
  if (!result.genreFamily) {
    for (const [token, family] of tokenToFamily.entries()) {
      if (token.includes(' ') && textQuery.includes(token)) {
        result.genreFamily = family.key;
        result.genres = family.tokens;
        break;
      }
    }
  }

  result.textQuery = textQuery.replace(/\s+/g, ' ').trim();
  return result;
}

// ============================================================================
// PERSONALIZATION SCORING
// ============================================================================

interface UserData {
  playStats: Map<number, { playCount: number; skipCount: number; lastPlayed: Date | null }>;
  favorites: Set<number>;
  playlistTrackIds: Set<number>;
  recentSearchArtists: Set<string>;
  recentSearchAlbums: Set<string>;
}

async function loadUserData(userId: string): Promise<UserData> {
  // Play stats
  const statsR = await db().query<{ track_id: number; play_count: number; skip_count: number; last_played_at: Date | null }>(
    `SELECT track_id, play_count, skip_count, last_played_at FROM user_track_stats WHERE user_id = $1`,
    [userId]
  );
  const playStats = new Map<number, { playCount: number; skipCount: number; lastPlayed: Date | null }>();
  for (const r of statsR.rows) {
    playStats.set(r.track_id, { playCount: r.play_count, skipCount: r.skip_count, lastPlayed: r.last_played_at });
  }

  // Favorites
  const favR = await db().query<{ track_id: number }>(`SELECT track_id FROM favorite_tracks WHERE user_id = $1`, [userId]);
  const favorites = new Set(favR.rows.map(r => r.track_id));

  // Playlist tracks
  const plR = await db().query<{ track_id: number }>(
    `SELECT pi.track_id FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id WHERE p.user_id = $1`,
    [userId]
  );
  const playlistTrackIds = new Set(plR.rows.map(r => r.track_id));

  // Recent search context (artists/albums searched for in past hour)
  const searchR = await db().query<{ query: string }>(
    `SELECT query FROM search_logs WHERE user_id = $1 AND created_at > now() - interval '1 hour' ORDER BY created_at DESC LIMIT 10`,
    [userId]
  );
  const recentSearchArtists = new Set<string>();
  const recentSearchAlbums = new Set<string>();
  for (const r of searchR.rows) {
    recentSearchArtists.add(r.query.toLowerCase());
    recentSearchAlbums.add(r.query.toLowerCase());
  }

  return { playStats, favorites, playlistTrackIds, recentSearchArtists, recentSearchAlbums };
}

function personalizeScore(trackId: number, artist: string | null, userData: UserData): number {
  let score = 0;
  
  const stats = userData.playStats.get(trackId);
  if (stats) {
    // Play count boost (logarithmic)
    score += Math.log2(stats.playCount + 1) * 15;
    
    // Skip penalty
    if (stats.playCount > 0) {
      const skipRatio = stats.skipCount / (stats.playCount + stats.skipCount);
      if (skipRatio > 0.5) score -= 20;
      else if (skipRatio > 0.3) score -= 10;
    }
    
    // Recent play boost
    if (stats.lastPlayed) {
      const daysSince = (Date.now() - new Date(stats.lastPlayed).getTime()) / 86400000;
      if (daysSince < 7) score += 10;
      else if (daysSince < 30) score += 5;
    }
  }

  // Favorite bonus
  if (userData.favorites.has(trackId)) score += 30;

  // Playlist membership bonus
  if (userData.playlistTrackIds.has(trackId)) score += 15;

  // Artist familiarity bonus (if we've played other tracks by this artist)
  if (artist) {
    const artistLower = artist.toLowerCase();
    // Check if artist matches recent searches
    if (userData.recentSearchArtists.has(artistLower)) score += 8;
  }

  return score;
}

// ============================================================================
// SMART SEARCH PLUGIN
// ============================================================================

function normalizeQuery(q: string): string {
  return q.toLowerCase().trim().replace(/\s+/g, ' ').replace(/['"]/g, '');
}

export const smartSearchPlugin: FastifyPluginAsync = fp(async (app) => {
  app.get('/api/search', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });

    const q = (req.query as { q?: string }).q ?? '';
    const limit = Math.min(100, Math.max(1, Number((req.query as { limit?: string }).limit ?? 30)));
    const offset = Math.max(0, Number((req.query as { offset?: string }).offset ?? 0));
    const userId = req.user.userId;

    if (q.trim().length === 0) {
      return { ok: true, q, limit, offset, hits: [], estimatedTotalHits: 0, artists: [], albums: [], playlists: [] };
    }

    const index = meili().index('tracks');
    const allowed = await allowedLibrariesForUser(userId, req.user.role);

    // Parse query for smart matching
    const parsed = parseQuery(q);

    // If the remaining text is just a genre keyword (e.g. "polish rap" -> country=Poland, genre=hiphop, textQuery="rap"),
    // treat it as filter-only for entity search so we can return top matching artists/albums.
    const entityTextQuery = (() => {
      const t = parsed.textQuery.toLowerCase().trim();
      if (!t) return '';
      if (parsed.genreFamily && parsed.genres.some(g => g.toLowerCase() === t)) return '';
      return parsed.textQuery;
    })();

    // Build MeiliSearch filter - only use library_id initially (always filterable)
    const libraryFilter = allowed !== null
      ? `library_id IN [${allowed.map(x => String(Number(x))).join(', ')}]`
      : undefined;

    // Advanced filters (may not be available until reindex)
    const advancedFilters: string[] = [];
    if (parsed.country) {
      advancedFilters.push(`country = "${parsed.country}"`);
    }
    if (parsed.yearStart && parsed.yearEnd) {
      if (parsed.yearStart === parsed.yearEnd) {
        advancedFilters.push(`year = ${parsed.yearStart}`);
      } else {
        advancedFilters.push(`year >= ${parsed.yearStart} AND year <= ${parsed.yearEnd}`);
      }
    }

    const hasEntityFilters = Boolean(parsed.country || parsed.yearStart || parsed.genreFamily);

    try {
      // Get more results for re-ranking
      const fetchLimit = Math.min(200, limit * 4);

      // Try with advanced filters first, fall back to basic if not available
      let res: any;
      const fullFilter = [libraryFilter, ...advancedFilters].filter(Boolean).join(' AND ') || undefined;

      try {
        res = await index.search(parsed.textQuery, {
          limit: fetchLimit,
          offset: 0,
          filter: fullFilter,
          attributesToRetrieve: ['id', 'path', 'ext', 'title', 'artist', 'album_artist', 'album', 'duration_ms', 'library_id', 'genre', 'country', 'year']
        });
      } catch (filterErr: any) {
        // If filter attribute not available, retry with just library filter
        if (filterErr.message?.includes('not filterable')) {
          res = await index.search(parsed.textQuery || q, {
            limit: fetchLimit,
            offset: 0,
            filter: libraryFilter,
            attributesToRetrieve: ['id', 'path', 'ext', 'title', 'artist', 'album_artist', 'album', 'duration_ms', 'library_id', 'genre', 'country', 'year']
          });
        } else {
          throw filterErr;
        }
      }

      // Normalize Meili hits (IDs sometimes come back as strings)
      for (const hit of res.hits) {
        hit.id = Number(hit.id);
        const albumArtist = hit.album_artist?.split(/[;|]/)[0]?.trim();
        const firstArtist = hit.artist?.split(/[;|]/)[0]?.trim();
        hit.display_artist = albumArtist || firstArtist || 'Unknown Artist';
      }

      // Load user data for personalization
      const userData = await loadUserData(userId);

      // Score and re-rank results
      interface ScoredHit {
        hit: any;
        personalScore: number;
        meiliRank: number;
        genreBoost: number;
        combinedScore: number;
      }

      const scoredHits: ScoredHit[] = res.hits.map((hit: any, idx: number) => {
        const personalScore = personalizeScore(hit.id, hit.artist, userData);
        const meiliRank = fetchLimit - idx; // Higher = better rank

        // Genre family match boost
        let genreBoost = 0;
        if (parsed.genreFamily && hit.genre) {
          const hitGenres = (hit.genre as string).toLowerCase().split(/[;,]/).map((g: string) => g.trim());
          for (const g of hitGenres) {
            const family = tokenToFamily.get(g);
            if (family && family.key === parsed.genreFamily) {
              genreBoost = 20;
              break;
            }
          }
        }

        // Combined score: personalization matters most for ties
        const combinedScore = (meiliRank * 0.5) + (personalScore * 2) + genreBoost;

        return { hit, personalScore, meiliRank, genreBoost, combinedScore };
      });

      // Sort by combined score
      scoredHits.sort((a, b) => b.combinedScore - a.combinedScore);

      // Apply pagination
      const paginatedHits = scoredHits.slice(offset, offset + limit).map(s => s.hit);

      // Entity search (artists/albums/playlists) - first page only
      const wantEntities = offset === 0 && (entityTextQuery.length > 0 || hasEntityFilters);
      const artists: any[] = [];
      const albums: any[] = [];
      const playlists: any[] = [];

      if (wantEntities) {
        // Artists
        {
          const params: any[] = [];
          let i = 1;
          const where: string[] = ["a.name is not null and a.name <> ''", "ta.role = 'artist'"];

          if (entityTextQuery.length > 0) {
            params.push(`%${entityTextQuery.toLowerCase()}%`);
            where.push(`lower(a.name) like $${i++}`);
          }
          if (allowed !== null) {
            params.push(allowed);
            where.push(`t.library_id = any($${i++})`);
          }
          if (parsed.country) {
            params.push(parsed.country);
            where.push(`exists (select 1 from unnest(string_to_array(coalesce(t.country, ''), ';')) as c where lower(trim(c)) = lower($${i++}))`);
          }
          if (parsed.yearStart && parsed.yearEnd) {
            if (parsed.yearStart === parsed.yearEnd) {
              params.push(parsed.yearStart);
              where.push(`t.year = $${i++}`);
            } else {
              params.push(parsed.yearStart, parsed.yearEnd);
              where.push(`t.year >= $${i++} and t.year <= $${i++}`);
            }
          }
          if (parsed.genreFamily && parsed.genres.length > 0) {
            params.push(parsed.genres);
            where.push(`exists (select 1 from unnest(string_to_array(coalesce(t.genre, ''), ';')) as g where lower(trim(g)) = any($${i++}))`);
          }

          const orderBy = entityTextQuery.length > 0
            ? `case
                 when lower(a.name) = $1 then 0
                 when lower(a.name) like $1 then 1
                 when lower(a.name) like replace($1, '%', '') || '%' then 2
                 else 3
               end, track_count desc, a.name asc`
            : 'track_count desc, a.name asc';

          const r = await db().query(
            `
            select
              a.id::int,
              a.name,
              a.art_path,
              a.art_hash,
              count(distinct t.id)::int as track_count,
              count(distinct nullif(t.album, ''))::int as album_count
            from artists a
            join track_artists ta on ta.artist_id = a.id
            join active_tracks t on t.id = ta.track_id
            where ${where.join(' and ')}
            group by a.id, a.name, a.art_path, a.art_hash
            order by ${orderBy}
            limit 12
          `,
            params as any
          );
          artists.push(...r.rows);
        }

        // Albums
        {
          const params: any[] = [];
          let i = 1;
          const where: string[] = ["t.album is not null and t.album <> ''"];

          if (entityTextQuery.length > 0) {
            params.push(`%${entityTextQuery.toLowerCase()}%`);
            where.push(`(lower(t.album) like $${i} or lower(coalesce(t.album_artist, t.artist)) like $${i})`);
            i++;
          }
          if (allowed !== null) {
            params.push(allowed);
            where.push(`t.library_id = any($${i++})`);
          }
          if (parsed.country) {
            params.push(parsed.country);
            where.push(`exists (select 1 from unnest(string_to_array(coalesce(t.country, ''), ';')) as c where lower(trim(c)) = lower($${i++}))`);
          }
          if (parsed.yearStart && parsed.yearEnd) {
            if (parsed.yearStart === parsed.yearEnd) {
              params.push(parsed.yearStart);
              where.push(`t.year = $${i++}`);
            } else {
              params.push(parsed.yearStart, parsed.yearEnd);
              where.push(`t.year >= $${i++} and t.year <= $${i++}`);
            }
          }
          if (parsed.genreFamily && parsed.genres.length > 0) {
            params.push(parsed.genres);
            where.push(`exists (select 1 from unnest(string_to_array(coalesce(t.genre, ''), ';')) as g where lower(trim(g)) = any($${i++}))`);
          }

          const r = await db().query(
            `
            with unique_albums as (
              select distinct on (t.album)
                t.album,
                t.id as first_track_id,
                t.art_path,
                t.art_hash
              from active_tracks t
              where ${where.join(' and ')}
              order by t.album, (t.art_path is null) asc, t.path
            ),
            album_counts as (
              select t.album, count(*)::int as track_count
              from active_tracks t
              where ${where.join(' and ')}
              group by t.album
            )
            select
              ua.album,
              coalesce(
                (select a.name from track_artists ta join artists a on a.id = ta.artist_id
                 where ta.track_id = ua.first_track_id and ta.role = 'albumartist'
                 order by ta.position asc, a.name asc limit 1),
                (select a.name from track_artists ta join artists a on a.id = ta.artist_id
                 where ta.track_id = ua.first_track_id and ta.role = 'artist'
                 order by ta.position asc, a.name asc limit 1)
              ) as display_artist,
              (select ta.artist_id::int from track_artists ta
               where ta.track_id = ua.first_track_id and ta.role = 'albumartist'
               order by ta.position asc limit 1) as artist_id,
              ua.first_track_id::int as art_track_id,
              ua.art_path,
              ua.art_hash,
              ac.track_count
            from unique_albums ua
            join album_counts ac on ac.album = ua.album
            order by ac.track_count desc, ua.album asc
            limit 12
          `,
            params as any
          );
          albums.push(...r.rows);
        }

        // Playlists (name match only)
        if (entityTextQuery.length > 0) {
          const pat = `%${entityTextQuery.toLowerCase()}%`;
          const r = await db().query(
            `select id::int, name, created_at from playlists where user_id = $1 and lower(name) like $2 order by id desc limit 12`,
            [userId, pat]
          );
          playlists.push(...r.rows.map((x: any) => ({ ...x, kind: 'playlist' })));

          const r2 = await db().query(
            `select id::int, name, updated_at from smart_playlists where user_id = $1 and lower(name) like $2 order by updated_at desc limit 12`,
            [userId, pat]
          );
          playlists.push(...r2.rows.map((x: any) => ({ ...x, kind: 'smart' })));
        }
      }

      // Log search for recommendations (only meaningful queries)
      const normalized = normalizeQuery(q);
      if (normalized.length >= 3 && offset === 0) {
        const recent = await db().query<{ query_normalized: string }>(
          `SELECT query_normalized FROM search_logs 
           WHERE user_id = $1 AND created_at > now() - interval '5 minutes'
           ORDER BY created_at DESC LIMIT 5`,
          [userId]
        );
        const isPrefix = recent.rows.some(r =>
          r.query_normalized.startsWith(normalized) && r.query_normalized.length > normalized.length
        );

        if (!isPrefix) {
          await db().query(
            `INSERT INTO search_logs(user_id, query, query_normalized, result_count) VALUES ($1, $2, $3, $4)`,
            [userId, q.trim(), normalized, res.estimatedTotalHits || 0]
          );
        }
      }

      return {
        ok: true,
        q,
        limit,
        offset,
        hits: paginatedHits,
        estimatedTotalHits: res.estimatedTotalHits,
        artists,
        albums,
        playlists,
        parsed: {
          genreFamily: parsed.genreFamily,
          country: parsed.country,
          decade: parsed.decade,
          yearRange: parsed.yearStart ? [parsed.yearStart, parsed.yearEnd] : null
        }
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('Index `tracks` not found')) {
        return { ok: true, q, limit, offset, hits: [], estimatedTotalHits: 0, artists: [], albums: [], playlists: [] };
      }
      throw e;
    }
  });
});
