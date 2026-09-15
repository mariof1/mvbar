import { test, expect } from '@playwright/test';

test('Last.fm scrobble keeps the playback start time across a pause and seek', async ({ page }) => {
  await page.addInitScript(() => {
    const playing = new WeakMap<HTMLMediaElement, boolean>();
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', { get() { return playing.get(this) !== true; } });
    HTMLMediaElement.prototype.play = function () {
      playing.set(this, true);
      (window as any).playStartedAt = Math.floor(Date.now() / 1000);
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
  const scrobbles: Array<{ trackId: number; listenedAt: number }> = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) {
      return route.fulfill({ json: { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } } });
    }
    if (path.endsWith('/favorites')) {
      return route.fulfill({ json: { ok: true, total: 1, tracks: [
        { id: 1, title: 'Timestamp song', artist: 'Fixture', duration_ms: 100000 },
      ] } });
    }
    if (path.endsWith('/lastfm/scrobble')) {
      scrobbles.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true, scrobbled: true } });
    }
    return route.fulfill({ json: { ok: true, total: 0, tracks: [], artists: [], albums: [], playlists: [], devices: [] } });
  });

  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/favorites`);
  await page.getByRole('button', { name: 'Play all', exact: true }).click();
  const audio = page.locator('#mvbar-music-audio');
  await expect.poll(() => page.evaluate(() => (window as any).playStartedAt)).toBeGreaterThan(0);
  const startedAt = await page.evaluate(() => (window as any).playStartedAt as number);
  await audio.evaluate(element => {
    const player = element as HTMLAudioElement;
    player.pause();
    const currentClock = Date.now;
    Date.now = () => currentClock() + 60000;
    void player.play();
    Date.now = currentClock;
  });
  await audio.evaluate(element => {
    let position = 0;
    Object.defineProperty(element, 'duration', { configurable: true, get: () => 100 });
    Object.defineProperty(element, 'currentTime', { configurable: true,
      get: () => position, set: (value: number) => { position = value; } });
    element.dispatchEvent(new Event('loadedmetadata'));
    for (let seconds = 5; seconds <= 30; seconds += 5) {
      position = seconds;
      element.dispatchEvent(new Event('timeupdate'));
    }
    // Seeking to 80% crosses the scrobble threshold without adding fake listen time.
    position = 80;
    element.dispatchEvent(new Event('timeupdate'));
  });
  await expect.poll(() => scrobbles.length).toBe(1);
  expect(scrobbles[0]).toEqual({ trackId: 1, listenedAt: startedAt });
});
