import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchLrclibLyrics } from '../dist/lyricsProvider.js';

test('LRCLIB provider prefers synced lyrics and sends precise lookup metadata', async () => {
  const originalFetch = globalThis.fetch;
  let requested = '';
  globalThis.fetch = async (input) => {
    requested = String(input);
    return new Response(JSON.stringify({
      syncedLyrics: '[00:01.00]Hello world\n[00:03.00]Second line',
      plainLyrics: 'Hello world\nSecond line',
    }), { status: 200 });
  };
  try {
    const result = await fetchLrclibLyrics('Daft Punk', 'One More Time', 'Discovery', 320400);
    assert.deepEqual(result, {
      text: '[00:01.00]Hello world\n[00:03.00]Second line',
      synced: true,
      source: 'lrclib',
    });
    const url = new URL(requested);
    assert.equal(url.hostname, 'lrclib.net');
    assert.equal(url.searchParams.get('artist_name'), 'Daft Punk');
    assert.equal(url.searchParams.get('track_name'), 'One More Time');
    assert.equal(url.searchParams.get('album_name'), 'Discovery');
    assert.equal(url.searchParams.get('duration'), '320');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('LRCLIB provider falls back to plain lyrics and ignores empty responses', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      syncedLyrics: null,
      plainLyrics: 'This is a plain lyric line\nAnd another lyric line',
    }), { status: 200 });
    const plain = await fetchLrclibLyrics('Artist', 'Song', null, null);
    assert.equal(plain?.synced, false);
    assert.match(plain?.text ?? '', /plain lyric/);

    globalThis.fetch = async () => new Response(JSON.stringify({
      syncedLyrics: '',
      plainLyrics: 'tiny',
    }), { status: 200 });
    assert.equal(await fetchLrclibLyrics('Artist', 'Song'), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
