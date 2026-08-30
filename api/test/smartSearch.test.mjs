import assert from 'node:assert/strict';
import test from 'node:test';
import { parseQuery } from '../dist/smartSearch.js';

test('ordinary words that resemble country codes remain searchable', () => {
  const parsed = parseQuery('take it easy');

  assert.equal(parsed.textQuery, 'take it easy');
  assert.equal(parsed.country, null);
});

test('ambiguous country codes require explicit filter syntax', () => {
  const parsed = parseQuery('songs for us with no regrets');

  assert.equal(parsed.textQuery, 'songs for us with no regrets');
  assert.equal(parsed.country, null);
});

test('explicit country codes still produce country filters', () => {
  const parsed = parseQuery('take it easy country:it');

  assert.equal(parsed.textQuery, 'take it easy');
  assert.equal(parsed.country, 'Italy');
});

test('country names and adjectives remain natural-language filters', () => {
  const italian = parseQuery('Italian rock');
  assert.equal(italian.textQuery, 'rock');
  assert.equal(italian.country, 'Italy');

  const unitedStates = parseQuery('hip hop country:"united states"');
  assert.equal(unitedStates.textQuery, 'hip hop');
  assert.equal(unitedStates.country, 'USA');
});
