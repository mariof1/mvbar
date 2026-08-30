import { db } from '../db.js';
import logger from '../logger.js';
import { callPluginExport } from './runtime.js';

type SeedTrack = {
  id: string | number;
  title: string | null;
  artist: string | null;
  musicbrainz_track_id?: string | null;
};

type SimilarSongsOutput = {
  songs?: Array<{
    id?: string | number;
    name?: string;
    artist?: string;
    album?: string;
  }>;
};

export async function pluginSimilarSongIds(seed: SeedTrack, count: number) {
  const plugins = await db().query<{ id: string }>(
    `select id from plugins
      where enabled=true
      order by updated_at desc, id`
  );
  for (const plugin of plugins.rows) {
    try {
      const result = await callPluginExport(plugin.id, 'nd_get_similar_songs_by_track', {
        id: String(seed.id),
        name: seed.title ?? '',
        artist: seed.artist ?? '',
        mbid: seed.musicbrainz_track_id ?? '',
        count,
      }) as SimilarSongsOutput | null;
      const ids = (result?.songs ?? [])
        .map((song) => String(song.id ?? ''))
        .filter((id) => /^\d+$/.test(id) && id !== String(seed.id));
      if (ids.length > 0) return { pluginId: plugin.id, ids: Array.from(new Set(ids)).slice(0, count) };
    } catch (error) {
      logger.warn('plugins', `Similar-songs provider ${plugin.id} failed; trying the next provider: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}

type SeedArtist = {
  id: string | number;
  name: string;
  musicbrainz_id?: string | null;
};

type SimilarArtistsOutput = {
  artists?: Array<{ id?: string | number; name?: string }>;
};

export async function pluginSimilarArtistIds(seed: SeedArtist, limit: number) {
  const plugins = await db().query<{ id: string }>(
    'select id from plugins where enabled=true order by updated_at desc, id'
  );
  for (const plugin of plugins.rows) {
    try {
      const result = await callPluginExport(plugin.id, 'nd_get_similar_artists', {
        id: String(seed.id),
        name: seed.name,
        mbid: seed.musicbrainz_id ?? '',
        limit,
      }) as SimilarArtistsOutput | null;
      const ids = (result?.artists ?? [])
        .map((artist) => String(artist.id ?? ''))
        .filter((id) => /^\d+$/.test(id) && id !== String(seed.id));
      if (ids.length > 0) return { pluginId: plugin.id, ids: Array.from(new Set(ids)).slice(0, limit) };
    } catch (error) {
      logger.warn('plugins', `Similar-artists provider ${plugin.id} failed; trying the next provider: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}
