import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { db, redis } from './db.js';
import logger from './logger.js';
import Redis from 'ioredis';

// List of all supported notification event keys (also the UI checkbox list).
export const TELEGRAM_EVENTS = [
  'user_pending',        // New user awaiting admin approval (Google login)
  'user_login',          // Successful user login
  'user_failed_login',   // Failed login attempt
  'scan_started',        // Music library scan started
  'scan_finished',       // Music library scan finished
  'user_approved',       // Admin approved/rejected a user
  'device_log_upload',   // New device log uploaded
] as const;
export type TelegramEvent = typeof TELEGRAM_EVENTS[number];

// Default: everything enabled when admin first configures telegram.
const DEFAULT_EVENTS: Record<string, boolean> = Object.fromEntries(
  TELEGRAM_EVENTS.map((e) => [e, true])
);

async function ensureSchema() {
  await db().query(`
    create table if not exists telegram_settings (
      user_id text primary key references users(id) on delete cascade,
      bot_token text,
      chat_id text,
      enabled boolean not null default false,
      events jsonb not null default '{}'::jsonb,
      updated_at timestamptz not null default now()
    );
  `);
}

async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error('telegram', `Send failed (${res.status}): ${body.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    logger.error('telegram', `Send exception: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// Public helper used elsewhere in the codebase. Non-blocking (fire-and-forget).
export function notifyAdmins(event: TelegramEvent, message: string): void {
  (async () => {
    try {
      const { rows } = await db().query(
        `select ts.bot_token, ts.chat_id, ts.events
         from telegram_settings ts
         join users u on u.id = ts.user_id
         where u.role = 'admin'
           and ts.enabled = true
           and coalesce(ts.bot_token, '') <> ''
           and coalesce(ts.chat_id, '') <> ''`
      );
      const prefix = `<b>mvbar</b> • ${event}`;
      const text = `${prefix}\n${message}`;
      for (const r of rows) {
        const evmap = r.events || {};
        if (evmap[event] === false) continue;
        await sendTelegramMessage(r.bot_token, r.chat_id, text);
      }
    } catch (err) {
      logger.error('telegram', `notifyAdmins failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}

export const telegramPlugin: FastifyPluginAsync = fp(async (app) => {
  await ensureSchema();

  // Subscribe to scan:complete on library:updates and notify admins.
  const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';
  const sub = new Redis(REDIS_URL);
  sub.subscribe('library:updates', (err) => {
    if (err) logger.error('telegram', 'Failed to subscribe to library:updates');
  });
  sub.on('message', (channel, message) => {
    if (channel !== 'library:updates') return;
    try {
      const data = JSON.parse(message);
      if (data.event === 'scan:complete') {
        const stats = data.stats || data;
        const added = stats.added ?? stats.inserted ?? 0;
        const updated = stats.updated ?? 0;
        const removed = stats.removed ?? 0;
        const total = stats.total ?? stats.processed ?? 0;
        notifyAdmins(
          'scan_finished',
          `Library scan finished.\n• Processed: ${total}\n• Added: ${added}\n• Updated: ${updated}\n• Removed: ${removed}`
        );
      }
    } catch {
      /* ignore */
    }
  });

  // --- Get own telegram settings (admin only) ---
  app.get('/api/telegram/settings', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const { rows } = await db().query(
      'select bot_token, chat_id, enabled, events from telegram_settings where user_id = $1',
      [req.user.userId]
    );
    const row = rows[0];
    return {
      ok: true,
      availableEvents: TELEGRAM_EVENTS,
      settings: row
        ? {
            // Mask the token except last 4 chars for safety in the UI.
            botTokenMasked: row.bot_token ? `••••••${String(row.bot_token).slice(-4)}` : '',
            hasBotToken: !!row.bot_token,
            chatId: row.chat_id || '',
            enabled: !!row.enabled,
            events: { ...DEFAULT_EVENTS, ...(row.events || {}) },
          }
        : {
            botTokenMasked: '',
            hasBotToken: false,
            chatId: '',
            enabled: false,
            events: { ...DEFAULT_EVENTS },
          },
    };
  });

  // --- Update telegram settings (admin only) ---
  // If botToken is an empty string, the existing token is kept unchanged.
  // To clear it, pass `clearBotToken: true`.
  app.put('/api/telegram/settings', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const body = (req.body || {}) as {
      botToken?: string;
      clearBotToken?: boolean;
      chatId?: string;
      enabled?: boolean;
      events?: Record<string, boolean>;
    };

    // Sanitize events: only keep known keys with boolean values.
    const safeEvents: Record<string, boolean> = {};
    if (body.events && typeof body.events === 'object') {
      for (const ev of TELEGRAM_EVENTS) {
        if (typeof body.events[ev] === 'boolean') safeEvents[ev] = body.events[ev];
      }
    }

    // Load existing row to decide whether to update the token.
    const existing = await db().query(
      'select bot_token, chat_id, enabled, events from telegram_settings where user_id = $1',
      [req.user.userId]
    );
    const prev = existing.rows[0];

    let newToken: string | null = prev?.bot_token ?? null;
    if (body.clearBotToken === true) newToken = null;
    else if (typeof body.botToken === 'string' && body.botToken.trim().length > 0) {
      newToken = body.botToken.trim();
    }

    const newChatId = typeof body.chatId === 'string' ? body.chatId.trim() : (prev?.chat_id ?? '');
    const newEnabled = typeof body.enabled === 'boolean' ? body.enabled : !!prev?.enabled;
    const mergedEvents = { ...DEFAULT_EVENTS, ...(prev?.events || {}), ...safeEvents };

    await db().query(
      `insert into telegram_settings (user_id, bot_token, chat_id, enabled, events, updated_at)
       values ($1, $2, $3, $4, $5, now())
       on conflict (user_id) do update
         set bot_token = excluded.bot_token,
             chat_id   = excluded.chat_id,
             enabled   = excluded.enabled,
             events    = excluded.events,
             updated_at = now()`,
      [req.user.userId, newToken, newChatId, newEnabled, mergedEvents]
    );

    return { ok: true };
  });

  // --- Send a test message using current settings ---
  app.post('/api/telegram/test', async (req, reply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ ok: false });
    const { rows } = await db().query(
      'select bot_token, chat_id from telegram_settings where user_id = $1',
      [req.user.userId]
    );
    const r = rows[0];
    if (!r?.bot_token || !r?.chat_id) {
      return reply.code(400).send({ ok: false, error: 'Bot token or chat ID not configured' });
    }
    const ok = await sendTelegramMessage(
      r.bot_token,
      r.chat_id,
      `<b>mvbar</b> • test\nThis is a test notification from mvbar.`
    );
    if (!ok) return reply.code(502).send({ ok: false, error: 'Telegram API rejected the message. Check bot token and chat ID.' });
    return { ok: true };
  });

  // Silence unused import warning for redis()
  void redis;
});
