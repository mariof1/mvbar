import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { db, initDb } from '../dist/db.js';
import { playlistsPlugin } from '../dist/playlists.js';
import { socialPlugin } from '../dist/social.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

test('collaborative playlists are limited to accepted friends and visible libraries', { skip: !databaseUrl }, async () => {
  process.env.DATABASE_URL = databaseUrl;
  await initDb();

  const userIds = ['playlist_owner', 'playlist_friend', 'playlist_stranger'];
  await db().query('delete from playlists where user_id=any($1::text[])', [userIds]);
  await db().query('delete from users where id=any($1::text[])', [userIds]);
  await db().query(`
    insert into users(id, email, role, approval_status)
    values
      ('playlist_owner', 'playlist-owner@example.test', 'user', 'approved'),
      ('playlist_friend', 'playlist-friend@example.test', 'user', 'approved'),
      ('playlist_stranger', 'playlist-stranger@example.test', 'user', 'approved')
  `);
  const libraries = await db().query(`
    insert into libraries(mount_path, enabled)
    values ('/collab-visible', true), ('/collab-owner-only', true)
    on conflict (mount_path) do update set enabled=true
    returning id, mount_path
  `);
  const visibleLibraryId = Number(libraries.rows.find((row) => row.mount_path === '/collab-visible').id);
  const ownerOnlyLibraryId = Number(libraries.rows.find((row) => row.mount_path === '/collab-owner-only').id);
  await db().query(
    "delete from tracks where path in ('/collab-visible/song.flac', '/collab-owner-only/song.flac')",
  );
  await db().query(
    `insert into user_libraries(user_id, library_id)
     values
       ('playlist_owner',$1), ('playlist_owner',$2), ('playlist_friend',$1)`,
    [visibleLibraryId, ownerOnlyLibraryId],
  );
  const tracks = await db().query(
    `insert into tracks(library_id, path, mtime_ms, size_bytes, ext, title)
     values
       ($1, '/collab-visible/song.flac', 1, 1, 'flac', 'Visible collaboration song'),
       ($2, '/collab-owner-only/song.flac', 1, 1, 'flac', 'Owner-only song')
     returning id, library_id`,
    [visibleLibraryId, ownerOnlyLibraryId],
  );
  const visibleTrackId = Number(tracks.rows.find((row) => Number(row.library_id) === visibleLibraryId).id);
  const ownerOnlyTrackId = Number(tracks.rows.find((row) => Number(row.library_id) === ownerOnlyLibraryId).id);
  const friendship = await db().query(
    `insert into friendships(requester_id, addressee_id, status, responded_at)
     values ('playlist_owner', 'playlist_friend', 'accepted', now())
     returning id`,
  );

  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const userId = String(request.headers['x-test-user'] || '');
    if (userId) request.user = { userId, role: 'user', sessionVersion: 0 };
  });
  await app.register(socialPlugin);
  await app.register(playlistsPlugin);

  const created = await app.inject({
    method: 'POST',
    url: '/api/playlists',
    headers: { 'x-test-user': 'playlist_owner' },
    payload: { name: 'Plane mixes' },
  });
  assert.equal(created.statusCode, 200);
  const playlistId = Number(created.json().playlist.id);

  const beforeInvite = await app.inject({
    method: 'GET',
    url: `/api/playlists/${playlistId}/items`,
    headers: { 'x-test-user': 'playlist_friend' },
  });
  assert.equal(beforeInvite.statusCode, 404);

  const strangerInvite = await app.inject({
    method: 'POST',
    url: `/api/playlists/${playlistId}/collaborators`,
    headers: { 'x-test-user': 'playlist_owner' },
    payload: { userId: 'playlist_stranger' },
  });
  assert.equal(strangerInvite.statusCode, 409);

  const invite = await app.inject({
    method: 'POST',
    url: `/api/playlists/${playlistId}/collaborators`,
    headers: { 'x-test-user': 'playlist_owner' },
    payload: { userId: 'playlist_friend' },
  });
  assert.equal(invite.statusCode, 201);
  assert.equal(invite.json().collaborator.user.email, 'playlist-friend@example.test');

  const friendPlaylists = await app.inject({
    method: 'GET',
    url: '/api/playlists',
    headers: { 'x-test-user': 'playlist_friend' },
  });
  assert.equal(friendPlaylists.statusCode, 200);
  assert.equal(friendPlaylists.json().playlists.length, 1);
  assert.equal(friendPlaylists.json().playlists[0].is_owner, false);
  assert.equal(friendPlaylists.json().playlists[0].owner.email, 'playlist-owner@example.test');

  const addVisible = await app.inject({
    method: 'POST',
    url: `/api/playlists/${playlistId}/items`,
    headers: { 'x-test-user': 'playlist_friend' },
    payload: { trackId: visibleTrackId },
  });
  assert.equal(addVisible.statusCode, 200);

  const addHidden = await app.inject({
    method: 'POST',
    url: `/api/playlists/${playlistId}/items`,
    headers: { 'x-test-user': 'playlist_friend' },
    payload: { trackId: ownerOnlyTrackId },
  });
  assert.equal(addHidden.statusCode, 404);

  const ownerAddsHidden = await app.inject({
    method: 'POST',
    url: `/api/playlists/${playlistId}/items`,
    headers: { 'x-test-user': 'playlist_owner' },
    payload: { trackId: ownerOnlyTrackId },
  });
  assert.equal(ownerAddsHidden.statusCode, 200);

  const friendItems = await app.inject({
    method: 'GET',
    url: `/api/playlists/${playlistId}/items`,
    headers: { 'x-test-user': 'playlist_friend' },
  });
  assert.equal(friendItems.statusCode, 200);
  assert.equal(friendItems.json().items.length, 1);
  assert.equal(friendItems.json().items[0].added_by.email, 'playlist-friend@example.test');

  const forbiddenRename = await app.inject({
    method: 'PATCH',
    url: `/api/playlists/${playlistId}`,
    headers: { 'x-test-user': 'playlist_friend' },
    payload: { name: 'Not allowed' },
  });
  assert.equal(forbiddenRename.statusCode, 404);

  const removeFriend = await app.inject({
    method: 'DELETE',
    url: '/api/social/friends/playlist_friend',
    headers: { 'x-test-user': 'playlist_owner' },
  });
  assert.equal(removeFriend.statusCode, 200);
  const afterUnfriend = await app.inject({
    method: 'GET',
    url: `/api/playlists/${playlistId}/items`,
    headers: { 'x-test-user': 'playlist_friend' },
  });
  assert.equal(afterUnfriend.statusCode, 404);
  const membership = await db().query(
    'select 1 from playlist_collaborators where friendship_id=$1',
    [Number(friendship.rows[0].id)],
  );
  assert.equal(membership.rowCount, 0);

  await app.close();
  await db().end();
});
