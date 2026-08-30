import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  isSafeArchivePath,
  isSafeAvatarFilename,
  isSafeBackupName,
  sessionPreservationError,
  sessionSigningKeyFingerprint,
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

test('account avatar filenames cannot escape the avatar directory', () => {
  assert.equal(isSafeAvatarFilename('u_123.jpg'), true);
  assert.equal(isSafeAvatarFilename('../u_123.jpg'), false);
  assert.equal(isSafeAvatarFilename('nested/u_123.jpg'), false);
  assert.equal(isSafeAvatarFilename('nested\\u_123.jpg'), false);
  assert.equal(isSafeAvatarFilename('..'), false);
});

test('session preservation requires a matching signing key and cookie name', () => {
  const secret = 'a-long-random-session-signing-secret';
  const auth = {
    tokenFormat: 'mvbar-hs256-v1',
    signingKeyFingerprint: sessionSigningKeyFingerprint(secret),
    cookieName: 'mvbar_token',
  };

  assert.equal(sessionPreservationError(auth, secret, 'mvbar_token'), null);
  assert.match(sessionPreservationError(undefined, secret, 'mvbar_token'), /predates/);
  assert.match(sessionPreservationError(auth, 'different-secret', 'mvbar_token'), /JWT_SECRET/);
  assert.match(sessionPreservationError(auth, secret, 'other_cookie'), /COOKIE_NAME/);
  assert.match(sessionPreservationError({ ...auth, cookieName: 'bad cookie' }, secret, 'mvbar_token'), /invalid/);
});

test('database-only restores remove references to omitted cache files', () => {
  const context = {
    restoreCaches: false,
    avatarFiles: new Set(),
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

test('database-only restores retain account avatars included in the archive', () => {
  const context = {
    restoreCaches: false,
    avatarFiles: new Set(['u_123.jpg']),
    libraryMapping: new Map(),
    podcastRoot: '/podcasts',
  };

  assert.equal(transformRestoreRow('users', { avatar_path: 'u_123.jpg' }, context).avatar_path, 'u_123.jpg');
  assert.equal(transformRestoreRow('users', { avatar_path: 'missing.jpg' }, context).avatar_path, null);
});

test('cache-inclusive restores retain cache references and remap podcast downloads', () => {
  const context = {
    restoreCaches: true,
    avatarFiles: new Set(),
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
