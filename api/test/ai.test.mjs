import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasNumericAudioMuseTrackId,
  normalizeAudioMuseUrl,
  parseAudioMuseCommand,
  requestAudioMuseSearch,
  selectConfidentAudioMuseIds,
} from '../dist/ai.js';

test('parseAudioMuseCommand keeps the natural sonic description', () => {
  const command = parseAudioMuseCommand('play soft music');
  assert.equal(command.action, 'play');
  assert.equal(command.searchText, 'soft');
  assert.equal(command.trackCount, 24);
  assert.equal(command.minDurationMinutes, null);
});

test('parseAudioMuseCommand removes control wording from a scene request', () => {
  const command = parseAudioMuseCommand('play British grunge and similar');
  assert.equal(command.action, 'play');
  assert.equal(command.searchText, 'British grunge');
});

test('parseAudioMuseCommand understands an exact count and per-track minimum duration', () => {
  const command = parseAudioMuseCommand('play 10 songs each 10mins or over');
  assert.equal(command.action, 'play');
  assert.equal(command.trackCount, 10);
  assert.equal(command.minDurationMinutes, 10);
  assert.equal(command.maxDurationMinutes, null);
  assert.equal(command.searchText, '');
});

test('parseAudioMuseCommand understands duration maximums and ranges', () => {
  const short = parseAudioMuseCommand('queue 6 tracks under 4 minutes');
  assert.equal(short.action, 'queue');
  assert.equal(short.trackCount, 6);
  assert.equal(short.minDurationMinutes, null);
  assert.equal(short.maxDurationMinutes, 4);
  assert.equal(short.searchText, '');

  const range = parseAudioMuseCommand('play 8 country songs between 5 and 9 minutes');
  assert.equal(range.trackCount, 8);
  assert.equal(range.minDurationMinutes, 5);
  assert.equal(range.maxDurationMinutes, 9);
  assert.equal(range.searchText, 'country');
});

test('normalizeAudioMuseUrl accepts only local HTTP services by default', () => {
  assert.equal(normalizeAudioMuseUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000');
  assert.equal(normalizeAudioMuseUrl('http://localhost:8000'), 'http://localhost:8000');
  assert.throws(() => normalizeAudioMuseUrl('file:///tmp/audiomuse'), /HTTP address/);
  assert.throws(() => normalizeAudioMuseUrl('http://user:pass@127.0.0.1:8000'), /without embedded credentials/);
  assert.throws(() => normalizeAudioMuseUrl('http://192.168.1.20:8000'), /must use localhost/);
});

test('normalizeAudioMuseUrl permits an administrator-enabled remote service', () => {
  const original = process.env.AUDIOMUSE_ALLOW_REMOTE;
  process.env.AUDIOMUSE_ALLOW_REMOTE = 'true';
  try {
    assert.equal(normalizeAudioMuseUrl('https://music-ai.example.test/'), 'https://music-ai.example.test');
  } finally {
    if (original === undefined) delete process.env.AUDIOMUSE_ALLOW_REMOTE;
    else process.env.AUDIOMUSE_ALLOW_REMOTE = original;
  }
});

test('requestAudioMuseSearch calls the authenticated CLAP endpoint with a bounded limit', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options, body: JSON.parse(String(options?.body)) };
    return new Response(JSON.stringify({
      query: 'soft',
      results: [{ item_id: '42', title: 'Quiet Song', author: 'Artist', similarity: 0.37 }],
      count: 1,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const results = await requestAudioMuseSearch(
      'http://127.0.0.1:8000',
      'local-api-token',
      'soft',
      900,
      new AbortController().signal
    );
    assert.equal(captured.url, 'http://127.0.0.1:8000/api/clap/search');
    assert.equal(captured.options.headers.Authorization, 'Bearer local-api-token');
    assert.equal(captured.options.redirect, 'error');
    assert.deepEqual(captured.body, { query: 'soft', limit: 500 });
    assert.equal(results[0].item_id, '42');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('requestAudioMuseSearch explains when initial sonic analysis is not ready', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'CLAP cache not loaded. Please run song analysis first.',
    results: [],
  }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  try {
    await assert.rejects(
      requestAudioMuseSearch('http://127.0.0.1:8000', '', 'country western', 100, new AbortController().signal),
      /Run song analysis in AudioMuse-AI first/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('selectConfidentAudioMuseIds rejects low-confidence filler and invalid provider IDs', () => {
  const selected = selectConfidentAudioMuseIds([
    { item_id: '1', similarity: 0.40 },
    { item_id: '2', similarity: 0.34 },
    { item_id: '2', similarity: 0.33 },
    { item_id: '3', similarity: 0.29 },
    { item_id: 'not-a-mvbar-track', similarity: 0.99 },
  ]);
  assert.deepEqual(selected.ids, [1, 2]);
  assert.equal(selected.confidenceFloor, 0.30000000000000004);
});

test('selectConfidentAudioMuseIds returns no tracks when AudioMuse provides no numeric MVBar IDs', () => {
  const results = [
    { item_id: 'fp_v1abcdef', similarity: 0.8 },
  ];
  assert.equal(hasNumericAudioMuseTrackId(results), false);
  assert.deepEqual(selectConfidentAudioMuseIds(results), { ids: [], confidenceFloor: null });
});

test('hasNumericAudioMuseTrackId recognizes MVBar OpenSubsonic IDs', () => {
  assert.equal(hasNumericAudioMuseTrackId([
    { item_id: 'fp_v1abcdef', similarity: 0.9 },
    { item_id: '42', similarity: 0.3 },
  ]), true);
});
