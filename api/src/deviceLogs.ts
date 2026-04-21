import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { audit } from './db.js';
import { mkdir, readdir, readFile, writeFile, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import logger from './logger.js';
import { notifyAdmins } from './telegram.js';

const LOG_DIR = process.env.DEVICE_LOG_DIR || '/data/device-logs';
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB per log

async function ensureDir() {
  await mkdir(LOG_DIR, { recursive: true });
}

function sanitizeFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 60);
}

export const deviceLogsPlugin: FastifyPluginAsync = fp(async (app) => {
  await ensureDir();

  // Accept raw text body for upload endpoint
  app.addContentTypeParser('text/plain', { parseAs: 'string', bodyLimit: MAX_LOG_SIZE }, (_req, body, done) => {
    done(null, body);
  });

  // ---- Public upload endpoint (for Android APK) ----
  app.post('/api/logs/upload', async (req, reply) => {
    const body = typeof req.body === 'string' ? req.body : String(req.body || '');
    if (body.length > MAX_LOG_SIZE) {
      return reply.code(413).send({ ok: false, error: 'Log too large (max 5 MB)' });
    }
    if (!body.length) {
      return reply.code(400).send({ ok: false, error: 'Empty log body' });
    }

    const device = sanitizeFilename(
      (req.headers['x-device'] as string) || 'unknown'
    );
    const appVersion = sanitizeFilename(
      (req.headers['x-app-version'] as string) || ''
    );
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `log_${ts}_${device}${appVersion ? `_v${appVersion}` : ''}.txt`;
    const filepath = path.join(LOG_DIR, filename);

    try {
      await writeFile(filepath, body, 'utf-8');
      logger.info('device-logs', `Saved ${filename} (${body.length} bytes)`);
      notifyAdmins('device_log_upload', `New device log uploaded:\n• Device: ${device}${appVersion ? `\n• Version: ${appVersion}` : ''}\n• Size: ${body.length} bytes`);
      return { ok: true, file: filename };
    } catch (err) {
      logger.error('device-logs', `Upload failed: ${err}`);
      return reply.code(500).send({ ok: false, error: 'Upload failed' });
    }
  });

  // ---- Admin: list logs ----
  app.get('/api/admin/device-logs', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });

    await ensureDir();
    const files = (await readdir(LOG_DIR)).filter(f => f.endsWith('.txt'));
    
    const logs = await Promise.all(
      files.map(async (f) => {
        const st = await stat(path.join(LOG_DIR, f));
        // Parse metadata from filename: log_YYYY-MM-DDTHH-MM-SS_device_vVersion.txt
        const match = f.match(/^log_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})_(.+?)(?:_v(.+))?\.txt$/);
        return {
          name: f,
          size: st.size,
          createdAt: match ? match[1].replace(/T/, ' ').replace(/-/g, (m, i) => i > 9 ? ':' : m) : st.mtime.toISOString(),
          device: match?.[2]?.replace(/_/g, ' ') || 'unknown',
          appVersion: match?.[3] || null,
        };
      })
    );

    logs.sort((a, b) => b.name.localeCompare(a.name));
    return { ok: true, logs };
  });

  // ---- Admin: view single log ----
  app.get('/api/admin/device-logs/:name', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });

    const { name } = req.params as { name: string };
    const safeName = path.basename(name);
    const filepath = path.join(LOG_DIR, safeName);

    try {
      const content = await readFile(filepath, 'utf-8');
      return { ok: true, name: safeName, content };
    } catch {
      return reply.code(404).send({ ok: false, error: 'Log not found' });
    }
  });

  // ---- Admin: delete log ----
  app.delete('/api/admin/device-logs/:name', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });

    const { name } = req.params as { name: string };
    const safeName = path.basename(name);
    const filepath = path.join(LOG_DIR, safeName);

    try {
      await unlink(filepath);
      await audit('delete_device_log', { userId: req.user.userId, file: safeName });
      return { ok: true };
    } catch {
      return reply.code(404).send({ ok: false, error: 'Log not found' });
    }
  });

  // ---- Admin: delete all logs ----
  app.delete('/api/admin/device-logs', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });

    await ensureDir();
    const files = (await readdir(LOG_DIR)).filter(f => f.endsWith('.txt'));
    let deleted = 0;
    for (const f of files) {
      try {
        await unlink(path.join(LOG_DIR, f));
        deleted++;
      } catch { /* skip */ }
    }
    await audit('delete_all_device_logs', { userId: req.user.userId, count: deleted });
    return { ok: true, deleted };
  });
});
