import { meili } from './meili.js';
import { db } from './db.js';
import { asciiFold } from './tagRules.js';

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
    sortableAttributes: ['artist', 'album_artist', 'album', 'title', 'year', 'bpm']
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
  }));
  
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
