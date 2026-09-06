import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeConnectCommand,
  normalizeConnectCommandResult,
  normalizeConnectRegistration,
  normalizeConnectState,
  normalizeConnectTransfer,
} from '../dist/connectProtocol.js';

test('connect registration bounds identity and playback context', () => {
  const registration = normalizeConnectRegistration({
    deviceId: ' phone-123 ',
    name: 'Living room\u0000 phone',
    type: 'Android',
    capabilities: ['music', 'music', 42],
    state: {
      queue: [
        { id: 7, title: 'One', artist: 'Artist', duration_ms: 123000 },
        { id: -1, title: 'invalid' },
      ],
      queueIndex: 50,
      isPlaying: true,
      positionMs: -20,
    },
  });

  assert.equal(registration?.deviceId, 'phone-123');
  assert.equal(registration?.name, 'Living room phone');
  assert.equal(registration?.type, 'android');
  assert.deepEqual(registration?.capabilities, ['music']);
  assert.equal(registration?.state.queue.length, 1);
  assert.equal(registration?.state.queueIndex, 0);
  assert.equal(registration?.state.track?.id, 7);
  assert.equal(registration?.state.positionMs, 0);
});

test('connect state never accepts unbounded queues or invalid tracks', () => {
  const state = normalizeConnectState({
    queue: Array.from({ length: 700 }, (_, index) => ({ id: index + 1 })),
    queueIndex: 699,
    volume: 20,
  });

  assert.equal(state.queue.length, 500);
  assert.equal(state.queueIndex, 499);
  assert.equal(state.track?.id, 500);
  assert.equal(state.volume, 1);
});

test('connect commands and transfers require valid targets and allowlisted actions', () => {
  assert.deepEqual(normalizeConnectCommand({
    targetDeviceId: 'tv-1',
    commandId: 'cmd-1',
    command: 'seek',
    payload: { positionMs: 5000 },
  }), {
    targetDeviceId: 'tv-1',
    commandId: 'cmd-1',
    command: 'seek',
    payload: { positionMs: 5000 },
  });
  assert.equal(normalizeConnectCommand({ targetDeviceId: 'tv-1', commandId: 'cmd-2', command: 'format_disk' }), null);
  assert.deepEqual(normalizeConnectCommandResult({
    commandId: 'cmd-1',
    success: false,
    error: ' Playback failed\u0000 ',
  }), {
    commandId: 'cmd-1',
    success: false,
    error: 'Playback failed',
  });
  assert.equal(normalizeConnectCommandResult({ commandId: 'cmd-1', success: 'yes' }), null);
  assert.deepEqual(normalizeConnectTransfer({
    sourceDeviceId: 'phone-1',
    targetDeviceId: 'tv-1',
    commandId: 'transfer-1',
  }), {
    sourceDeviceId: 'phone-1',
    targetDeviceId: 'tv-1',
    commandId: 'transfer-1',
  });
});
