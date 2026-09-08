import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { db, initDb } from '../dist/db.js';
import { favoritesPlugin } from '../dist/favorites.js';
import { addFavorite, listFavorites, moveFavorite, removeFavorite } from '../dist/favoritesRepo.js';

test('favorites retain a shared order without losing unseen items or crossing user boundaries', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  await initDb();
  const app = Fastify();
  app.addHook('preHandler', async req => {
    if (req.headers['x-test-user']) req.user = { userId: String(req.headers['x-test-user']), role: req.headers['x-test-role'] === 'user' ? 'user' : 'admin', sessionVersion: 0 };
  });
  await app.register(favoritesPlugin);
  let ids = [];
  try {
    await db().query(`insert into users(id,email,role) values ('favorite_order_a','favorite-order-a@example.test','admin'), ('favorite_order_b','favorite-order-b@example.test','admin')`);
    const library = (await db().query('select id from libraries limit 1')).rows[0].id;
    const result = await db().query(`insert into tracks(library_id,path,mtime_ms,size_bytes,ext,title)
      select $1, '/favorites-test/' || n, 1, 1, 'mp3', 'Favorite ' || n from generate_series(1,205) n returning id`, [library]);
    ids = result.rows.map(row => Number(row.id));
    for (const id of ids) await addFavorite('favorite_order_a', id);
    await addFavorite('favorite_order_b', ids[0]);
    const order = async user => (await listFavorites(user, 1000, 0, null)).map(t => Number(t.id));
    const original = await order('favorite_order_a');
    const listing = await app.inject({ url: '/api/favorites', headers: { 'x-test-user': 'favorite_order_a' } });
    assert.equal(typeof listing.json().tracks[0].id, 'number');
    assert.equal(original.length, 205);
    const moving = original[0];
    // Move to the end of the first page using the next page's anchor.
    assert.equal(await moveFavorite('favorite_order_a', moving, original[200]), true);
    const expected = [...original.slice(1, 200), moving, ...original.slice(200)];
    assert.deepEqual(await order('favorite_order_a'), expected);
    assert.deepEqual((await listFavorites('favorite_order_a', 5, 200, null)).map(t => Number(t.id)), expected.slice(200));
    assert.deepEqual(await order('favorite_order_b'), [ids[0]]);
    assert.equal(await moveFavorite('favorite_order_a', moving, null), true);
    assert.equal((await order('favorite_order_a')).at(-1), moving);
    assert.equal(await moveFavorite('favorite_order_a', moving, moving), true);
    const beforeFailure = await order('favorite_order_a');
    assert.equal(await moveFavorite('favorite_order_b', ids[0], ids[1]), false);
    assert.deepEqual(await order('favorite_order_a'), beforeFailure);
    await Promise.all([moveFavorite('favorite_order_a', ids[1], ids[2]), moveFavorite('favorite_order_a', ids[3], ids[4])]);
    const concurrent = await order('favorite_order_a');
    assert.equal(concurrent.indexOf(ids[1]) + 1, concurrent.indexOf(ids[2]));
    assert.equal(concurrent.indexOf(ids[3]) + 1, concurrent.indexOf(ids[4]));
    await removeFavorite('favorite_order_a', ids[10]);
    await addFavorite('favorite_order_a', ids[10]);
    assert.equal((await order('favorite_order_a'))[0], ids[10]);
    const request = (payload, user = 'favorite_order_a') => app.inject({ method: 'POST', url: '/api/favorites/reorder', headers: user ? { 'x-test-user': user } : {}, payload });
    assert.equal((await request({ trackId: ids[0], beforeTrackId: null }, null)).statusCode, 401);
    for (const payload of [{}, { trackId: ids[0] }, { trackId: '1', beforeTrackId: null }, { trackId: -1, beforeTrackId: null }]) {
      assert.equal((await request(payload)).statusCode, 400);
    }
    assert.equal((await request({ trackId: ids[1], beforeTrackId: null }, 'favorite_order_b')).statusCode, 409);
    assert.equal((await request({ trackId: ids[0], beforeTrackId: ids[1] })).statusCode, 200);
    assert.equal((await request({ trackId: Number.MAX_SAFE_INTEGER, beforeTrackId: null })).statusCode, 404);
    const restricted = await app.inject({ method: 'POST', url: '/api/favorites/reorder', headers: { 'x-test-user': 'favorite_order_a', 'x-test-role': 'user' }, payload: { trackId: ids[0], beforeTrackId: null } });
    assert.equal(restricted.statusCode, 404);
  } finally {
    await app.close();
    await db().query("delete from users where id in ('favorite_order_a','favorite_order_b')");
    await db().query('delete from tracks where id=any($1::bigint[])', [ids]);
    await db().end();
  }
});
