import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRescanInterval, parseRescanInterval } from '../dist/rescanInterval.js';

test('rescan interval accepts seconds, minutes, hours, days, and legacy milliseconds', () => {
  assert.equal(parseRescanInterval('60s'), 60_000);
  assert.equal(parseRescanInterval('1m'), 60_000);
  assert.equal(parseRescanInterval('1h'), 3_600_000);
  assert.equal(parseRescanInterval('2d'), 172_800_000);
  assert.equal(parseRescanInterval(undefined, '3600000'), 3_600_000);
  assert.equal(parseRescanInterval(undefined, '2d'), 172_800_000);
  assert.equal(parseRescanInterval(undefined, undefined), 300_000);
  assert.equal(formatRescanInterval(172_800_000), '2d');
});

test('new setting wins over legacy milliseconds and whitespace is harmless', () => {
  assert.equal(parseRescanInterval(' 1h ', '60000'), 3_600_000);
  assert.equal(parseRescanInterval('', '60000'), 60_000);
  assert.equal(parseRescanInterval('1.5h'), 5_400_000);
});

test('invalid and out-of-range values fail instead of creating a rapid timer', () => {
  for (const value of ['1', '0s', '-1h', '1hour', '1h trailing', '25d', 'NaN']) {
    assert.throws(() => parseRescanInterval(value), /Invalid RESCAN_INTERVAL value/);
  }
  assert.throws(() => parseRescanInterval(undefined, 'oops'), /Invalid RESCAN_INTERVAL_MS value/);
});
