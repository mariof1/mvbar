'use strict';

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTags } from '../dist/metadata.js';

const python = process.env.MVBAR_METADATA_TEST_PYTHON || 'python3';
const editor = path.resolve(process.cwd(), '../api/scripts/edit_audio_metadata.py');

function available(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return result.status === 0;
}

const canRun = available(python, ['-c', 'import mutagen']) && available('ffmpeg', ['-version']);

async function roundTrip(extension) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvbar-meta-roundtrip-'));
  const file = path.join(dir, 'track.' + extension);
  try {
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25',
      '-y', file,
    ]);

    const payload = {
      title: 'Żółć 世界',
      artists: ['Artist A', 'Artist B'],
      album: 'Test Album',
      albumArtists: ['Album Artist'],
      genres: ['Electronic', 'Dance'],
      countries: ['Poland'],
      languages: ['Polish', 'English'],
      trackNumber: 3,
      trackTotal: 14,
      discNumber: 1,
      discTotal: 2,
      releaseDate: '2001-03-07',
      originalYear: 1999,
      bpm: 128,
      initialKey: 'F#m',
      composers: ['Composer One'],
      conductors: ['Conductor One'],
      publisher: 'Test Label',
      mood: 'Energetic',
      grouping: 'Test Group',
      isrc: 'GBDUW0000053',
      compilation: true,
      titleSort: 'Zolc',
      artistSort: 'Artist A',
      albumSort: 'Test Album',
      albumArtistSort: 'Album Artist',
      musicbrainzTrackId: '11111111-1111-1111-1111-111111111111',
      musicbrainzReleaseId: '22222222-2222-2222-2222-222222222222',
    };

    const result = spawnSync(python, [editor, file], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || 'metadata editor failed for ' + extension);

    const tags = await readTags(file);
    assert.equal(tags.title, payload.title);
    assert.equal(tags.album, payload.album);
    assert.ok(tags.artists.includes('Artist A'), extension + ': Artist A missing from ' + tags.artists.join(', '));
    assert.ok(tags.artists.includes('Artist B'), extension + ': Artist B missing from ' + tags.artists.join(', '));
    assert.ok(tags.albumartists.includes('Album Artist'), extension + ': album artist missing');
    assert.ok((tags.genre || '').includes('Electronic'), extension + ': genre missing');
    assert.ok((tags.country || '').includes('Poland'), extension + ': country missing');
    assert.ok((tags.language || '').includes('Polish'), extension + ': Polish language missing');
    assert.ok((tags.language || '').includes('English'), extension + ': English language missing');
    assert.equal(tags.trackNumber, 3);
    assert.equal(tags.trackTotal, 14);
    assert.equal(tags.discNumber, 1);
    assert.equal(tags.discTotal, 2);
    assert.equal(tags.year, 2001);
    assert.match(tags.releaseDate || '', /^2001-03-07/);
    assert.equal(tags.bpm, 128);
    assert.equal(tags.initialKey, 'F#m');
    assert.equal(tags.isrc, payload.isrc);
    assert.equal(tags.musicbrainzTrackId, payload.musicbrainzTrackId);
    assert.equal(tags.musicbrainzReleaseId, payload.musicbrainzReleaseId);

    const second = spawnSync(python, [editor, file], {
      input: JSON.stringify({ trackNumber: 4, discNumber: 2, title: 'Updated title' }),
      encoding: 'utf8',
    });
    assert.equal(second.status, 0, second.stderr || 'second metadata edit failed for ' + extension);
    const updated = await readTags(file);
    assert.equal(updated.title, 'Updated title');
    assert.equal(updated.trackNumber, 4);
    assert.equal(updated.trackTotal, 14);
    assert.equal(updated.discNumber, 2);
    assert.equal(updated.discTotal, 2);
    assert.ok(updated.artists.includes('Artist B'));
    assert.ok((updated.genre || '').includes('Dance'));

    const clear = spawnSync(python, [editor, file], {
      input: JSON.stringify({ bpm: null, genres: null, releaseDate: null }),
      encoding: 'utf8',
    });
    assert.equal(clear.status, 0, clear.stderr || 'metadata clear failed for ' + extension);
    const cleared = await readTags(file);
    assert.equal(cleared.bpm, null);
    assert.equal(cleared.genre, null);
    assert.equal(cleared.releaseDate, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('metadata editor round-trips supported audio formats through the worker parser', { skip: !canRun }, async (t) => {
  for (const extension of ['mp3', 'flac', 'm4a', 'ogg', 'opus', 'wav', 'aac']) {
    await t.test(extension, async () => {
      await roundTrip(extension);
    });
  }
});
