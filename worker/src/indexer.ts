import { meili } from './meili.js';
import { db } from './db.js';
import { asciiFold, stripPunctuation } from './tagRules.js';

const INDEX_TASK_TIMEOUT_MS = Math.max(5000, Number(process.env.MEILI_TASK_TIMEOUT_MS ?? '300000'));
// Bump when rowToDoc or indexed search fields change so startup rebuilds stale documents.
export const TRACK_INDEX_VERSION = 1;

export function meiliErrorCode(error: unknown) {
  if (typeof error !== 'object' || error === null) return '';

  const direct = error as { code?: unknown; errorCode?: unknown; cause?: unknown };
  const directCode = direct.code ?? direct.errorCode;
  if (directCode) return String(directCode);

  if (typeof direct.cause === 'object' && direct.cause !== null) {
    const cause = direct.cause as { code?: unknown; errorCode?: unknown };
    return String(cause.code ?? cause.errorCode ?? '');
  }

  return '';
}

async function waitForTask(
  client: ReturnType<typeof meili>,
  task: { taskUid: number },
  allowedFailureCodes: string[] = []
) {
  const completed = await client.tasks.waitForTask(task.taskUid, {
    timeout: INDEX_TASK_TIMEOUT_MS,
    interval: 100,
  });
  if (completed.status === 'succeeded') return completed;

  const code = meiliErrorCode(completed.error);
  if (allowedFailureCodes.includes(code)) return completed;

  const message = completed.error?.message ?? `Meilisearch task ${completed.uid} ${completed.status}`;
  throw new Error(message);
}

export type TrackDoc = {
  index_version: number;
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
    await client.getIndex('tracks');
  } catch (error) {
    if (meiliErrorCode(error) !== 'index_not_found') throw error;
    const task = await client.createIndex('tracks', { primaryKey: 'id' });
    await waitForTask(client, task);
  }

  const index = client.index('tracks');
  const settingsTask = await index.updateSettings({
    searchableAttributes: [
      'title', 'artist', 'album_artist', 'album', 'genre', 'country', 'path',
      'title_ascii', 'artist_ascii', 'album_artist_ascii', 'album_ascii',
      'title_clean', 'artist_clean', 'album_artist_clean', 'album_clean',
      'composer', 'mood'
    ],
    displayedAttributes: [
      'index_version', 'id', 'library_id', 'path', 'ext', 'title', 'artist', 'album_artist', 'album',
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
  await waitForTask(client, settingsTask);
}

const TRACK_COLS = `id, library_id, path, ext, title, artist, album_artist, album, duration_ms, genre, country, year, language, composer, mood, bpm, initial_key`;

type TrackRow = {
  id: number | string; library_id: number | string; path: string; ext: string;
  title: string | null; artist: string | null; album_artist: string | null;
  album: string | null; duration_ms: number | null; genre: string | null;
  country: string | null; year: number | null; language: string | null;
  composer: string | null; mood: string | null; bpm: number | null;
  initial_key: string | null;
};

export function rowToDoc(row: TrackRow): TrackDoc {
  return {
    ...row,
    index_version: TRACK_INDEX_VERSION,
    id: Number(row.id),
    library_id: Number(row.library_id),
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
      const batchSize = 5000;
      for (let i = 0; i < docs.length; i += batchSize) {
        const task = await index.addDocuments(docs.slice(i, i + batchSize));
        await waitForTask(client, task);
      }
      indexed = docs.length;
    }
  }

  let deleted = 0;
  if (deletedIds.length > 0) {
    const batchSize = 5000;
    for (let i = 0; i < deletedIds.length; i += batchSize) {
      const task = await index.deleteDocuments(deletedIds.slice(i, i + batchSize));
      await waitForTask(client, task);
    }
    deleted = deletedIds.length;
  }

  return { indexed, deleted };
}

async function getIndexedTrackState(index: ReturnType<ReturnType<typeof meili>['index']>) {
  const ids = new Set<number>();
  let currentVersion = true;
  let offset = 0;
  for (;;) {
    const batch = await index.getDocuments({ limit: 1000, offset, fields: ['id', 'index_version'] });
    for (const doc of batch.results) {
      ids.add(Number(doc.id));
      if (Number(doc.index_version) !== TRACK_INDEX_VERSION) currentVersion = false;
    }
    if (batch.results.length < 1000) break;
    offset += 1000;
  }
  return { ids, currentVersion };
}

export async function getTrackIndexStatus() {
  const index = meili().index('tracks');
  const [databaseResult, indexStats] = await Promise.all([
    db().query<{ count: number }>('SELECT count(*)::int AS count FROM active_tracks'),
    index.getStats(),
  ]);
  const database = databaseResult.rows[0]?.count ?? 0;
  const indexed = indexStats.numberOfDocuments;
  if (database !== indexed) {
    return { database, index: indexed, consistent: false };
  }

  const [databaseIdsResult, indexedState] = await Promise.all([
    db().query<{ id: number }>('SELECT id FROM active_tracks'),
    getIndexedTrackState(index),
  ]);
  const consistent = indexedState.currentVersion
    && databaseIdsResult.rows.every((row) => indexedState.ids.has(Number(row.id)));
  return {
    database,
    index: indexed,
    consistent,
  };
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
    const task = await index.deleteAllDocuments();
    await waitForTask(client, task);
    return { indexed: 0 };
  }

  // Upsert in batches so Meilisearch doesn't choke on huge payloads
  const BATCH = 5000;
  for (let i = 0; i < docs.length; i += BATCH) {
    const task = await index.addDocuments(docs.slice(i, i + BATCH));
    await waitForTask(client, task);
  }

  const currentIds = new Set(docs.map(d => d.id));
  const indexedState = await getIndexedTrackState(index);
  const staleIds = [...indexedState.ids].filter((id) => !currentIds.has(id));
  if (staleIds.length > 0) {
    const batchSize = 5000;
    for (let i = 0; i < staleIds.length; i += batchSize) {
      const task = await index.deleteDocuments(staleIds.slice(i, i + batchSize));
      await waitForTask(client, task);
    }
  }

  return { indexed: docs.length };
}
