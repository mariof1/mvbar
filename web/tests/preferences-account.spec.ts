import { test, expect } from '@playwright/test';

for (const pending of ['none', 'load', 'save', 'save failure']) {
  test(`preferences belong to the signed-in account with ${pending} pending`, async ({ page }) => {
    let account = 'first', reads = 0, started = false, finished = false, loggedIn = true;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.routeWebSocket('**/*', () => {});
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/auth/logout')) loggedIn = false;
      if (path.endsWith('/auth/login')) loggedIn = true;
      if (path.endsWith('/auth/me')) return route.fulfill(loggedIn
        ? { json: { ok: true, user: { id: account, email: `${account}@local`, role: 'admin' } } }
        : { status: 401, json: { ok: false } });
      return route.fulfill({ json: { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [], preferences: [] } });
    });
    await page.route('**/api/preferences', async route => {
      const first = account === 'first';
      if (route.request().method() === 'GET') reads++;
      if (first && ((pending === 'load' && route.request().method() === 'GET') || (pending.startsWith('save') && route.request().method() === 'PATCH'))) {
        started = true;
        await held;
      }
      await route.fulfill(first && pending === 'save failure' && route.request().method() === 'PATCH'
        ? { status: 503, json: { error: 'Unavailable' } }
        : { json: { ok: true, preferences: { auto_continue: first, prefer_hls: first }, lastfmEnabled: true, openrouterConfigured: first } });
      if (started && first) finished = true;
    });
    await page.goto('http://localhost:8080/#/settings');
    await page.getByRole('tab', { name: 'Playback', exact: true }).click();
    const hls = page.getByRole('switch', { name: 'Adaptive Streaming (HLS)' });
    if (pending !== 'load') await expect(hls).toBeChecked();
    if (pending.startsWith('save')) await hls.click();
    if (pending !== 'none') await expect.poll(() => started).toBe(true);
    await page.getByRole('tab', { name: 'Account', exact: true }).click();
    await page.getByRole('main').getByRole('button', { name: 'Sign Out', exact: true }).click();
    account = 'second';
    await page.locator('input[type="email"]').fill('second@local');
    await page.locator('input[type="password"]').fill('MockPassword123!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('tab', { name: 'Playback', exact: true }).click();
    await expect.poll(() => reads).toBe(2);
    await expect(hls).not.toBeChecked();
    if (pending !== 'none') {
      release();
      await expect.poll(() => finished).toBe(true);
      await page.waitForTimeout(250);
      await expect(hls).not.toBeChecked();
    }
    await page.keyboard.press('Control+k');
    await page.getByRole('button', { name: 'Ask AI', exact: true }).click();
    await expect(page.getByText('Connect OpenRouter to use AI music', { exact: true })).toBeVisible();
  });
}


