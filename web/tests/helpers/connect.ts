import { expect, type WebSocketRoute } from '@playwright/test';

export async function connectFixture(page: import('@playwright/test').Page) {
  let socket: WebSocketRoute;
  const outgoing: any[] = [];
  await page.addInitScript(() => {
    const states = new WeakMap<HTMLMediaElement, boolean>();
    (window as any).musicPlayCalls = 0;
    (window as any).auditMedia = [];
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', { get() { return states.get(this) !== false; } });
    HTMLMediaElement.prototype.play = function () {
      if (!(window as any).auditMedia.includes(this)) (window as any).auditMedia.push(this);
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
    devices(devices: any[], localState?: any) {
      const registration = outgoing.find(m => m.type === 'connect:register').data;
      socket!.send(JSON.stringify({ type: 'connect:devices', data: { devices: [
        { id: registration.deviceId, name: 'Test browser', type: 'web', capabilities: ['remote-control'], state: localState ?? { ...registration.state, queueLength: 0 } }, ...devices,
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

