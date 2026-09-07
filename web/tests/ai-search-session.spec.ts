import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
    ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
    : { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
  await page.route('**/api/preferences', route => route.fulfill({ json: { ok: true, preferences: {}, openrouterConfigured: true } }));
});

for (const leave of ['close', 'back']) {
  test(`AI response cannot start playback after ${leave}`, async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started = false, finished = false, streams = 0;
    await page.route('**/api/stream/**', route => { streams++; return route.abort(); });
    await page.route('**/api/ai/intent', async route => {
      started = true;
      await held;
      await route.fulfill({ json: { action: 'play', requestedTrackCount: 1, tracks: [{ id: 1, title: 'Old mix', artist: 'Audit' }] } });
      finished = true;
    });
    await page.goto('http://localhost:8080/#/favorites');
    await page.keyboard.press('Control+k');
    await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
    await page.getByRole('textbox', { name: 'Ask AI for music' }).fill('play rock');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await expect.poll(() => started).toBe(true);
    if (leave === 'close') {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+k');
    } else await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search library', exact: true }).fill('New draft');
    release();
    await expect.poll(() => finished).toBe(true);
    await page.waitForTimeout(300);
    await expect(page.getByRole('textbox', { name: 'Search library', exact: true })).toHaveValue('New draft');
    expect(streams).toBe(0);
    await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeEnabled();
  });
}

test('Enter does not submit AI requests without a configured integration', async ({ page }) => {
  await page.route('**/api/preferences', route => route.fulfill({ json: { ok: true, preferences: {}, openrouterConfigured: false } }));
  let requests = 0;
  await page.route('**/api/ai/intent', route => { requests++; return route.fulfill({ json: { tracks: [] } }); });
  await page.goto('http://localhost:8080/#/favorites');
  await page.keyboard.press('Control+k');
  await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Ask AI for music' });
  await input.fill('play rock');
  await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeDisabled();
  await input.press('Enter');
  await page.waitForTimeout(300);
  expect(requests).toBe(0);
});

test('an abandoned AI failure does not affect a new pending request, which can still play', async ({ page }) => {
  const releases: Array<() => void> = [];
  let finished = 0;
  await page.route('**/api/ai/intent', async route => {
    const index = releases.length;
    await new Promise<void>(resolve => { releases.push(resolve); });
    await route.fulfill(index === 0
      ? { status: 503, json: { error: 'Old failure' } }
      : { json: { action: 'play', requestedTrackCount: 1, tracks: [{ id: 1, title: 'Current mix', artist: 'Audit' }] } });
    finished++;
  });
  await page.route('**/api/stream/**', route => route.abort());
  await page.goto('http://localhost:8080/#/favorites');
  const submit = async () => {
    await page.keyboard.press('Control+k');
    await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
    await page.getByRole('textbox', { name: 'Ask AI for music' }).fill('play rock');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
  };
  await submit();
  await expect.poll(() => releases.length).toBe(1);
  await page.keyboard.press('Escape');
  await submit();
  await expect.poll(() => releases.length).toBe(2);
  releases[0]();
  await expect.poll(() => finished).toBe(1);
  await page.waitForTimeout(300);
  await expect(page.getByText('Old failure', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Go', exact: true })).toBeDisabled();
  const stream = page.waitForRequest('**/api/stream/1');
  releases[1]();
  await stream;
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
