import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import dns from 'node:dns/promises';
import net from 'node:net';
import webPush from 'web-push';
import { audit, db } from './db.js';
import logger from './logger.js';

type StoredSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type NormalizedPushSubscription = StoredSubscription & {
  expirationTime: number | null;
};

export type MvbarPushNotification = {
  title: string;
  body: string;
  tag: string;
  url: string;
};

const configuredSubject = process.env.WEB_PUSH_VAPID_SUBJECT?.trim();
let publicKey = '';

function defaultVapidSubject() {
  const domain = process.env.APP_DOMAIN?.trim();
  if (!domain) return 'mailto:admin@localhost';
  try {
    return new URL(domain.includes('://') ? domain : `https://${domain}`).origin;
  } catch {
    return 'mailto:admin@localhost';
  }
}

let webPushConfigured = false;

function applyVapidConfiguration(nextPublicKey: string, nextPrivateKey: string, nextSubject: string) {
  try {
    webPush.setVapidDetails(nextSubject, nextPublicKey, nextPrivateKey);
    publicKey = nextPublicKey;
    webPushConfigured = true;
  } catch (error) {
    logger.error('push', 'Web Push is disabled because the VAPID configuration is invalid', {
      error: error instanceof Error ? error.message : 'invalid configuration',
    });
  }
}

export async function initializeWebPush() {
  const environmentPublicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim() ?? '';
  const environmentPrivateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim() ?? '';
  const enabled = process.env.WEB_PUSH_ENABLED?.trim().toLowerCase() === 'true';
  const nextSubject = configuredSubject || defaultVapidSubject();

  if (environmentPublicKey || environmentPrivateKey) {
    if (!environmentPublicKey || !environmentPrivateKey) {
      logger.warn('push', 'Web Push is disabled because both VAPID keys are required');
      return;
    }
    applyVapidConfiguration(environmentPublicKey, environmentPrivateKey, nextSubject);
    return;
  }
  if (!enabled) return;

  let stored = await db().query<{ public_key: string; private_key: string; subject: string }>(
    'select public_key, private_key, subject from web_push_configuration where singleton=true',
  );
  if (!stored.rows[0]) {
    const generated = webPush.generateVAPIDKeys();
    await db().query(
      `insert into web_push_configuration(singleton, public_key, private_key, subject)
       values (true,$1,$2,$3)
       on conflict (singleton) do nothing`,
      [generated.publicKey, generated.privateKey, nextSubject],
    );
    stored = await db().query<{ public_key: string; private_key: string; subject: string }>(
      'select public_key, private_key, subject from web_push_configuration where singleton=true',
    );
  }
  const configuration = stored.rows[0];
  if (!configuration) {
    logger.error('push', 'Web Push is enabled but its persistent VAPID configuration could not be loaded');
    return;
  }
  applyVapidConfiguration(configuration.public_key, configuration.private_key, configuration.subject);
}

function normalizedBase64Url(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > maxLength) return '';
  return /^[A-Za-z0-9_-]+={0,2}$/.test(normalized) ? normalized : '';
}

function isPrivateNetworkAddress(address: string): boolean {
  const unbracketed = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const normalized = unbracketed.toLowerCase().split('%')[0];
  if (net.isIPv4(normalized)) {
    const octets = normalized.split('.').map(Number);
    return octets[0] === 0
      || octets[0] === 10
      || octets[0] === 127
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 0 && octets[2] <= 2)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 198 && (octets[1] === 18 || octets[1] === 19 || octets[1] === 51))
      || (octets[0] === 203 && octets[1] === 0 && octets[2] === 113)
      || octets[0] >= 224;
  }
  if (!net.isIPv6(normalized)) return false;
  if (normalized === '::' || normalized === '::1') return true;
  if (
    normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || /^fe[89ab-cdef]/.test(normalized)
    || normalized.startsWith('ff')
    || normalized.startsWith('2001:db8')
  ) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  return mapped ? isPrivateNetworkAddress(mapped) : false;
}

async function assertPublicPushEndpoint(endpoint: string) {
  const hostname = new URL(endpoint).hostname;
  if (hostname.toLowerCase() === 'localhost' || isPrivateNetworkAddress(hostname)) {
    throw new Error('private_push_endpoint');
  }
  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateNetworkAddress(address))) {
    throw new Error('private_push_endpoint');
  }
}

export function normalizePushSubscription(value: unknown): NormalizedPushSubscription | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as {
    endpoint?: unknown;
    expirationTime?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  if (typeof candidate.endpoint !== 'string' || candidate.endpoint.length > 4096) return null;

  let endpoint: URL;
  try {
    endpoint = new URL(candidate.endpoint);
  } catch {
    return null;
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) return null;
  if (endpoint.hostname.toLowerCase() === 'localhost' || isPrivateNetworkAddress(endpoint.hostname)) return null;

  const p256dh = normalizedBase64Url(candidate.keys?.p256dh, 512);
  const auth = normalizedBase64Url(candidate.keys?.auth, 256);
  if (!p256dh || !auth) return null;

  let expirationTime: number | null = null;
  if (candidate.expirationTime !== null && candidate.expirationTime !== undefined) {
    const parsed = Number(candidate.expirationTime);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
    expirationTime = parsed;
  }

  return { endpoint: endpoint.toString(), p256dh, auth, expirationTime };
}

