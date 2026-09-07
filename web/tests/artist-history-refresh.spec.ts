import { test, expect } from '@playwright/test';
const base = process.env.MVBAR_TEST_URL || 'http://localhost:8080';
test.beforeEach(async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
    ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
    : { ok: true, total: 0, artists: [], albums: [], tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
});
test('artist navigation preserves the current albums and appearances', async ({ page }) => {
  let started = false, finished = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(/\/api\/browse\/artist\/\d+$/, async route => {
    const id = new URL(route.request().url()).pathname.split('/').pop()!;
    if (id === '1') { started = true; await held; }
    await route.fulfill({ json: { artist: { id: Number(id), name: `Artist ${id}` }, albums: [{ album: `Album ${id}`, display_artist: `Artist ${id}`, track_count: 1 }], appearsOn: [{ album: `Appearance ${id}`, album_artist: 'Audit', track_count: 1 }] } });
    if (id === '1') finished = true;
  });
  await page.goto(`${base}/#/browse/artist/1/First`);
  await expect.poll(() => started).toBe(true);
  await page.evaluate(() => { location.hash = '#/browse/artist/2/Second'; });
  await expect(page.getByText('Album 2', { exact: true })).toBeVisible();
  release();
  await expect.poll(() => finished).toBe(true);
  await page.waitForTimeout(250);
  await expect(page.getByText('Album 2', { exact: true })).toBeVisible();
  await expect(page.getByText('Appearance 2', { exact: true })).toBeVisible();
  await expect(page.getByText('Album 1', { exact: true })).toHaveCount(0);
});
test('history loading does not claim empty and older refresh cannot replace newer history', async ({ page }) => {
  let calls = 0, finished = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/history?*', async route => {
    const id = ++calls;
    if (id === 1) await held;
    await route.fulfill({ json: { tracks: [{ id, title: `History ${id}`, artist: 'Audit', played_at: new Date().toISOString() }] } });
    if (id === 1) finished = true;
  });
  await page.goto(`${base}/#/history`);
  await expect(page.getByText('Loading recently played songs...', { exact: true })).toBeVisible();
  await expect(page.getByText('No history yet', { exact: true })).toHaveCount(0);
  await expect.poll(() => calls).toBe(1);
  await page.getByTitle('Refresh', { exact: true }).click();
  await expect(page.getByText('History 2', { exact: true })).toBeVisible();
  release();
  await expect.poll(() => finished).toBe(true);
  await page.waitForTimeout(250);
  await expect(page.getByText('History 2', { exact: true })).toBeVisible();
  await expect(page.getByText('History 1', { exact: true })).toHaveCount(0);
});
test('history failure and genuine empty result remain distinct', async ({ page }) => {
  let fail = true;
  await page.route('**/api/history?*', route => route.fulfill(fail ? { status: 503, json: { error: 'Unavailable' } } : { json: { tracks: [] } }));
  await page.goto(`${base}/#/history`);
  await expect(page.getByText('Could not load recently played songs. Please try again.', { exact: true })).toBeVisible();
  await expect(page.getByText('No history yet', { exact: true })).toHaveCount(0);
  fail = false;
  await page.getByTitle('Refresh', { exact: true }).click();
  await expect(page.getByText('No history yet', { exact: true })).toBeVisible();
});
