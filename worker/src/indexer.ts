import { meili } from './meili.js';
import { db } from './db.js';

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
    searchableAttributes: ['title', 'artist', 'album_artist', 'album', 'genre', 'country', 'path'],
    displayedAttributes: ['id', 'library_id', 'path', 'ext', 'title', 'artist', 'album_artist', 'album', 'duration_ms', 'genre', 'country', 'year', 'language'],
    filterableAttributes: ['library_id', 'artist', 'album_artist', 'album', 'ext', 'genre', 'country', 'year', 'language'],
    sortableAttributes: ['artist', 'album_artist', 'album', 'title', 'year']
  });
}

export async function indexAllTracks() {
  const r = await db().query<TrackDoc>('select id, library_id, path, ext, title, artist, album_artist, album, duration_ms, genre, country, year, language from active_tracks');
  const docs = r.rows;
  const client = meili();
  const index = client.index('tracks');
  if (docs.length === 0) {
    await index.deleteAllDocuments();
    return { indexed: 0 };
  }
  await index.deleteAllDocuments();
  await index.addDocuments(docs);
  return { indexed: docs.length };
}
