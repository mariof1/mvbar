import { expect, test } from '@playwright/test';

test('a completed podcast stays played while its player remains open', async ({ page }) => {
  await page.addInitScript(() => {
    const originalAudio = window.Audio;
    const instances: HTMLAudioElement[] = [];
    const positions = new WeakMap<HTMLMediaElement, number>();
    const ended = new WeakSet<HTMLMediaElement>();
    const playing = new WeakSet<HTMLMediaElement>();
    Object.defineProperty(window, '__auditPodcastAudio', { value: instances });
    Object.defineProperty(window, '__auditEndPodcast', { value: (audio: HTMLAudioElement) => {
      ended.add(audio);
      playing.delete(audio);
      audio.dispatchEvent(new Event('ended'));
    } });
    window.Audio = function (...args: ConstructorParameters<typeof Audio>) {
      const audio = new originalAudio(...args);
      instances.push(audio);
      return audio;
    } as unknown as typeof Audio;
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true, get() { return positions.get(this) ?? 0; },
      set(value: number) { positions.set(this, value); },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
      configurable: true, get() { return 60; },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
      configurable: true, get() { return !playing.has(this); },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'ended', {
      configurable: true, get() { return ended.has(this); },
    });
    HTMLMediaElement.prototype.play = function () {
      playing.add(this);
      ended.delete(this);
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.pause = function () {
      playing.delete(this);
      this.dispatchEvent(new Event('pause'));
    };
  });
  await page.routeWebSocket('**/*', () => {});
  const progress: Array<{ positionMs: number; played?: boolean }> = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) {
      return route.fulfill({ json: { ok: true, user: { id: 'audit', email: 'test@local', role: 'user' } } });
    }
    if (path.endsWith('/audiobooks')) return route.fulfill({ json: [] });
    if (path.endsWith('/podcasts/episodes/5/progress')) {
      progress.push(route.request().postDataJSON());
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith('/podcasts/episodes/new')) {
      return route.fulfill({ json: { ok: true, episodes: [] } });
    }
    if (path.endsWith('/podcasts/1')) {
      return route.fulfill({ json: { ok: true, episodes: [{ id: 5, podcast_id: 1,
        title: 'Fixture episode', audio_url: 'https://example.invalid/episode', duration_ms: 60000,
        position_ms: 0, played: false, downloaded: false, published_at: null }] } });
    }
    if (path.endsWith('/podcasts')) {
      return route.fulfill({ json: { ok: true, podcasts: [{ id: 1, feed_url: 'https://example.invalid/feed',
        title: 'Fixture show', unplayed_count: 1, author: null, description: null, image_url: null }] } });
    }
    return route.fulfill({ json: { ok: true, total: 0, tracks: [], artists: [], albums: [],
      playlists: [], devices: [] } });
  });

  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/podcast/1`);
  await page.getByRole('button', { name: 'Play Fixture episode' }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & {
    __auditPodcastAudio: HTMLAudioElement[];
  }).__auditPodcastAudio.length)).toBe(1);
  await page.evaluate(() => {
    const state = window as typeof window & {
      __auditPodcastAudio: HTMLAudioElement[];
      __auditEndPodcast: (audio: HTMLAudioElement) => void;
    };
    const audio = state.__auditPodcastAudio[0];
    audio.currentTime = 60;
    state.__auditEndPodcast(audio);
  });
  await expect.poll(() => progress.some(request => request.played === true)).toBe(true);
  await expect(page.getByRole('button', { name: /In progress 0/ })).toBeVisible();
  await page.waitForTimeout(5500);
  await expect(page.getByRole('button', { name: /In progress 0/ })).toBeVisible();
  expect(progress).toHaveLength(1);
});
