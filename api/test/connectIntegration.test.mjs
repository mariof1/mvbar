import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { registerWebsocketRoutes } from '../dist/websocket.js';

test('Connect isolation, controls, transfer confirmation, queue mapping and disconnects', async (t) => {
  const app = Fastify();
  // The production authentication hook supplies req.user; these isolated users
  // exercise routing without accessing a real account, database or media file.
  app.addHook('preHandler', async (req) => {
    const userId = req.headers['x-test-user'];
    if (userId) req.user = { userId, role: 'user' };
  });
  await app.register(websocket);
  registerWebsocketRoutes(app);
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const sockets = [];
  t.after(async () => {
    for (const client of sockets) client.ws.terminate();
    await app.close();
  });
  async function client(id, user = 'one', capabilities = ['remote-control', 'transfer', 'command-results-v1', 'play-next']) {
    const ws = new WebSocket(address.replace('http:', 'ws:') + '/api/ws', { headers: { 'x-test-user': user } });
    const messages = [];
    ws.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
    const item = {
      ws, messages,
      send: (type, data) => ws.send(JSON.stringify({ type, data })),
      async wait(type, predicate = () => true) {
        for (let i = 0; i < 200; i++) {
          const index = messages.findIndex(m => m.type === type && predicate(m.data));
          if (index >= 0) return messages.splice(index, 1)[0].data;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.fail(`Timed out waiting for ${type} on ${id}`);
      },
    };
    sockets.push(item);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    item.send('connect:register', { deviceId: id, name: id, capabilities, state: {} });
    await item.wait('connect:registered');
    return item;
  }
  const controller = await client('controller');
  const anonymous = new WebSocket(address.replace('http:', 'ws:') + '/api/ws');
  const anonymousMessages = [];
  anonymous.on('message', bytes => anonymousMessages.push(JSON.parse(bytes.toString())));
  assert.equal(await new Promise(resolve => anonymous.once('close', resolve)), 4001);
  assert.equal(anonymousMessages[0].type, 'auth:session_invalid');
  const target = await client('target');
  const other = await client('private', 'two');
  const devices = await other.wait('connect:devices');
  assert.deepEqual(devices.devices.map(d => d.id), ['private']);
  controller.send('connect:command', { commandId: 'cross', targetDeviceId: 'private', command: 'pause' });
  assert.equal((await controller.wait('connect:command_ack', d => d.commandId === 'cross')).accepted, false);
  assert.equal(other.messages.some(m => m.type === 'connect:command'), false);
  const legacy = await client('legacy', 'one', ['remote-control']);
  controller.send('connect:command', { commandId: 'unsupported', targetDeviceId: 'legacy', command: 'play_next', payload: { tracks: [{ id: 1 }] } });
  assert.equal((await controller.wait('connect:command_ack', d => d.commandId === 'unsupported')).accepted, false);
  controller.send('connect:command', { commandId: 'legacy-pause', targetDeviceId: 'legacy', command: 'pause' });
  await legacy.wait('connect:command');
  const legacyAck = await controller.wait('connect:command_ack', d => d.commandId === 'legacy-pause');
  assert.equal(legacyAck.accepted, true);
  assert.equal(legacyAck.executed, undefined);

  for (const command of ['play', 'pause', 'toggle', 'next', 'previous', 'seek', 'stop', 'clear_queue', 'add_tracks', 'play_next']) {
    controller.send('connect:command', { commandId: command, targetDeviceId: 'target', command, payload: { tracks: [{ id: 1 }], positionMs: 1000 } });
    assert.equal((await target.wait('connect:command', d => d.commandId === command)).command, command);
    target.send('connect:command_result', { commandId: command, success: true });
    assert.equal((await controller.wait('connect:command_ack', d => d.commandId === command)).executed, true);
  }
  const queue = Array.from({ length: 800 }, (_, i) => ({ id: i + 1 }));
  target.send('connect:state', { queue, queueIndex: 650, track: queue[650], isPlaying: true, positionMs: 12345 });
  const snapshot = await controller.wait('connect:devices', d => d.devices.some(x => x.id === 'target' && x.state.track?.id === 651));
  const state = snapshot.devices.find(d => d.id === 'target').state;
  assert.equal(state.queue[state.queueIndex].id, 651);
  for (const command of ['play_index', 'remove_index', 'reorder']) {
    controller.send('connect:command', { commandId: command, targetDeviceId: 'target', command, payload: { index: state.queueIndex, from: state.queueIndex, to: state.queueIndex + 1 } });
    const received = await target.wait('connect:command', d => d.commandId === command);
    assert.equal(received.payload[command === 'reorder' ? 'from' : 'index'], 650);
    target.send('connect:command_result', { commandId: command, success: true });
    await controller.wait('connect:command_ack', d => d.commandId === command);
  }
  controller.send('connect:command', { commandId: 'invalid-index', targetDeviceId: 'target', command: 'remove_index', payload: { index: -1 } });
  assert.equal((await controller.wait('connect:command_ack', d => d.commandId === 'invalid-index')).accepted, false);
  controller.send('connect:command', { commandId: 'large-play', targetDeviceId: 'target', command: 'play_tracks', payload: { tracks: queue, queueIndex: 650 } });
  const largePlay = await target.wait('connect:command', d => d.commandId === 'large-play');
  assert.equal(largePlay.payload.tracks[largePlay.payload.queueIndex].id, 651);
  target.send('connect:command_result', { commandId: 'large-play', success: true });
  await controller.wait('connect:command_ack', d => d.commandId === 'large-play');
  controller.send('connect:command', { commandId: 'large-add', targetDeviceId: 'target', command: 'add_tracks', payload: { tracks: queue } });
  assert.equal((await controller.wait('connect:command_ack', d => d.commandId === 'large-add')).accepted, false);

  for (const success of [false, true]) {
    const commandId = `transfer-${success}`;
    controller.send('connect:transfer', { sourceDeviceId: 'target', targetDeviceId: 'controller', commandId });
    const transfer = await controller.wait('connect:command', d => d.commandId === commandId);
    assert.equal(transfer.payload.tracks[transfer.payload.queueIndex].id, 651);
    assert.equal(transfer.payload.positionMs, 12345);
    assert.equal(target.messages.some(m => m.type === 'connect:command' && m.data.command === 'pause'), false);
    controller.send('connect:command_result', { commandId, success });
    assert.equal((await controller.wait('connect:command_ack', d => d.commandId === commandId)).executed, success);
    if (success) await target.wait('connect:command', d => d.commandId === `${commandId}:pause`);
    else assert.equal(target.messages.some(m => m.type === 'connect:command'), false);
  }
  controller.send('connect:command', { commandId: 'disconnect', targetDeviceId: 'target', command: 'pause' });
  await target.wait('connect:command', d => d.commandId === 'disconnect');
  target.ws.close();
  assert.equal((await controller.wait('connect:command_ack', d => d.commandId === 'disconnect')).accepted, false);
  await controller.wait('connect:devices', d => !d.devices.some(x => x.id === 'target'));
  const source = await client('source');
  source.send('connect:state', { queue: [{ id: 1 }], queueIndex: 0, isPlaying: true });
  await controller.wait('connect:devices', d => d.devices.some(x => x.id === 'source' && x.state.isPlaying));
  const destination = await client('destination');
  const temporaryController = await client('temporary');
  temporaryController.send('connect:transfer', { commandId: 'controller-left', sourceDeviceId: 'source', targetDeviceId: 'destination' });
  await destination.wait('connect:command');
  temporaryController.ws.close();
  await controller.wait('connect:devices', d => !d.devices.some(x => x.id === 'temporary'));
  destination.send('connect:command_result', { commandId: 'controller-left', success: true });
  await source.wait('connect:command', d => d.commandId === 'controller-left:pause');
  controller.send('connect:command', { commandId: 'replacement', targetDeviceId: 'destination', command: 'pause' });
  await destination.wait('connect:command');
  await client('destination');
  assert.equal((await controller.wait('connect:command_ack', d => d.commandId === 'replacement')).accepted, false);
  await destination.wait('connect:replaced');
  controller.send('connect:command', { commandId: 'timeout', targetDeviceId: 'source', command: 'pause' });
  await source.wait('connect:command', d => d.commandId === 'timeout');
  other.send('connect:command_result', { commandId: 'timeout', success: true });
  // A different account cannot forge completion, and an unresponsive player
  // eventually produces a visible failure instead of a false success.
  await new Promise(resolve => setTimeout(resolve, 12_100));
  const timeout = await controller.wait('connect:command_ack', d => d.commandId === 'timeout');
  assert.equal(timeout.accepted, false);
  assert.match(timeout.error, /in time/);
});
