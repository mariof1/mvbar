import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { validateSmartPlaylistFilters as validate } from '../dist/smartPlaylistValidation.js';
import { smartPlaylistsPlugin } from '../dist/smartPlaylists.js';

for (const [label, filters] of [
  ['negative limit', { maxResults: -1 }],
  ['zero limit', { maxResults: 0 }],
  ['oversized limit', { maxResults: 2001 }],
  ['fractional limit', { maxResults: 1.5 }],
  ['malformed limit', { maxResults: '12garbage' }],
  ['reversed duration', { duration: { min: 600, max: 60 } }],
  ['reversed BPM', { bpm: { min: 150, max: 80 } }],
  ['reversed dates', { dateAdded: { from: '2026-09-06', to: '2026-01-01' } }],
  ['invalid date', { dateAdded: { from: '2026-02-30' } }],
]) {
  test(`rejects ${label} before writing a playlist`, async () => {
    assert.equal(typeof validate(filters), 'string');
    const app = Fastify();
    app.addHook('preHandler', async req => { req.user = { userId: 'validation-test', role: 'user' }; });
    await app.register(smartPlaylistsPlugin);
    try {
      const response = await app.inject({ method: 'POST', url: '/api/smart-playlists', payload: { name: 'Invalid', filters } });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error, validate(filters));
    } finally { await app.close(); }
  });
}

test('accepts empty, one-sided, equal and boundary ranges', () => {
  for (const filters of [{}, {maxResults: null}, {maxResults: 1}, {maxResults: 2000},
    {duration: {min: 0, max: 86400}}, {duration: {min: 60, max: 60}},
    {bpm: {max: 400}}, {dateAdded: {from: '2024-02-29', to: '2024-02-29'}}]) {
    assert.equal(validate(filters), null);
  }
});
