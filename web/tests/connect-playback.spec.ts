import { test, expect, type WebSocketRoute } from '@playwright/test';

async function connectFixture(page: import('@playwright/test').Page) {
  let socket: WebSocketRoute;
  const outgoing: any[] = [];
  await page.addInitScript(() => {
    const states = new WeakMap<HTMLMediaElement, boolean>();
    (window as any).musicPlayCalls = 0;
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', { get() { return states.get(this) !== false; } });
    HTMLMediaElement.prototype.play = function () {
      if (this.id === 'mvbar-music-audio') (window as any).musicPlayCalls++;
      if ((window as any).blockPlayback) return Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
      states.set(this, false);
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      states.set(this, true);
      this.dispatchEvent(new Event('pause'));
    };
  });
  await page.routeWebSocket('**/*', ws => {
    socket = ws;
    ws.onMessage(raw => {
      const msg = JSON.parse(String(raw)); outgoing.push(msg);
      if (msg.type === 'connect:register') {
        ws.send(JSON.stringify({ type: 'connect:registered', data: { deviceId: msg.data.deviceId } }));
        ws.send(JSON.stringify({ type: 'connect:devices', data: { devices: [{
          id: msg.data.deviceId, name: 'Test browser', type: 'web', capabilities: ['remote-control'],
          state: { ...msg.data.state, queueLength: 0 },
        }] } }));
      }
    });
  });
  await page.route('**/api/**', route => route.fulfill({ json:
    new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'connect-audit', email: 'test@local', role: 'admin' } }
      : { ok: true, items: [], tracks: [], playlists: [], devices: [], searches: [] },
  }));
  await page.goto('http://localhost:8080/#/for-you');
  await expect.poll(() => outgoing.some(m => m.type === 'connect:register')).toBe(true);
  return {
    outgoing,
    event(type: string, data: any) { socket!.send(JSON.stringify({ type, data })); },
    disconnect() { socket!.close(); },
    devices(devices: any[]) {
      const registration = outgoing.find(m => m.type === 'connect:register').data;
      socket!.send(JSON.stringify({ type: 'connect:devices', data: { devices: [
        { id: registration.deviceId, name: 'Test browser', type: 'web', capabilities: ['remote-control'], state: { ...registration.state, queueLength: 0 } }, ...devices,
      ] } }));
    },
    async command(command: string, payload: any = {}) {
      const commandId = String(outgoing.length) + Math.random();
      socket!.send(JSON.stringify({ type: 'connect:command', data: { commandId, command, payload } }));
      await expect.poll(() => outgoing.find(m => m.type === 'connect:command_result' && m.data.commandId === commandId)).toBeTruthy();
      return outgoing.find(m => m.type === 'connect:command_result' && m.data.commandId === commandId).data;
    },
  };
}

test('paused transfer stays silent and playing transfer starts only once', async ({ page }) => {
  const fixture = await connectFixture(page);
  const tracks = [{ id: 1, title: 'First' }, { id: 2, title: 'Second' }];
  expect((await fixture.command('play_tracks', { tracks, queueIndex: 1, isPlaying: false, positionMs: 5000 })).success).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).musicPlayCalls)).toBe(0);
  await expect(page.locator('#mvbar-music-audio')).toHaveAttribute('src', '/api/stream/2');
  expect((await fixture.command('play_tracks', { tracks, queueIndex: 0, isPlaying: true })).success).toBe(true);
  expect(await page.evaluate(() => (window as any).musicPlayCalls)).toBe(1);
  expect((await fixture.command('clear_queue')).success).toBe(true);
  await expect.poll(() => fixture.outgoing.some(m => m.type === 'connect:state' && m.data.queue.length === 1 && m.data.track?.id === 1)).toBe(true);
  expect((await fixture.command('stop')).success).toBe(true);
  await expect(page.locator('#mvbar-music-audio')).not.toHaveAttribute('src');
});

