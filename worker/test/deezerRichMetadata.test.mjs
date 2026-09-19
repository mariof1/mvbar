import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readTags } from '../dist/metadata.js';

const python = process.env.MVBAR_METADATA_TEST_PYTHON || 'python3';
const downloader = path.resolve(process.cwd(), '../api/scripts/deezer_download.py');

function available(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return result.status === 0;
}

const canRun = available(python, ['-c', 'import mutagen']) && available('ffmpeg', ['-version']);

async function verifyFormat(extension) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvbar-deezer-rich-'));
  const file = path.join(dir, 'track.' + extension);
  try {
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.25',
      '-y', file,
    ]);

    const metadata = {
      id: '42',
      artist: 'Daft Punk',
      artists: ['Daft Punk', 'Romanthony'],
      bpm: 123.6,
      gainDb: -7.25,
      lyrics: {
        text: '[00:01.00]One more time\n[00:03.00]Music got me feeling so free',
        synced: true,
        source: 'lrclib',
      },
    };
    const job = {
      publisher: 'Virgin',
      barcode: '724384960650',
      recordType: 'album',
      albumGainDb: -8.2,
      albumId: '1',
    };
    const credits = {
      composers: ['Thomas Bangalter', 'Guy-Manuel de Homem-Christo'],
      lyricists: ['Anthony Moore'],
    };

    const code = [
      'import importlib.util, json, sys',
      'spec=importlib.util.spec_from_file_location("mvbar_deezer_download", sys.argv[1])',
      'mod=importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(mod)',
      'metadata=json.loads(sys.argv[4])',
      'job=json.loads(sys.argv[5])',
      'credits=json.loads(sys.argv[6])',
      'mod.apply_rich_metadata(sys.argv[2], sys.argv[3], metadata, job, credits)',
    ].join('; ');

    const result = spawnSync(python, [
      '-c', code, downloader, file, extension,
      JSON.stringify(metadata), JSON.stringify(job), JSON.stringify(credits),
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || 'rich metadata writer failed for ' + extension);

    const tags = await readTags(file);
    assert.ok(tags.artists.includes('Daft Punk'), extension + ': primary artist missing');
    assert.ok(tags.artists.includes('Romanthony'), extension + ': contributor missing');
    assert.equal(tags.bpm, 124);
    assert.match(tags.composer || '', /Thomas Bangalter/);
    assert.match(tags.composer || '', /Guy-Manuel/);
    assert.ok(tags.lyricists.includes('Anthony Moore'), extension + ': lyricist missing');
    assert.equal(tags.publisher, 'Virgin');
    assert.equal(tags.embeddedLyricsSynced, true);
    assert.match(tags.embeddedLyrics || '', /One more time/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('Deezer rich tags round-trip through MVBar metadata reader', { skip: !canRun }, async (t) => {
  for (const extension of ['mp3', 'flac']) {
    await t.test(extension, async () => verifyFormat(extension));
  }
});
