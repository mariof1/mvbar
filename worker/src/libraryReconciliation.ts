import type { Pool } from 'pg';

type LibraryReconciliationRow = {
  id: number | string;
  mount_path: string;
  retired_tracks: number | string;
  deactivated: boolean;
};

export type RetiredMusicLibrary = {
  id: number;
  mountPath: string;
  retiredTracks: number;
  deactivated: boolean;
};

const RETIRE_REMOVED_MUSIC_LIBRARIES_SQL = `
  WITH stale_libraries AS (
    SELECT id, mount_path
    FROM libraries
    WHERE media_type = 'music'
      AND NOT (mount_path = ANY($1::text[]))
  ),
  deactivated_libraries AS (
    UPDATE libraries AS library
    SET enabled = FALSE
    FROM stale_libraries AS stale
    WHERE library.id = stale.id
      AND library.enabled = TRUE
    RETURNING library.id
  ),
  retired_tracks AS (
    UPDATE tracks AS track
    SET deleted_at = NOW()
    FROM stale_libraries AS library
    WHERE track.library_id = library.id
      AND track.deleted_at IS NULL
    RETURNING track.library_id
  )
  SELECT
    library.id,
    library.mount_path,
    COUNT(retired.library_id)::int AS retired_tracks,
    (deactivated.id IS NOT NULL) AS deactivated
  FROM stale_libraries AS library
  LEFT JOIN deactivated_libraries AS deactivated ON deactivated.id = library.id
  LEFT JOIN retired_tracks AS retired ON retired.library_id = library.id
  GROUP BY library.id, library.mount_path, deactivated.id
  HAVING deactivated.id IS NOT NULL OR COUNT(retired.library_id) > 0
  ORDER BY library.id
`;

export async function retireRemovedMusicLibraries(
  database: Pick<Pool, 'query'>,
  configuredDirs: string[]
): Promise<RetiredMusicLibrary[]> {
  const result = await database.query<LibraryReconciliationRow>(
    RETIRE_REMOVED_MUSIC_LIBRARIES_SQL,
    [configuredDirs]
  );

  return result.rows.map((row) => ({
    id: Number(row.id),
    mountPath: row.mount_path,
    retiredTracks: Number(row.retired_tracks),
    deactivated: row.deactivated,
  }));
}
