import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedAuditPage } from '../dist/userAudit.js';

test('boundedAuditPage applies defaults and safe numeric bounds', () => {
  assert.deepEqual(boundedAuditPage({}), { limit: 25, offset: 0 });
  assert.deepEqual(boundedAuditPage({ limit: '500', offset: '-4' }), { limit: 100, offset: 0 });
  assert.deepEqual(boundedAuditPage({ limit: '12.8', offset: '7.9' }), { limit: 12, offset: 7 });
  assert.deepEqual(boundedAuditPage({ limit: 'invalid', offset: 'invalid' }), { limit: 25, offset: 0 });
});
