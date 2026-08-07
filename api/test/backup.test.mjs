import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeArchivePath, sortTablesByDependencies } from '../dist/backup.js';

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
