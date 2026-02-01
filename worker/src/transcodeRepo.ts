import { db } from './db.js';

export type TranscodeJob = {
  id: number;
  track_id: number;
  cache_key: string;
  state: 'queued' | 'running' | 'done' | 'failed';
};

function isMissingTranscodeJobsTable(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes('relation "transcode_jobs" does not exist');
}

export async function claimNextTranscodeJob() {
  try {
    const r = await db().query<TranscodeJob>(
      "update transcode_jobs set state='running', started_at=now() where id = (select id from transcode_jobs where state='queued' order by id asc limit 1 for update skip locked) returning id, track_id, cache_key, state"
    );
    return r.rows[0] ?? null;
  } catch (e) {
    if (isMissingTranscodeJobsTable(e)) return null;
    throw e;
  }
}

export async function finishTranscodeJob(id: number, state: 'done' | 'failed', outDir: string | null, error: string | null) {
  try {
    await db().query('update transcode_jobs set state=$2, finished_at=now(), out_dir=$3, error=$4 where id=$1', [id, state, outDir, error]);
  } catch (e) {
    if (isMissingTranscodeJobsTable(e)) return;
    throw e;
  }
}