test('a duplicated tab obtains a distinct identity and reconnects with it', async ({ page }) => {
  const fixture = await connectFixture(page);
  const firstId = fixture.outgoing.find(m => m.type === 'connect:register').data.deviceId;
  fixture.event('connect:replaced', { deviceId: firstId });
  await expect.poll(() => fixture.outgoing.filter(m => m.type === 'connect:register').length).toBe(2);
  const secondId = fixture.outgoing.filter(m => m.type === 'connect:register')[1].data.deviceId;
  expect(secondId).not.toBe(firstId);
  fixture.disconnect();
  await expect.poll(() => fixture.outgoing.filter(m => m.type === 'connect:register').length).toBe(3);
  expect(fixture.outgoing.filter(m => m.type === 'connect:register')[2].data.deviceId).toBe(secondId);
  await page.getByRole('button', { name: 'MVBar Connect players', exact: true }).filter({ visible: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'MVBar Connect', exact: true });
  await dialog.getByRole('button', { name: 'Rename this player', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'This player name' }).fill('Office browser');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => fixture.outgoing.filter(m => m.type === 'connect:register').at(-1)?.data.name).toBe('Office browser');
  expect(await page.evaluate(() => localStorage.getItem('mvbar_connect_device_name'))).toBe('Office browser');
});

test('remote picker and player controls dispatch to the selected device', async ({ page }) => {
  const fixture = await connectFixture(page);
  const tracks = [{ id: 1, title: 'One' }, { id: 2, title: 'Two' }, { id: 3, title: 'Three' }];
  fixture.devices([{ id: 'tv', name: 'Living room TV', type: 'tv', capabilities: ['remote-control'],
    state: { track: tracks[1], queue: tracks, queueIndex: 1, queueLength: 3, isPlaying: false, positionMs: 0, durationMs: 100000 } }]);
  const trigger = page.getByRole('button', { name: 'MVBar Connect players', exact: true }).filter({ visible: true }).first();
  await trigger.click();
  await page.getByRole('dialog', { name: 'MVBar Connect', exact: true }).getByRole('button', { name: /Living room TV/ }).click();
  for (const [label, command] of [['Play', 'toggle'], ['Next', 'next'], ['Previous', 'previous']]) {
    await page.getByRole('button', { name: `${label} on Living room TV`, exact: true }).click();
    expect(fixture.outgoing.some(m => m.type === 'connect:command' && m.data.command === command && m.data.targetDeviceId === 'tv')).toBe(true);
  }
  await page.getByRole('slider', { name: 'Seek on Living room TV' }).fill('25000');
  await expect.poll(() => fixture.outgoing.some(m => m.data?.command === 'seek' && m.data.payload.positionMs === 25000)).toBe(true);
  await page.getByRole('button', { name: 'Queue on Living room TV', exact: true }).click();
  await page.getByRole('button', { name: 'Play Three on Living room TV', exact: true }).click();
  await page.getByRole('button', { name: 'Remove One from queue', exact: true }).click();
  await page.getByRole('button', { name: 'Clear upcoming', exact: true }).click();
  for (const command of ['play_index', 'remove_index', 'clear_queue']) {
    expect(fixture.outgoing.some(m => m.data?.command === command && m.data.targetDeviceId === 'tv')).toBe(true);
  }
  expect(await page.evaluate(() => (window as any).musicPlayCalls)).toBe(0);
  fixture.devices([]);
  await expect(page.getByRole('button', { name: 'Play on Living room TV', exact: true })).toHaveCount(0);
});

test('blocked playback and invalid queue commands return failure acknowledgements', async ({ page }) => {
  const fixture = await connectFixture(page);
  await page.evaluate(() => { (window as any).blockPlayback = true; });
  const result = await fixture.command('play_tracks', { tracks: [{ id: 1 }], isPlaying: true });
  expect(result.success).toBe(false);
  expect(result.error).toContain('blocked');
  expect((await fixture.command('play_index', { index: 5 })).success).toBe(false);
  expect((await fixture.command('play_tracks', { tracks: [] })).success).toBe(false);
});
