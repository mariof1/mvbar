import { test, expect } from '@playwright/test';

for (const failure of ['http', 'response']) {
  test(`failed ${failure} preference save restores the switch and can be retried`, async ({ page }) => {
    await page.routeWebSocket('**/*', () => {});
    await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [], preferences: [] }
    }));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let patches = 0;
    await page.route('**/api/preferences', async route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: { ok: true, preferences: { prefer_hls: false, auto_continue: false }, lastfmEnabled: true } });
      patches++;
      if (patches === 1) {
        await held;
        return route.fulfill({ status: failure === 'http' ? 503 : 200, json: { ok: false } });
      }
      return route.fulfill({ json: { ok: true, preferences: { prefer_hls: true, auto_continue: false } } });
    });
    await page.goto('http://localhost:8080/#/settings');
    await page.getByRole('tab', { name: 'Playback', exact: true }).click();
    const hls = page.getByRole('switch', { name: 'Adaptive Streaming (HLS)' });
    await hls.click();
    await expect.poll(() => patches).toBe(1);
    await expect(hls).toBeChecked();
    release();
    await expect(hls).not.toBeChecked();
    await expect(page.getByText('Could not save preferences. Please try again.', { exact: true })).toBeVisible();
    await hls.click();
    await expect.poll(() => patches).toBe(2);
    await expect(hls).toBeChecked();
    await expect(page.getByText('Could not save preferences. Please try again.', { exact: true })).toHaveCount(0);
  });
}

test('preference controls wait for a save before allowing another change', async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
    ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
    : { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [], preferences: [] }
  }));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let patches = 0;
  await page.route('**/api/preferences', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { ok: true, preferences: { prefer_hls: false, auto_continue: false }, lastfmEnabled: true } });
    patches++;
    if (patches === 1) await held;
    return route.fulfill({ json: { ok: true, preferences: { prefer_hls: true, auto_continue: patches > 1 } } });
  });
  await page.goto('http://localhost:8080/#/settings');
  await page.getByRole('tab', { name: 'Playback', exact: true }).click();
  const hls = page.getByRole('switch', { name: 'Adaptive Streaming (HLS)' });
  const auto = page.getByRole('switch', { name: 'Continue Playback After Queue Ends' });
  await hls.click();
  await expect.poll(() => patches).toBe(1);
  await expect(hls).toBeDisabled();
  await expect(auto).toBeDisabled();
  await page.getByRole('tab', { name: 'Integrations', exact: true }).click();
  await page.getByLabel('OpenRouter API key', { exact: true }).fill('mock-key');
  await expect(page.getByRole('button', { name: 'Connect OpenRouter', exact: true })).toBeDisabled();
  release();
  await page.getByRole('tab', { name: 'Playback', exact: true }).click();
  await auto.click();
  await expect.poll(() => patches).toBe(2);
  await expect(hls).toBeChecked();
  await expect(auto).toBeChecked();
});
