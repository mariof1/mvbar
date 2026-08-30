import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deactivateRemovedAudiobookLibraries,
  retireRemovedMusicLibraries,
} from '../dist/libraryReconciliation.js';

test('retireRemovedMusicLibraries passes configured roots and normalizes results', async () => {
  const calls = [];
  const database = {
    async query(sql, values) {
      calls.push({ sql, values });
      return {
        rows: [
          {
            id: '12',
            mount_path: 'C:\\Music\\Old',
            retired_tracks: '37',
            deactivated: true,
          },
        ],
      };
    },
  };

  const configuredDirs = ['C:\\Music\\Current', '\\\\nas\\music'];
  const result = await retireRemovedMusicLibraries(database, configuredDirs);

  assert.deepEqual(result, [
    {
      id: 12,
      mountPath: 'C:\\Music\\Old',
      retiredTracks: 37,
      deactivated: true,
    },
  ]);
  assert.deepEqual(calls[0].values, [configuredDirs]);
  assert.match(calls[0].sql, /UPDATE tracks AS track/);
  assert.match(calls[0].sql, /track\.deleted_at IS NULL/);
  assert.match(calls[0].sql, /SET enabled = FALSE/);
});

test('deactivateRemovedAudiobookLibraries supports an empty configured list', async () => {
  const calls = [];
  const database = {
    async query(sql, values) {
      calls.push({ sql, values });
      return {
        rows: [
          {
            id: '8',
            mount_path: 'C:\\Users\\listener\\Audiobooks',
          },
        ],
      };
    },
  };

  const result = await deactivateRemovedAudiobookLibraries(database, []);

  assert.deepEqual(result, [
    {
      id: 8,
      mountPath: 'C:\\Users\\listener\\Audiobooks',
    },
  ]);
  assert.deepEqual(calls[0].values, [[]]);
  assert.match(calls[0].sql, /media_type = 'audiobook'/);
  assert.match(calls[0].sql, /SET enabled = FALSE/);
});
