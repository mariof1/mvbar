import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  isSafeArchivePath,
  isSafeBackupName,
  sortTablesByDependencies,
  transformRestoreRow,
} from '../dist/backup.js';

test('portable backup paths reject traversal and platform-specific absolute paths', () => {
  assert.equal(isSafeArchivePath('database/users.jsonl'), true);
  assert.equal(isSafeArchivePath('cache/art/album/cover.jpg'), true);
  assert.equal(isSafeArchivePath('../config.env'), false);
  assert.equal(isSafeArchivePath('cache/art/../../config.env'), false);
  assert.equal(isSafeArchivePath('/etc/passwd'), false);
  assert.equal(isSafeArchivePath('C:/Users/Admin/config.env'), false);
  assert.equal(isSafeArchivePath('cache\\art\\cover.jpg'), false);
});

test('portable restore orders referenced tables before dependent tables', () => {
  const tables = [
    { name: 'playlist_items', columns: [], dependencies: ['playlists', 'tracks'] },
    { name: 'users', columns: [], dependencies: [] },
    { name: 'playlists', columns: [], dependencies: ['users'] },
    { name: 'tracks', columns: [], dependencies: [] },
  ];
  const order = sortTablesByDependencies(tables);
  assert.ok(order.indexOf('users') < order.indexOf('playlists'));
  assert.ok(order.indexOf('playlists') < order.indexOf('playlist_items'));
  assert.ok(order.indexOf('tracks') < order.indexOf('playlist_items'));
});

test('server backup names cannot escape the configured backup directory', () => {
  assert.equal(isSafeBackupName('mvbar-backup-2026-08-07T18-00-00-000Z.mvbar-backup'), true);
  assert.equal(isSafeBackupName('../mvbar-backup.mvbar-backup'), false);
  assert.equal(isSafeBackupName('folder/mvbar-backup.mvbar-backup'), false);
  assert.equal(isSafeBackupName('folder\\mvbar-backup.mvbar-backup'), false);
  assert.equal(isSafeBackupName('mvbar-backup.zip'), false);
});

test('database-only restores remove references to omitted cache files', () => {
  const context = {
    restoreCaches: false,
    libraryMapping: new Map(),
    podcastRoot: '/podcasts',
  };

  assert.deepEqual(
    transformRestoreRow('tracks', {
      art_path: 'aa/cover.jpg',
      art_mime: 'image/jpeg',
      art_hash: 'abc',
      lyrics_path: 'lyrics/song.lrc',
    }, context),
    { art_path: null, art_mime: null, art_hash: null, lyrics_path: null },
  );
  assert.equal(transformRestoreRow('artists', { art_path: 'artist.jpg', art_hash: 'hash' }, context).art_path, null);
  assert.equal(transformRestoreRow('users', { avatar_path: 'user.jpg' }, context).avatar_path, null);
  assert.equal(transformRestoreRow('podcasts', { image_path: 'podcasts/show.jpg' }, context).image_path, null);
  assert.equal(transformRestoreRow('podcast_episodes', { image_path: 'episodes/one.jpg' }, context).image_path, null);
  assert.equal(transformRestoreRow('audiobooks', { cover_path: 'books/cover.jpg' }, context).cover_path, null);
});

test('cache-inclusive restores retain cache references and remap podcast downloads', () => {
  const context = {
    restoreCaches: true,
    libraryMapping: new Map(),
    podcastRoot: '/srv/podcasts',
  };
  const restored = transformRestoreRow('podcast_episodes', {
    podcast_id: 42,
    image_path: 'episodes/cover.jpg',
    downloaded_path: 'C:\\old\\episode.mp3',
  }, context);
  assert.equal(restored.image_path, 'episodes/cover.jpg');
  assert.equal(restored.downloaded_path, path.join('/srv/podcasts', '42', 'episode.mp3'));
});
