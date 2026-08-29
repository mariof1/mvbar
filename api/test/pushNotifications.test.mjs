import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePushSubscription } from '../dist/pushNotifications.js';

const validSubscription = {
  endpoint: 'https://push.example.test/subscription/abc',
  expirationTime: null,
  keys: {
    p256dh: 'BEl6cWcVVVLSa6J0K9jdq7B9rX0g6YQxGmWjYxBpyT_1',
    auth: 'c29tZS1hdXRoLXNlY3JldA',
  },
};

test('push subscriptions accept valid HTTPS endpoints and key material', () => {
  assert.deepEqual(normalizePushSubscription(validSubscription), {
    endpoint: validSubscription.endpoint,
    expirationTime: null,
    p256dh: validSubscription.keys.p256dh,
    auth: validSubscription.keys.auth,
  });
});

test('push subscriptions reject insecure or credential-bearing endpoints', () => {
  assert.equal(normalizePushSubscription({ ...validSubscription, endpoint: 'http://push.example.test/id' }), null);
  assert.equal(normalizePushSubscription({ ...validSubscription, endpoint: 'https://user:pass@push.example.test/id' }), null);
  assert.equal(normalizePushSubscription({ ...validSubscription, endpoint: 'https://127.0.0.1/id' }), null);
  assert.equal(normalizePushSubscription({ ...validSubscription, endpoint: 'https://192.168.1.2/id' }), null);
  assert.equal(normalizePushSubscription({ ...validSubscription, endpoint: 'https://100.104.9.84/id' }), null);
  assert.equal(normalizePushSubscription({ ...validSubscription, endpoint: 'https://[fd00::1]/id' }), null);
});

test('push subscriptions reject malformed keys and expiration values', () => {
  assert.equal(normalizePushSubscription({
    ...validSubscription,
    keys: { ...validSubscription.keys, auth: 'not valid!' },
  }), null);
  assert.equal(normalizePushSubscription({ ...validSubscription, expirationTime: -1 }), null);
});
