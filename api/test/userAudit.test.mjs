import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedAuditPage } from '../dist/userAudit.js';
import {
  clearLoginRestrictions,
  getLoginRestriction,
  loginRateLimitKey,
  store,
} from '../dist/store.js';

test('boundedAuditPage applies defaults and safe numeric bounds', () => {
  assert.deepEqual(boundedAuditPage({}), { limit: 25, offset: 0 });
  assert.deepEqual(boundedAuditPage({ limit: '500', offset: '-4' }), { limit: 100, offset: 0 });
  assert.deepEqual(boundedAuditPage({ limit: '12.8', offset: '7.9' }), { limit: 12, offset: 7 });
  assert.deepEqual(boundedAuditPage({ limit: 'invalid', offset: 'invalid' }), { limit: 25, offset: 0 });
});

test('login restriction status and admin clear cover account locks and related IP limits', () => {
  const now = 2_000_000;
  const email = 'User@Example.com';
  const ipv4 = '192.168.50.24';
  const ipv6 = '2001:db8::24';

  store.failedLoginsByKey.set(`${ipv4}:user@example.com`, {
    count: 8,
    lastFailedAt: now - 2_000,
    lockedUntil: now + 300_000,
  });
  store.failedLoginsByKey.set(loginRateLimitKey(ipv4, email), { count: 8, lastFailedAt: now - 2_000 });
  store.failedLoginsByKey.set(`${ipv6}:user@example.com`, { count: 5, lastFailedAt: now - 1_000 });
  store.failedLoginsByKey.set(loginRateLimitKey(ipv6, email), { count: 5, lastFailedAt: now - 1_000 });
  store.failedLoginsByKey.set(`${ipv4}:someone@example.com`, { count: 3, lastFailedAt: now });
  store.failedLoginsByKey.set(loginRateLimitKey(ipv4, 'someone@example.com'), {
    count: 5,
    lastFailedAt: now,
  });

  const restriction = getLoginRestriction(email, now);
  assert.equal(restriction.blocked, true);
  assert.equal(restriction.locked, true);
  assert.equal(restriction.rateLimited, true);
  assert.equal(restriction.failedAttempts, 13);
  assert.deepEqual(restriction.ips, [ipv4, ipv6]);

  const cleared = clearLoginRestrictions(email, now);
  assert.equal(cleared.clearedKeys, 4);
  assert.equal(getLoginRestriction(email, now).blocked, false);
  assert.equal(store.failedLoginsByKey.has(`${ipv4}:user@example.com`), false);
  assert.equal(store.failedLoginsByKey.has(loginRateLimitKey(ipv6, email)), false);
  assert.equal(store.failedLoginsByKey.has(`${ipv4}:someone@example.com`), true);
  assert.equal(store.failedLoginsByKey.has(loginRateLimitKey(ipv4, 'someone@example.com')), true);
  assert.equal(getLoginRestriction('someone@example.com', now).blocked, true);

  store.failedLoginsByKey.clear();
});
