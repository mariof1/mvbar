import { test, expect } from '@playwright/test';

test('repeat-one records each completed listen and scrobbles each replay', async ({ page }) => {
  await page.addInitScript(() => {
    const playing = new WeakMap<HTMLMediaElement, boolean>();
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', { get() { return playing.get(this) !== true; } });
    HTMLMediaElement.prototype.play = function () {
      playing.set(this, true);
      this.dispatchEvent(new Event('play'));
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      playing.set(this, false);
      this.dispatchEvent(new Event('pause'));
    };
  });
  await page.routeWebSocket('**/*', () => {});
  const histories: unknown[] = [];
  const scrobbles: Array<{ trackId: number; listenedAt?: number }> = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) {
      return route.fulfill({ json: { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } } });
    }
    if (path.endsWith('/favorites')) {
      return route.fulfill({ json: { ok: true, total: 1, tracks: [
        { id: 1, title: 'Repeat song', artist: 'Fixture', duration_ms: 100000 },
      ] } });
    }
    if (path.endsWith('/history/1')) {
      histories.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith('/lastfm/scrobble')) {
      scrobbles.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true, scrobbled: true } });
    }
    return route.fulfill({ json: { ok: true, total: 0, tracks: [], artists: [], albums: [], playlists: [], devices: [] } });
  });

  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/favorites`);
  await page.getByRole('button', { name: 'Play all', exact: true }).click();
  await page.getByRole('button', { name: 'Normal', exact: true }).filter({ visible: true }).first().click();
  await page.getByRole('button', { name: 'Repeat All', exact: true }).filter({ visible: true }).first().click();
  await expect(page.getByRole('button', { name: 'Repeat One', exact: true }).filter({ visible: true }).first()).toBeVisible();
  const audio = page.locator('#mvbar-music-audio');
  await audio.evaluate(element => {
    let position = 0;
    Object.defineProperty(element, 'duration', { configurable: true, get: () => 100 });
    Object.defineProperty(element, 'currentTime', { configurable: true,
      get: () => position, set: (value: number) => { position = value; } });
    element.dispatchEvent(new Event('loadedmetadata'));
  });
  const completeListen = () => audio.evaluate(element => {
    const player = element as HTMLAudioElement;
    for (let seconds = 5; seconds <= 100; seconds += 5) {
      player.currentTime = seconds;
      player.dispatchEvent(new Event('timeupdate'));
    }
    player.dispatchEvent(new Event('ended'));
  });

  await completeListen();
  await expect.poll(() => histories.length).toBe(1);
  await expect.poll(() => scrobbles.length).toBe(1);
  await completeListen();
  await expect.poll(() => histories.length).toBe(2);
  await expect.poll(() => scrobbles.length).toBe(2);
  expect(scrobbles.every(request => request.trackId === 1 && Number.isSafeInteger(request.listenedAt))).toBe(true);
});
