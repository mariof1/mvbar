import { expect, test } from '@playwright/test';

test('switching audiobook chapters saves the old position and starts the new chapter resume', async ({ page }) => {
  page.on('pageerror', error => console.error('page error:', error.message, error.stack));
  await page.addInitScript(() => {
    const positions = new WeakMap<HTMLMediaElement, number>();
    const originalAudio = window.Audio;
    const audioInstances: HTMLAudioElement[] = [];
    Object.defineProperty(window, '__auditAudioInstances', { value: audioInstances });
    window.Audio = function (...args: ConstructorParameters<typeof Audio>) {
      const audio = new originalAudio(...args);
      audioInstances.push(audio);
      return audio;
    } as unknown as typeof Audio;
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get() { return positions.get(this) ?? 0; },
      set(value: number) { positions.set(this, value); },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
      configurable: true,
      get() { return 60; },
    });
    HTMLMediaElement.prototype.play = function () {
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      this.dispatchEvent(new Event('pause'));
    };
  });
  await page.routeWebSocket('**/*', () => {});
  const progress: Array<{ chapter_id: number; position_ms: number }> = [];
  let releaseOldPosition = () => {};
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) {
      return route.fulfill({ json: { ok: true, user: { id: 'audit', email: 'test@local', role: 'user' } } });
    }
    if (path.endsWith('/audiobooks/1/progress')) {
      const request = route.request().postDataJSON();
      progress.push(request);
      if (request.chapter_id === 11 && request.position_ms === 42000) {
        await new Promise<void>(resolve => { releaseOldPosition = resolve; });
      }
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith('/audiobooks')) {
      return route.fulfill({ json: [] });
    }
    if (path.endsWith('/audiobooks/1')) {
      return route.fulfill({ json: {
        audiobook: { id: 1, title: 'Fixture Book', author: 'Fixture', narrator: null,
          language: null, cover_path: null, duration_ms: 120000, description: null },
        chapters: [
          { id: 11, audiobook_id: 1, position: 0, title: 'First chapter', duration_ms: 60000 },
          { id: 12, audiobook_id: 1, position: 1, title: 'Second chapter', duration_ms: 60000 },
        ],
        progress: null,
      } });
    }
    return route.fulfill({ json: { ok: true, total: 0, tracks: [], artists: [], albums: [],
      playlists: [], devices: [] } });
  });

  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/audiobook/1`);
  await page.getByRole('button', { name: 'Play First chapter' }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & {
    __auditAudioInstances: HTMLAudioElement[];
  }).__auditAudioInstances.length)).toBe(1);
  await page.evaluate(() => {
    (window as typeof window & { __auditAudioInstances: HTMLAudioElement[] })
      .__auditAudioInstances[0].currentTime = 42;
  });
  await page.getByRole('button', { name: 'Play Second chapter' }).click();
  await expect.poll(() => progress.some(request =>
    request.chapter_id === 11 && request.position_ms === 42000)).toBe(true);
  expect(progress).toContainEqual({ chapter_id: 11, position_ms: 42000, finished: false });
  expect(progress.some(request => request.chapter_id === 12 && request.position_ms === 42000)).toBe(false);
  await expect.poll(() => page.evaluate(() => (window as typeof window & {
    __auditAudioInstances: HTMLAudioElement[];
  }).__auditAudioInstances.length)).toBe(2);
  expect(progress.some(request => request.chapter_id === 12 && request.position_ms === 0)).toBe(false);
  releaseOldPosition();
  await page.locator('button[title="Close"]').last().click();
  await expect.poll(() => progress.some(request =>
    request.chapter_id === 12 && request.position_ms === 0)).toBe(true);
});
