import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { db, initDb } from '../dist/db.js';
import { missingMusicPlugin, songSearchQuery, MISSING_MUSIC_PLUGIN_ID } from '../dist/pluginSystem/missingMusic.js';
import { registerWebsocketRoutes } from '../dist/websocket.js';

test('song search gates the plugin, checks the permitted library, and sends track requests to admins', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  await initDb();
  const app = Fastify();
  app.addHook('preHandler', async req => {
    if (req.headers['x-user']) req.user = { userId: String(req.headers['x-user']), role: req.headers['x-user'] === 'song_admin' ? 'admin' : 'user', sessionVersion: 0 };
  });
  await app.register(websocket);
  registerWebsocketRoutes(app);
  await app.register(missingMusicPlugin);
  const sockets = [];
  const artist = '11111111-1111-4111-8111-111111111111';
  const ids = [1, 2, 3, 4].map(n => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`);
  let trackIds = [];
  try {
    await db().query(`insert into users(id,email,role) values
      ('song_user','song-user@example.test','user'),('song_admin','song-admin@example.test','admin'),('song_other','song-other@example.test','user')`);
    const library = (await db().query('select id from libraries limit 1')).rows[0].id;
    await db().query("insert into user_libraries(user_id,library_id) values ('song_user',$1)", [library]);
    const request = (url, options = {}) => app.inject({ url, headers: { 'x-user': 'song_user' }, ...options });
    assert.equal((await app.inject('/api/plugins/missing-music/songs/search?q=Wanted')).statusCode, 401);
    assert.equal((await request('/api/plugins/missing-music/songs/search?q=Wanted')).json().enabled, false);
    await db().query(`insert into plugins(id,filename,name,author,version,manifest,enabled,package_sha256,permission_fingerprint)
      values($1,'missing-test.ndp','Missing Music','test','1.1.0',$2,false,'test','test')`,
      [MISSING_MUSIC_PLUGIN_ID, { mvbar: { extension: { type: 'missing-music' } } }]);
    assert.equal((await request('/api/plugins/missing-music/songs/search?q=Wanted')).json().enabled, false);
    await db().query('update plugins set enabled=true where id=$1', [MISSING_MUSIC_PLUGIN_ID]);
    const recordings = ['Wanted Song', 'Cafe del Mar', '世界', 'Tagged Song'].map((title, i) => ({ id: ids[i], title, releases: [{ title: 'Main Album', status: 'Official', 'release-group': { 'primary-type': 'Album' } }], 'artist-credit': [{ name: 'Artist', artist: { id: artist, name: 'Artist' } }] }));
    recordings.unshift({ ...recordings[0], id: '33333333-3333-4333-8333-333333333333', releases: [{ title: 'Single', status: 'Official', 'release-group': { 'primary-type': 'Single' } }] });
    recordings.push({ ...recordings[1], id: '44444444-4444-4444-8444-444444444444', disambiguation: 'live, Wembley' });
    await db().query('insert into plugin_kv(plugin_id,key,value) values($1,$2,$3)', [MISSING_MUSIC_PLUGIN_ID, `musicbrainz:song-search:${songSearchQuery('Wanted Song')}`, Buffer.from(JSON.stringify({ recordings }))]);
    const tracks = await db().query(`insert into tracks(library_id,path,mtime_ms,size_bytes,ext,title,artist,musicbrainz_track_id)
      values($1,'/song-test/cafe',1,1,'mp3','Café del Mar!','Artist',null),
      ($1,'/song-test/unicode',1,1,'mp3','世界','Artist',null),
      ($1,'/song-test/tagged',1,1,'mp3','Different title','Different artist',$2) returning id`, [library, ids[3]]);
    trackIds = tracks.rows.map(row => row.id);
    const searchUrl = '/api/plugins/missing-music/songs/search?q=Wanted%20Song';
    const search = await request(searchUrl);
    assert.equal(search.statusCode, 200);
    assert.equal(search.json().songs[0].recordingId, ids[0]);
    assert.equal(search.json().songs[0].album, 'Main Album');
    assert.deepEqual(search.json().songs.map(song => song.present), [false, true, true, true]);
    const hidden = await request(searchUrl, { headers: { 'x-user': 'song_other' } });
    assert.deepEqual(hidden.json().songs.map(song => song.present), [false, false, false, false]);
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const admin = new WebSocket(base.replace('http', 'ws') + '/api/ws', { headers: { 'x-user': 'song_admin' } });
    sockets.push(admin);
    await once(admin, 'open');
    const notification = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Admin was not notified')), 5000);
      admin.on('message', bytes => { const message = JSON.parse(bytes.toString()); if (message.type === 'missing-music:update') { clearTimeout(timer); resolve(message.data); } });
    });
    const payload = { itemType: 'track', artist: 'Artist', title: 'Wanted Song', musicBrainzArtistId: artist, musicBrainzRecordingId: ids[0] };
    const created = await request('/api/plugins/missing-music/requests', { method: 'POST', payload });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().request.itemType, 'track');
    assert.equal(created.json().request.status, 'requested');
    const event = await notification;
    assert.equal(event.title, 'Wanted Song');
    assert.match(event.message, /Artist.*Wanted Song/);
    assert.equal((await request(searchUrl)).json().songs[0].requested, true);
    assert.equal((await request('/api/plugins/missing-music/requests', { method: 'POST', payload })).statusCode, 409);
    await db().query('delete from plugin_media_requests where plugin_id=$1', [MISSING_MUSIC_PLUGIN_ID]);
    const concurrent = await Promise.all([1, 2].map(() => request('/api/plugins/missing-music/requests', { method: 'POST', payload })));
    assert.deepEqual(concurrent.map(result => result.statusCode).sort(), [201, 409]);
    const present = await request('/api/plugins/missing-music/requests', { method: 'POST', payload: { ...payload, title: 'Café del Mar', musicBrainzRecordingId: ids[1] } });
    assert.equal(present.statusCode, 409);
    assert.equal(present.json().present, true);
    await db().query('update plugins set enabled=false where id=$1', [MISSING_MUSIC_PLUGIN_ID]);
    assert.equal((await request('/api/plugins/missing-music/requests', { method: 'POST', payload })).statusCode, 404);
  } finally {
    for (const socket of sockets) socket.terminate();
    await app.close();
    await db().query('delete from plugins where id=$1', [MISSING_MUSIC_PLUGIN_ID]);
    await db().query("delete from users where id in ('song_user','song_admin','song_other')");
    await db().query('delete from tracks where id=any($1::bigint[])', [trackIds]);
    await db().end();
  }
});
