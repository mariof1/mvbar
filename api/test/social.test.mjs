import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeRecipientIds,
  normalizeShareMessage,
  normalizeSocialSearch,
} from '../dist/social.js';

test('social search is trimmed and bounded', () => {
  assert.equal(normalizeSocialSearch('  friend@example.com  '), 'friend@example.com');
  assert.equal(normalizeSocialSearch('x'.repeat(150)).length, 100);
  assert.equal(normalizeSocialSearch(null), '');
});

test('share messages are optional, trimmed, and bounded', () => {
  assert.equal(normalizeShareMessage('  Great song!  '), 'Great song!');
  assert.equal(normalizeShareMessage('   '), null);
  assert.equal(normalizeShareMessage('x'.repeat(700))?.length, 500);
});

test('share recipients are unique strings with a safe upper bound', () => {
  assert.deepEqual(normalizeRecipientIds(['u1', 'u1', '', 42, 'u2']), ['u1', 'u2']);
  assert.equal(normalizeRecipientIds(Array.from({ length: 30 }, (_, i) => `u${i}`)).length, 20);
  assert.deepEqual(normalizeRecipientIds('u1'), []);
});
