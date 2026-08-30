import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { db, initDb } from '../dist/db.js';
import { socialPlugin } from '../dist/social.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('friend requests and track sharing enforce friendship and library access', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  await initDb();

  await db().query("delete from users where id in ('social_a','social_b','social_c')");
  await db().query(`
    insert into users(id, email, role, approval_status)
    values
      ('social_a', 'alice@example.test', 'user', 'approved'),
      ('social_b', 'bob@example.test', 'user', 'approved'),
      ('social_c', 'casey@example.test', 'user', 'approved')
  `);
  const library = await db().query("select id from libraries where mount_path='/music'");
  const libraryId = Number(library.rows[0].id);
  await db().query("delete from tracks where library_id=$1 and path='/music/shared.flac'", [libraryId]);
  await db().query(
    `insert into user_libraries(user_id, library_id) values ('social_a',$1),('social_b',$1)`,
    [libraryId],
  );
  const track = await db().query(
    `insert into tracks(library_id, path, mtime_ms, size_bytes, ext, title, artist, album)
     values ($1, '/music/shared.flac', 1, 1, 'flac', 'Shared Song', 'Test Artist', 'Test Album')
     returning id`,
    [libraryId],
  );
  const trackId = Number(track.rows[0].id);

  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const userId = String(request.headers['x-test-user'] || '');
    if (userId) request.user = { userId, role: 'user', sessionVersion: 0 };
  });
  await app.register(socialPlugin);

  const request = await app.inject({
    method: 'POST',
    url: '/api/social/friend-requests',
    headers: { 'x-test-user': 'social_a' },
    payload: { userId: 'social_b' },
  });
  assert.equal(request.statusCode, 201);
  const relationshipId = request.json().request.relationshipId;

  const reverseRequest = await app.inject({
    method: 'POST',
    url: '/api/social/friend-requests',
    headers: { 'x-test-user': 'social_b' },
    payload: { userId: 'social_a' },
  });
  assert.equal(reverseRequest.statusCode, 409);
  assert.equal(reverseRequest.json().error, 'incoming_request');

  const search = await app.inject({
    method: 'GET',
    url: '/api/social/users?q=bob%40',
    headers: { 'x-test-user': 'social_a' },
  });
  assert.equal(search.statusCode, 200);
  assert.equal(search.json().users[0].id, 'social_b');
  assert.equal(search.json().users[0].relationship, 'outgoing');

  const escapedWildcardSearch = await app.inject({
    method: 'GET',
    url: '/api/social/users?q=%25%25',
    headers: { 'x-test-user': 'social_a' },
  });
  assert.deepEqual(escapedWildcardSearch.json().users, []);

  const beforeAccept = await app.inject({
    method: 'GET',
    url: '/api/social/summary',
    headers: { 'x-test-user': 'social_b' },
  });
  assert.equal(beforeAccept.json().incoming.length, 1);

  const accept = await app.inject({
    method: 'POST',
    url: `/api/social/friend-requests/${relationshipId}/accept`,
    headers: { 'x-test-user': 'social_b' },
  });
  assert.equal(accept.statusCode, 200);

  const inaccessibleRequest = await app.inject({
    method: 'POST',
    url: '/api/social/friend-requests',
    headers: { 'x-test-user': 'social_a' },
    payload: { userId: 'social_c' },
  });
  const inaccessibleRelationshipId = inaccessibleRequest.json().request.relationshipId;
  const inaccessibleAccept = await app.inject({
    method: 'POST',
    url: `/api/social/friend-requests/${inaccessibleRelationshipId}/accept`,
    headers: { 'x-test-user': 'social_c' },
  });
  assert.equal(inaccessibleAccept.statusCode, 200);

  const targets = await app.inject({
    method: 'GET',
    url: `/api/social/share-targets/${trackId}`,
    headers: { 'x-test-user': 'social_a' },
  });
  assert.deepEqual(
    targets.json().friends.map((friend) => [friend.id, friend.canAccess]),
    [['social_b', true], ['social_c', false]],
  );

  const share = await app.inject({
    method: 'POST',
    url: '/api/social/shares',
    headers: { 'x-test-user': 'social_a' },
    payload: { trackId, recipientIds: ['social_b'], message: 'You may like this' },
  });
  assert.equal(share.statusCode, 201);
  assert.equal(share.json().shared, 1);

  const inbox = await app.inject({
    method: 'GET',
    url: '/api/social/shares',
    headers: { 'x-test-user': 'social_b' },
  });
  assert.equal(inbox.statusCode, 200);
  assert.equal(inbox.json().unread, 1);
  assert.equal(inbox.json().shares[0].track.title, 'Shared Song');
  assert.equal(inbox.json().shares[0].message, 'You may like this');

  const unavailable = await app.inject({
    method: 'POST',
    url: '/api/social/shares',
    headers: { 'x-test-user': 'social_a' },
    payload: { trackId, recipientIds: ['social_c'] },
  });
  assert.equal(unavailable.statusCode, 409);
  assert.equal(unavailable.json().error, 'recipient_unavailable');

  const shareId = inbox.json().shares[0].id;
  const read = await app.inject({
    method: 'POST',
    url: `/api/social/shares/${shareId}/read`,
    headers: { 'x-test-user': 'social_b' },
  });
  assert.equal(read.statusCode, 200);

  const afterRead = await app.inject({
    method: 'GET',
    url: '/api/social/summary',
    headers: { 'x-test-user': 'social_b' },
  });
  assert.equal(afterRead.json().unreadShares, 0);

  await app.close();
  await db().end();
});
