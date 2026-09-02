import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRateLimitBypassIP } from '../dist/store.js';

test('rate-limit bypass IPs are validated and normalized', () => {
  assert.equal(normalizeRateLimitBypassIP(' 192.168.50.10 '), '192.168.50.10');
  assert.equal(normalizeRateLimitBypassIP('2001:0DB8:0:0:0:0:0:1'), '2001:db8::1');
  assert.equal(normalizeRateLimitBypassIP('::ffff:192.168.50.10'), '::ffff:c0a8:320a');
  assert.equal(normalizeRateLimitBypassIP('192.168.50.0/24'), null);
  assert.equal(normalizeRateLimitBypassIP('pixel.lan'), null);
  assert.equal(normalizeRateLimitBypassIP(''), null);
});
