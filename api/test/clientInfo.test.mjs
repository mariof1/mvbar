import assert from 'node:assert/strict';
import test from 'node:test';
import { clientInfoFromRequest } from '../dist/clientInfo.js';

test('clientInfoFromRequest preserves explicit app identity and strips control characters', () => {
  const info = clientInfoFromRequest({
    headers: {
      'x-mvbar-client': 'Android',
      'x-mvbar-client-id': 'phone-123',
      'x-mvbar-version': '2.4.0',
      'x-mvbar-device': 'Samsung\u0000 Tablet',
      'x-mvbar-platform': 'Android 16',
      'user-agent': 'okhttp/5',
    },
  });

  assert.deepEqual(info, {
    id: 'phone-123',
    reported: true,
    type: 'android',
    version: '2.4.0',
    device: 'Samsung Tablet',
    platform: 'Android 16',
    userAgent: 'okhttp/5',
  });
});

test('clientInfoFromRequest gives legacy Android clients a stable anonymous identity', () => {
  const request = { headers: { 'user-agent': 'okhttp/4.12.0' } };
  const first = clientInfoFromRequest(request);
  const second = clientInfoFromRequest(request);

  assert.equal(first.type, 'android');
  assert.equal(first.reported, false);
  assert.match(first.id, /^auto_[a-f0-9]{32}$/);
  assert.equal(first.id, second.id);
});
