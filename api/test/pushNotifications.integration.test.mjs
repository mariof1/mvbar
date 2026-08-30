import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { db, initDb } from '../dist/db.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('push subscriptions are bound to the authenticated user and can be removed', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.WEB_PUSH_ENABLED = 'true';
  delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  process.env.WEB_PUSH_VAPID_SUBJECT = 'mailto:test@example.test';
  const { initializeWebPush, pushNotificationsPlugin } = await import('../dist/pushNotifications.js');

  await initDb();
  await initializeWebPush();
  const generatedConfiguration = await db().query(
    'select public_key, private_key from web_push_configuration where singleton=true',
  );
  assert.ok(generatedConfiguration.rows[0].public_key);
  assert.ok(generatedConfiguration.rows[0].private_key);
  const retainedPublicKey = generatedConfiguration.rows[0].public_key;
  await initializeWebPush();
  const retainedConfiguration = await db().query(
    'select public_key from web_push_configuration where singleton=true',
  );
  assert.equal(retainedConfiguration.rows[0].public_key, retainedPublicKey);
  await db().query(`
    insert into users(id, email, role, approval_status)
    values ('push_test_user', 'push@example.test', 'user', 'approved')
    on conflict (id) do nothing
  `);

  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    if (request.headers['x-test-user']) {
      request.user = { userId: 'push_test_user', role: 'user', sessionVersion: 0 };
    }
  });
  await app.register(pushNotificationsPlugin);

  const unauthenticated = await app.inject({ method: 'GET', url: '/api/push/config' });
  assert.equal(unauthenticated.statusCode, 401);

  const config = await app.inject({
    method: 'GET',
    url: '/api/push/config',
    headers: { 'x-test-user': 'push_test_user' },
  });
  assert.equal(config.statusCode, 200);
  assert.equal(config.json().configured, true);
  assert.equal(config.json().publicKey, retainedPublicKey);
  assert.equal(config.body.includes(generatedConfiguration.rows[0].private_key), false);

  const endpoint = 'https://fcm.googleapis.com/fcm/send/mvbar-test-subscription';
  const subscribe = await app.inject({
    method: 'POST',
    url: '/api/push/subscriptions',
    headers: { 'x-test-user': 'push_test_user', 'user-agent': 'mvbar-test' },
    payload: {
      endpoint,
      expirationTime: null,
      keys: {
        p256dh: 'BEl6cWcVVVLSa6J0K9jdq7B9rX0g6YQxGmWjYxBpyT_1',
        auth: 'c29tZS1hdXRoLXNlY3JldA',
      },
    },
  });
  assert.equal(subscribe.statusCode, 201);
  const stored = await db().query(
    'select user_id, session_version, endpoint from web_push_subscriptions where endpoint=$1',
    [endpoint],
  );
  assert.deepEqual(stored.rows[0], { user_id: 'push_test_user', session_version: 0, endpoint });

  const remove = await app.inject({
    method: 'DELETE',
    url: '/api/push/subscriptions',
    headers: { 'x-test-user': 'push_test_user' },
    payload: { endpoint },
  });
  assert.equal(remove.statusCode, 200);
  const remaining = await db().query(
    'select count(*)::int as count from web_push_subscriptions where endpoint=$1',
    [endpoint],
  );
  assert.equal(remaining.rows[0].count, 0);

  await app.close();
  await db().end();
});