export function isWebPushConfigured() {
  return webPushConfigured;
}

function pushPayload(notification: MvbarPushNotification) {
  return JSON.stringify({
    title: notification.title.slice(0, 100),
    body: notification.body.slice(0, 240),
    tag: notification.tag.slice(0, 120),
    url: notification.url.startsWith('/') ? notification.url : '/#/social',
  });
}

export async function sendWebPushToUser(userId: string, notification: MvbarPushNotification) {
  if (!webPushConfigured) return;
  try {
    const result = await db().query<StoredSubscription>(
      `select subscription.endpoint, subscription.p256dh, subscription.auth
         from web_push_subscriptions subscription
         join users recipient on recipient.id=subscription.user_id
        where subscription.user_id=$1
          and subscription.session_version=recipient.session_version
        order by subscription.updated_at desc`,
      [userId],
    );
    if (result.rows.length === 0) return;

    const payload = pushPayload(notification);
    await Promise.all(result.rows.map(async (subscription) => {
      try {
        await assertPublicPushEndpoint(subscription.endpoint);
        await webPush.sendNotification({
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        }, payload, { TTL: 24 * 60 * 60, urgency: 'normal' });
        await db().query(
          `update web_push_subscriptions
              set last_success_at=now(), failure_count=0
            where endpoint=$1 and user_id=$2`,
          [subscription.endpoint, userId],
        );
      } catch (error) {
        const statusCode = Number((error as { statusCode?: unknown })?.statusCode || 0);
        if (statusCode === 404 || statusCode === 410) {
          await db().query(
            'delete from web_push_subscriptions where endpoint=$1 and user_id=$2',
            [subscription.endpoint, userId],
          );
          return;
        }
        await db().query(
          `update web_push_subscriptions
              set failure_count=failure_count+1, last_failure_at=now()
            where endpoint=$1 and user_id=$2`,
          [subscription.endpoint, userId],
        );
        logger.warn('push', 'Failed to deliver a Web Push notification', { userId, statusCode });
      }
    }));
  } catch (error) {
    logger.warn('push', 'Could not process Web Push delivery', {
      userId,
      error: error instanceof Error ? error.message : 'unknown error',
    });
  }
}

export const pushNotificationsPlugin: FastifyPluginAsync = fp(async (app) => {
  app.get('/api/push/config', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    return {
      ok: true,
      configured: webPushConfigured,
      publicKey: webPushConfigured ? publicKey : null,
    };
  });

  app.post('/api/push/subscriptions', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    if (!webPushConfigured) {
      return reply.code(503).send({ ok: false, error: 'push_not_configured' });
    }
    const subscription = normalizePushSubscription(req.body);
    if (!subscription) {
      return reply.code(400).send({ ok: false, error: 'invalid_subscription' });
    }
    const userAgent = String(req.headers['user-agent'] || '').slice(0, 500) || null;
    const existing = await db().query<{ user_id: string }>(
      'select user_id from web_push_subscriptions where endpoint=$1',
      [subscription.endpoint],
    );
    await db().query(
      `insert into web_push_subscriptions(
         user_id, session_version, endpoint, p256dh, auth, expiration_time, user_agent
       ) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (endpoint) do update set
         user_id=excluded.user_id,
         session_version=excluded.session_version,
         p256dh=excluded.p256dh,
         auth=excluded.auth,
         expiration_time=excluded.expiration_time,
         user_agent=excluded.user_agent,
         updated_at=now(),
         failure_count=0,
         last_failure_at=null`,
      [
        req.user.userId,
        req.user.sessionVersion,
        subscription.endpoint,
        subscription.p256dh,
        subscription.auth,
        subscription.expirationTime,
        userAgent,
      ],
    );
    if (existing.rows[0]?.user_id !== req.user.userId) {
      await audit('web_push_enabled', { by: req.user.userId });
    }
    return reply.code(201).send({ ok: true });
  });

  app.delete('/api/push/subscriptions', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ ok: false });
    const endpoint = typeof (req.body as { endpoint?: unknown })?.endpoint === 'string'
      ? String((req.body as { endpoint: string }).endpoint)
      : '';
    if (!endpoint || endpoint.length > 4096) {
      return reply.code(400).send({ ok: false, error: 'invalid_subscription' });
    }
    const removed = await db().query(
      'delete from web_push_subscriptions where user_id=$1 and endpoint=$2 returning id',
      [req.user.userId, endpoint],
    );
    if (removed.rowCount) await audit('web_push_disabled', { by: req.user.userId });
    return { ok: true };
  });
});
