import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { resolveInside } from '../dist/pathSafety.js';

test('resolveInside accepts children and rejects traversal or sibling paths', () => {
  const base = path.resolve('test-library');
  assert.equal(resolveInside(base, path.join('Artist', 'track.mp3')), path.join(base, 'Artist', 'track.mp3'));
  assert.throws(() => resolveInside(base, path.join('..', 'private', 'track.mp3')), /invalid path/);
  assert.throws(() => resolveInside(base, ''), /invalid path/);
  assert.equal(resolveInside(base, '', true), base);
});

test('resolveInside handles a Windows UNC share root', { skip: process.platform !== 'win32' }, () => {
  const base = String.raw`\\media-server.local\music`;
  assert.equal(
    resolveInside(base, String.raw`Artist\Album\track.mp3`),
    String.raw`\\media-server.local\music\Artist\Album\track.mp3`
  );
});
