import { test, expect } from '@playwright/test';
const base = process.env.MVBAR_TEST_URL || 'http://localhost:8080';
test.beforeEach(async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
    ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
    : { ok: true, total: 0, artists: [], albums: [], genres: [], countries: [], languages: [], tracks: [], buckets: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
});
test('ListenBrainz recommendation link opens settings without a document navigation', async ({ page }) => {
  await page.goto(`${base}/#/for-you`);
  let documents = 0;
  page.on('request', request => { if (request.resourceType() === 'document') documents++; });
  await page.getByRole('link', { name: 'ListenBrainz', exact: true }).click();
  await expect(page).toHaveURL(`${base}/#/settings`);
  await expect(page.getByText('This page could not be found.')).toHaveCount(0);
  expect(documents).toBe(0);
});
for (const action of ['Play next', 'Add to queue']) {
  test(`${action} reports track load failures and permits retry`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/browse/albums?*', route => route.fulfill({ json: { albums: [{ album: 'Audit', display_artist: 'Audit', track_count: 1, first_track_id: 1 }] } }));
    let attempts = 0;
    await page.route('**/api/browse/album?*', route => {
      attempts++;
      return attempts === 1 ? route.fulfill({ status: 503, json: { error: 'Unavailable' } }) : route.fulfill({ json: { tracks: [{ id: 1, title: 'Retry song', artist: 'Audit' }] } });
    });
    await page.goto(`${base}/#/recently-added`);
    const trigger = page.getByRole('button', { name: 'Add Audit...', exact: true });
    await trigger.click();
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(page.getByText(action === 'Play next' ? 'Could not add tracks to play next. Please try again.' : 'Could not add tracks to queue. Please try again.', { exact: true })).toBeVisible();
    await trigger.click();
    await page.getByRole('button', { name: action, exact: true }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    expect(attempts).toBe(2);
    expect(errors).toEqual([]);
  });
}
for (const kind of ['genre', 'country', 'language']) {
  test(`${kind} navigation ignores a delayed earlier response`, async ({ page }) => {
    let started = false;
    let finished = false;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/browse/${kind}/*/tracks?*`, async route => {
      const key = new URL(route.request().url()).pathname.split('/')[4];
      if (key === 'Older') { started = true; await held; }
      await route.fulfill({ json: { tracks: [{ id: key === 'Older' ? 1 : 2, title: `${key} song`, artist: 'Audit', artists: [], duration_ms: 10000 }] } });
      if (key === 'Older') finished = true;
    });
    await page.goto(`${base}/#/browse/${kind}/Older`);
    await expect.poll(() => started).toBe(true);
    await page.evaluate(k => { location.hash = `#/browse/${k}/Newer`; }, kind);
    await expect(page.getByText('Newer song', { exact: true })).toBeVisible();
    release();
    await expect.poll(() => finished).toBe(true);
    await page.waitForTimeout(250);
    await expect(page.getByText('Newer song', { exact: true })).toBeVisible();
    await expect(page.getByText('Older song', { exact: true })).toHaveCount(0);
  });
}
