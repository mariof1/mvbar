import { test, expect } from '@playwright/test';
const base = process.env.MVBAR_TEST_URL || 'http://localhost:8080';
test.beforeEach(async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
    ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
    : { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
});
for (const mode of ['list', 'detail', 'play']) {
  test(`recent albums ${mode} failure is visible and retry recovers`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let fail = true;
    await page.route('**/api/browse/albums?*', route => route.fulfill(mode === 'list' && fail ? { status: 503, json: { error: 'Unavailable' } } : { json: { albums: [{ album: 'Audit', display_artist: 'Audit', track_count: 1, first_track_id: 1 }] } }));
    await page.route('**/api/browse/album?*', route => route.fulfill(fail ? { status: 503, json: { error: 'Unavailable' } } : { json: { tracks: [{ id: 1, title: 'Recovered song', artist: 'Audit', duration_ms: 10000 }] } }));
    await page.goto(`${base}/#/recently-added`);
    if (mode === 'detail') await page.getByRole('button', { name: 'Open album Audit', exact: true }).click();
    if (mode === 'play') await page.getByRole('button', { name: 'Play album Audit', exact: true }).click();
    await expect(page.getByText(mode === 'list' ? 'Could not load recently added albums.' : mode === 'detail' ? 'Could not load album tracks.' : 'Could not play album. Please try again.', { exact: true })).toBeVisible();
    fail = false;
    if (mode === 'play') {
      const stream = page.waitForRequest('**/api/stream/1');
      await page.getByRole('button', { name: 'Play album Audit', exact: true }).click();
      await stream;
    } else {
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect(page.getByRole('button', { name: mode === 'list' ? 'Open album Audit' : 'Play Recovered song', exact: true })).toBeVisible();
      await expect(page.getByText(mode === 'list' ? 'Could not load recently added albums.' : 'Could not load album tracks.', { exact: true })).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
}
