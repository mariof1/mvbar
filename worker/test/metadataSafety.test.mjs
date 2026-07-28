import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitize } from '../dist/tagRules.js';

test('sanitize ignores structured metadata instead of throwing', () => {
  assert.equal(sanitize({ language: 'eng', text: '' }), null);
  assert.equal(sanitize(['Label']), null);
});

test('sanitize normalizes supported scalar metadata', () => {
  assert.equal(sanitize(123), '123');
  assert.equal(sanitize('Cafe\u0301'), 'Caf\u00e9');
  assert.equal(sanitize('bad\0value\ufffd'), 'badvalue');
});
