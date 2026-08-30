import assert from 'node:assert/strict';
import test from 'node:test';
import { asciiFold } from '../dist/asciiFold.js';

test('asciiFold returns an empty string when a name has no Latin representation', () => {
  assert.equal(asciiFold('Sokół'), 'sokol');
  assert.equal(asciiFold('Мария Янковская'), '');
  assert.equal(asciiFold('ミラクルミュージカル'), '');
});
