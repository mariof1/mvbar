import { stat } from 'node:fs/promises';
import path from 'node:path';
import { db } from './db.js';
import logger from './logger.js';
import { detectTempoBpm, type OnsetMethod } from './tempoDetector.js';

function safeJoinMount(mountPath: string, relPath: string) {
  const abs = path.resolve(mountPath, relPath);
  const base = path.resolve(mountPath);
  if (!abs.startsWith(base + path.sep)) throw new Error('invalid path');
  return abs;
}

const TEMPO_METHOD = (process.env.TEMPO_METHOD as OnsetMethod | undefined) ?? 'energy';
const TEMPO_MIN_CONF = Number(process.env.TEMPO_MIN_CONF ?? '0.35');
const TEMPO_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.TEMPO_CONCURRENCY ?? '2')));

const TEMPO_BACKFILL_BATCH = Math.max(1, Math.min(500, Number(process.env.TEMPO_BACKFILL_BATCH ?? '50')));

let tempoInFlight = 0;
const tempoWaiters: Array<() => void> = [];
async function withTempoSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (tempoInFlight >= TEMPO_CONCURRENCY) {
    await new Promise<void>((resolve) => tempoWaiters.push(resolve));
  }
  tempoInFlight++;
  try {
    return await fn();
  } finally {
    tempoInFlight--;
    tempoWaiters.shift()?.();
  }
}

export async function runTempoBackfillBatch(): Promise<void> {
  const start = Date.now();
  logger.info('tempo', 'Tempo backfill batch starting', {
    batch: TEMPO_BACKFILL_BATCH,
    method: TEMPO_METHOD,
    minConfidence: TEMPO_MIN_CONF,
    concurrency: TEMPO_CONCURRENCY,
  });

  const r = await db().query<{ id: number; path: string; mount_path: string }>(
    `select t.id, t.path, l.mount_path
     from tracks t
     join libraries l on l.id = t.library_id
     where t.deleted_at is null and (t.bpm is null or t.bpm <= 0)
     order by t.id asc
     limit $1`,
    [TEMPO_BACKFILL_BATCH]
  );

  let tried = 0;
  let applied = 0;
  let lowConfidence = 0;
  let failed = 0;
  let missingFile = 0;

  await Promise.all(
    r.rows.map(async (row) => {
      tried++;
      try {
        const abs = safeJoinMount(row.mount_path, row.path);
        try {
          const st = await stat(abs);
          if (!st.isFile()) {
            missingFile++;
            return;
          }
        } catch {
          missingFile++;
          return;
        }

        const res = await withTempoSlot(() => detectTempoBpm(abs, { onsetMethod: TEMPO_METHOD }));
        if (res.confidence < TEMPO_MIN_CONF || !Number.isFinite(res.bpm) || res.bpm <= 0) {
          lowConfidence++;
          return;
        }

        const upd = await db().query(
          'update tracks set bpm=$2, updated_at=now() where id=$1 and (bpm is null or bpm<=0)',
          [row.id, res.bpm]
        );
        if ((upd.rowCount ?? 0) > 0) applied++;
      } catch (e) {
        failed++;
        logger.debug('tempo', `Tempo backfill failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    })
  );

  const durSec = Math.round((Date.now() - start) / 1000);
  logger.info('tempo', 'Tempo backfill batch complete', {
    durationSec: durSec,
    tried,
    applied,
    lowConfidence,
    missingFile,
    failed,
  });
}
