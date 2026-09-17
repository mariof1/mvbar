import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { configuredMusicRoots } from '../dist/musicRoots.js';
import { retireUnavailableStagingTracks } from '../dist/libraryReconciliation.js';

test('Deezer staging is isolated from ordinary music roots and works without an ARL', () => {
  const music = path.resolve('music');
  const staging = path.resolve('staging');
  assert.deepEqual(configuredMusicRoots({ MUSIC_DIRS: music, DEEZER_DOWNLOAD_DIR: staging }), {
    directories: [music, staging], stagingDirectory: staging, overlap: false,
  });
  assert.deepEqual(configuredMusicRoots({ MUSIC_DIRS: music, DEEZER_DOWNLOAD_DIR: path.join(music, 'incoming') }), {
    directories: [music], stagingDirectory: null, overlap: true,
  });
  assert.deepEqual(configuredMusicRoots({ MUSIC_DIRS: path.join(staging, 'music'), DEEZER_DOWNLOAD_DIR: staging }), {
    directories: [path.join(staging, 'music')], stagingDirectory: null, overlap: true,
  });
});

test('a missing staging mount retires only Missing Music tracks and returns IDs for search removal', async () => {
  const calls = [];
  const database = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ id: '42' }, { id: '43' }] };
    },
  };
  assert.deepEqual(await retireUnavailableStagingTracks(database, '/data/deezer-staging'), [42, 43]);
  assert.deepEqual(calls[0].values, ['/data/deezer-staging', 'mvbar.missing-music']);
  assert.match(calls[0].sql, /source_plugin_id = \$2/);
  assert.match(calls[0].sql, /deleted_at IS NULL/);
});
