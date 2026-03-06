import { meili } from './meili.js';
import { db } from './db.js';
import { asciiFold, stripPunctuation } from './tagRules.js';

export type TrackDoc = {
  id: number;
  library_id: number;
  path: string;
  ext: string;
  title: string | null;
  artist: string | null;
  album_artist: string | null;
  album: string | null;
  duration_ms: number | null;
  genre: string | null;
  country: string | null;
  year: number | null;
  language: string | null;
  // ASCII-folded versions for international search
  title_ascii: string | null;
  artist_ascii: string | null;
  album_artist_ascii: string | null;
  album_ascii: string | null;
  // Punctuation-stripped versions for fuzzy matching (O.S.T.R → OSTR, I'm → Im)
  title_clean: string | null;
  artist_clean: string | null;
  album_artist_clean: string | null;
  album_clean: string | null;
  // Extended metadata
  composer: string | null;
  mood: string | null;
  bpm: number | null;
  initial_key: string | null;
};

export async function ensureTracksIndex() {
  const client = meili();
  try {
    await client.createIndex('tracks', { primaryKey: 'id' });
  } catch {
    // ignore if exists
  }

  const index = client.index('tracks');
  await index.updateSettings({
    searchableAttributes: [
      'title', 'artist', 'album_artist', 'album', 'genre', 'country', 'path',
      'title_ascii', 'artist_ascii', 'album_artist_ascii', 'album_ascii',
      'title_clean', 'artist_clean', 'album_artist_clean', 'album_clean',
      'composer', 'mood'
    ],
    displayedAttributes: [
      'id', 'library_id', 'path', 'ext', 'title', 'artist', 'album_artist', 'album',
      'duration_ms', 'genre', 'country', 'year', 'language', 'composer', 'mood', 'bpm', 'initial_key'
    ],
    filterableAttributes: [
      'library_id', 'artist', 'album_artist', 'album', 'ext', 'genre', 'country', 'year', 'language',
      'composer', 'mood', 'bpm', 'initial_key'
    ],
    sortableAttributes: ['artist', 'album_artist', 'album', 'title', 'year', 'bpm'],
    typoTolerance: {
      minWordSizeForTypos: {
        oneTypo: 3,
        twoTypos: 6,
      },
    },
    separatorTokens: ['.', "'", '\u2019', '-', '/', '\\', '_'],
    pagination: { maxTotalHits: 5000 },
  });
}

export async function indexAllTracks() {
  const r = await db().query<{
    id: number;
    library_id: number;
    path: string;
    ext: string;
    title: string | null;
    artist: string | null;
    album_artist: string | null;
    album: string | null;
    duration_ms: number | null;
    genre: string | null;
    country: string | null;
    year: number | null;
    language: string | null;
    composer: string | null;
    mood: string | null;
    bpm: number | null;
    initial_key: string | null;
  }>(`SELECT id, library_id, path, ext, title, artist, album_artist, album, duration_ms, genre, country, year, language, composer, mood, bpm, initial_key FROM active_tracks`);
  
  // Add ASCII-folded fields for international search
  const docs: TrackDoc[] = r.rows.map(row => ({
    ...row,
    title_ascii: row.title ? asciiFold(row.title) : null,
    artist_ascii: row.artist ? asciiFold(row.artist) : null,
    album_artist_ascii: row.album_artist ? asciiFold(row.album_artist) : null,
    album_ascii: row.album ? asciiFold(row.album) : null,
    title_clean: row.title ? stripPunctuation(asciiFold(row.title)) : null,
    artist_clean: row.artist ? stripPunctuation(asciiFold(row.artist)) : null,
    album_artist_clean: row.album_artist ? stripPunctuation(asciiFold(row.album_artist)) : null,
    album_clean: row.album ? stripPunctuation(asciiFold(row.album)) : null,
  }));
  
  const client = meili();
  const index = client.index('tracks');
  if (docs.length === 0) {
    await index.deleteAllDocuments();
    return { indexed: 0 };
  }

  // Upsert all current tracks first so the index stays searchable
  await index.addDocuments(docs);

  // Remove stale documents that no longer exist in the DB.
  // Small delay to let Meilisearch process the addDocuments task first.
  await new Promise(r => setTimeout(r, 2000));
  const currentIds = new Set(docs.map(d => d.id));
  const staleIds: number[] = [];
  let offset = 0;
  for (;;) {
    const batch = await index.getDocuments({ limit: 1000, offset, fields: ['id'] });
    for (const doc of batch.results) {
      if (!currentIds.has(doc.id as number)) staleIds.push(doc.id as number);
    }
    if (batch.results.length < 1000) break;
    offset += 1000;
  }
  if (staleIds.length > 0) {
    await index.deleteDocuments(staleIds);
  }

  return { indexed: docs.length };
}
