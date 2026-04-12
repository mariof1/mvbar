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
    // separatorTokens requires Meilisearch >= 1.6; skip for v1.x compat.
    // The *_clean fields already strip punctuation, so queries still match.
    pagination: { maxTotalHits: 5000 },
  });
}

const TRACK_COLS = `id, library_id, path, ext, title, artist, album_artist, album, duration_ms, genre, country, year, language, composer, mood, bpm, initial_key`;

type TrackRow = {
  id: number; library_id: number; path: string; ext: string;
  title: string | null; artist: string | null; album_artist: string | null;
  album: string | null; duration_ms: number | null; genre: string | null;
  country: string | null; year: number | null; language: string | null;
  composer: string | null; mood: string | null; bpm: number | null;
  initial_key: string | null;
};

function rowToDoc(row: TrackRow): TrackDoc {
  return {
    ...row,
    title_ascii: row.title ? asciiFold(row.title) : null,
    artist_ascii: row.artist ? asciiFold(row.artist) : null,
    album_artist_ascii: row.album_artist ? asciiFold(row.album_artist) : null,
    album_ascii: row.album ? asciiFold(row.album) : null,
    title_clean: row.title ? stripPunctuation(asciiFold(row.title)) : null,
    artist_clean: row.artist ? stripPunctuation(asciiFold(row.artist)) : null,
    album_artist_clean: row.album_artist ? stripPunctuation(asciiFold(row.album_artist)) : null,
    album_clean: row.album ? stripPunctuation(asciiFold(row.album)) : null,
  };
}

/**
 * Incremental index: only upsert the given track IDs and remove deleted ones.
 * Falls back to full re-index when changedIds is empty or not provided.
 */
export async function indexChangedTracks(
  changedIds: number[],
  deletedIds: number[]
): Promise<{ indexed: number; deleted: number }> {
  const client = meili();
  const index = client.index('tracks');

  let indexed = 0;
  if (changedIds.length > 0) {
    const r = await db().query<TrackRow>(
      `SELECT ${TRACK_COLS} FROM active_tracks WHERE id = ANY($1)`,
      [changedIds]
    );
    const docs = r.rows.map(rowToDoc);
    if (docs.length > 0) {
      await index.addDocuments(docs);
      indexed = docs.length;
    }
  }

  let deleted = 0;
  if (deletedIds.length > 0) {
    await index.deleteDocuments(deletedIds);
    deleted = deletedIds.length;
  }

  return { indexed, deleted };
}

/**
 * Full re-index of all tracks. Used for force scans or initial index.
 */
export async function indexAllTracks() {
  const r = await db().query<TrackRow>(
    `SELECT ${TRACK_COLS} FROM active_tracks`
  );

  const docs: TrackDoc[] = r.rows.map(rowToDoc);
  
  const client = meili();
  const index = client.index('tracks');
  if (docs.length === 0) {
    await index.deleteAllDocuments();
    return { indexed: 0 };
  }

  // Upsert in batches so Meilisearch doesn't choke on huge payloads
  const BATCH = 5000;
  for (let i = 0; i < docs.length; i += BATCH) {
    await index.addDocuments(docs.slice(i, i + BATCH));
  }

  // Prune stale documents only when the indexed count exceeds what the DB has.
  const stats = await index.getStats();
  if (stats.numberOfDocuments > docs.length) {
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
  }

  return { indexed: docs.length };
}
