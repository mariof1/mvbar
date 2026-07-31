import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSearchPlan } from '../dist/ai.js';

test('parseSearchPlan accepts a structured OpenRouter response', () => {
  assert.deepEqual(
    parseSearchPlan(
      JSON.stringify({
        searchQuery: 'Polish rock 80s',
        explanation: 'Focused the request on country, genre and decade.',
      }),
      'find me Polish rock from the eighties'
    ),
    {
      searchQuery: 'Polish rock 80s',
      explanation: 'Focused the request on country, genre and decade.',
    }
  );
});

test('parseSearchPlan tolerates a fenced JSON response', () => {
  assert.equal(
    parseSearchPlan('```json\n{"searchQuery":"Massive Attack chill","explanation":"Kept the artist and mood."}\n```', 'fallback').searchQuery,
    'Massive Attack chill'
  );
});

test('parseSearchPlan safely falls back when the response is invalid', () => {
  assert.deepEqual(parseSearchPlan('not-json', 'Blue Monday'), {
    searchQuery: 'Blue Monday',
    explanation: 'AI could not refine the request, so the original wording was used.',
  });
});
