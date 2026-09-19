import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { probeWritableDirectory } from '../dist/libraryWritability.js';

test('writable directory probe requires a real create and delete', async () => {
  const calls = [];
  const handle = { async close() { calls.push('close'); } };
  const fsOps = {
    async open(target, flags, mode) {
      calls.push(['open', target, flags, mode]);
      return handle;
    },
    async unlink(target) {
      calls.push(['unlink', target]);
    },
  };

  assert.equal(await probeWritableDirectory('/music', fsOps), true);
  assert.equal(calls[0][0], 'open');
  assert.equal(calls[0][2], 'wx');
  assert.equal(calls[0][3], 0o600);
  assert.equal(calls[0][1].startsWith(path.join('/music', '.mvbar-write-probe-')), true);
  assert.equal(calls.includes('close'), true);
  assert.equal(calls.filter((call) => Array.isArray(call) && call[0] === 'unlink').length >= 1, true);
});

test('writable directory probe returns false when the mount rejects creation', async () => {
  const calls = [];
  const fsOps = {
    async open() {
      const error = new Error('Read-only file system');
      error.code = 'EROFS';
      throw error;
    },
    async unlink(target) {
      calls.push(target);
    },
  };

  assert.equal(await probeWritableDirectory('/music', fsOps), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].startsWith(path.join('/music', '.mvbar-write-probe-')), true);
});
