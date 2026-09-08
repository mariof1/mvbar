import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { db, initDb } from '../dist/db.js';
import { browsePlugin } from '../dist/browse.js';

test('albumless tracks are browseable without changing tags or leaking libraries', { skip: !process.env.TEST_DATABASE_URL }, async () => {
 process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
 await initDb();const app=Fastify();
 app.addHook('preHandler',async req=>{req.user={userId:'albumless_probe',role:'user',sessionVersion:0};});
 await app.register(browsePlugin);
 let tracks=[],artists=[];
 try {
  await db().query("insert into users(id,email,role) values('albumless_probe','albumless@example.test','user')");
  const library=(await db().query('select id from libraries limit 1')).rows[0].id;
  await db().query("insert into user_libraries(user_id,library_id) values('albumless_probe',$1)",[library]);
  artists=(await db().query("insert into artists(name) values('Albumless Night'),('Albumless Other') returning id")).rows.map(a=>a.id);
  for (const [i,album] of [null,'','   ','Real Album',null].entries()) {
   const artist=i===4?'Albumless Other':'Albumless Night';
   const row=(await db().query("insert into tracks(library_id,path,mtime_ms,size_bytes,ext,title,artist,album,created_at) values($1,$2,1,1,'mp3',$3,$4,$5,$6) returning id",[library,`/albumless-probe/${i}`,`Song ${i}`,artist,album,i===0?'2000-01-01':i===1?'2099-01-01':'2020-01-01'])).rows[0];tracks.push(row.id);
   await db().query("insert into track_artists(track_id,artist_id,role,position) values($1,$2,'artist',0)",[row.id,artists[i===4?1:0]]);
  }
  const list=await app.inject('/api/browse/albums?q=Albumless&sort=created&limit=1');
  assert.equal(list.statusCode,200,list.body);
  assert.equal(list.json().total,3);
  assert.equal(list.json().albums[0].album,'Unknown Album — Albumless Night');
  assert.equal(list.json().albums[0].track_count,3);
  const artistCounts=(await app.inject('/api/browse/artists?q=Albumless&sort=albums_desc')).json().artists;
  assert.equal(artistCounts.find(a=>a.name==='Albumless Night').album_count,2);
  assert.equal(artistCounts.find(a=>a.name==='Albumless Other').album_count,1);
  assert.equal(artistCounts[0].name,'Albumless Night');
  const letter=(await app.inject('/api/browse/albums?q=Albumless&letter=u')).json();assert.equal(letter.total,2);
  const detail=await app.inject('/api/browse/album?album='+encodeURIComponent('Unknown Album — Albumless Night'));
  assert.equal(detail.statusCode,200,detail.body);assert.equal(detail.json().tracks.length,3);
  assert.deepEqual(detail.json().tracks.map(t=>String(t.id)).sort(),tracks.slice(0,3).map(String).sort());
  assert.equal(detail.json().tracks.find(t=>String(t.id)===String(tracks[0])).album,null);
  const artist=await app.inject('/api/browse/artist/'+artists[0]);
  assert.equal(artist.statusCode,200,artist.body);
  assert.ok(artist.json().albums.some(a=>a.album==='Unknown Album — Albumless Night'&&a.track_count===3));
  const scoped=await app.inject('/api/browse/album?album='+encodeURIComponent('Unknown Album — Albumless Night')+'&artistId='+artists[0]);
  assert.equal(scoped.statusCode,200,scoped.body);
  await db().query("delete from user_libraries where user_id='albumless_probe'");
  assert.equal((await app.inject('/api/browse/albums?q=Albumless')).json().total,0);
  assert.equal((await app.inject('/api/browse/album?album='+encodeURIComponent('Unknown Album — Albumless Night'))).statusCode,404);
 } finally {
  await app.close();await db().query('delete from tracks where id=any($1::bigint[])',[tracks]);await db().query('delete from artists where id=any($1::bigint[])',[artists]);await db().query("delete from users where id='albumless_probe'");await db().end();
 }
});
