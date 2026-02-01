import { db } from './db.js';

export type ScanJob = {
  id: number;
  state: 'queued' | 'running' | 'done' | 'failed';
  requested_by: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  stats: unknown;
  error: string | null;
};

export async function enqueueScan(requestedBy: string | null, force: boolean = false) {
  const r = await db().query<{ id: number }>(
    "insert into scan_jobs(state, requested_by, force_full) values ('queued', $1, $2) returning id",
    [requestedBy, force]
  );
  return r.rows[0].id;
}

export async function getLatestJob() {
  const r = await db().query<ScanJob>(
    'select id, state, requested_by, requested_at, started_at, finished_at, stats, error from scan_jobs order by id desc limit 1'
  );
  return r.rows[0] ?? null;
}

export async function getJob(id: number) {
  const r = await db().query<ScanJob>(
    'select id, state, requested_by, requested_at, started_at, finished_at, stats, error from scan_jobs where id=$1',
    [id]
  );
  return r.rows[0] ?? null;
}

export async function claimNextJob() {
  const r = await db().query<ScanJob>(
    "update scan_jobs set state='running', started_at=now() where id = (select id from scan_jobs where state='queued' order by id asc limit 1 for update skip locked) returning id, state, requested_by, requested_at, started_at, finished_at, stats, error"
  );
  return r.rows[0] ?? null;
}

export async function finishJob(id: number, state: 'done' | 'failed', stats: unknown, error: string | null) {
  await db().query(
    'update scan_jobs set state=$2, finished_at=now(), stats=$3, error=$4 where id=$1',
    [id, state, stats ?? null, error]
  );
}

export async function upsertTrack(params: {
  path: string;
  mtimeMs: number;
  birthtimeMs?: number;
  sizeBytes: number;
  ext: string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  durationMs?: number | null;
}) {
  await db().query(
    `insert into tracks(path, mtime_ms, size_bytes, ext, title, artist, album, duration_ms, created_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8, to_timestamp($9::bigint / 1000.0))
     on conflict (path) do update set
       mtime_ms=excluded.mtime_ms,
       size_bytes=excluded.size_bytes,
       ext=excluded.ext,
       title=excluded.title,
       artist=excluded.artist,
       album=excluded.album,
       duration_ms=excluded.duration_ms,
       created_at=excluded.created_at,
       updated_at=now()` ,
    [
      params.path,
      params.mtimeMs,
      params.sizeBytes,
      params.ext,
      params.title ?? null,
      params.artist ?? null,
      params.album ?? null,
      params.durationMs ?? null,
      params.birthtimeMs ?? params.mtimeMs // fallback to mtime if birthtime not available
    ]
  );
}
