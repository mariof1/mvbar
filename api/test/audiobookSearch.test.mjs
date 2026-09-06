import assert from 'node:assert/strict';
import test from 'node:test';
import { audiobookSearchQuery } from '../dist/audiobookSearch.js';

test('empty queries and empty library permissions do not search', () => {
  assert.equal(audiobookSearchQuery('  ', null), null);
  assert.equal(audiobookSearchQuery('Orwell', []), null);
});
test('title and author terms are combined within the allowed active libraries', () => {
  const result = audiobookSearchQuery('  George   Orwell ', [3, 7]);
  assert.deepEqual(result.params, [[3, 7], '%George%', '%Orwell%']);
  assert.match(result.sql, /active_audiobooks/);
  assert.match(result.sql, /a.library_id = ANY\(\$1::bigint\[\]\)/);
  assert.match(result.sql, /a.title, a.author/);
  assert.match(result.sql, /ILIKE \$2\) AND .*ILIKE \$3/);
});
test('wildcards and quotes are literal parameter values', () => {
  const result = audiobookSearchQuery("100% a_b O'Reilly", null);
  assert.deepEqual(result.params, [null, '%100\\%%', '%a\\_b%', "%O'Reilly%"]);
  assert.ok(!result.sql.includes("O'Reilly"));
});
test('queries are bounded for large input', () => {
  const result = audiobookSearchQuery('word '.repeat(100), null);
  assert.equal(result.params.length, 13);
  assert.match(result.sql, /LIMIT 12/);
});
