import { test, expect } from '@playwright/test';
const base = process.env.MVBAR_TEST_URL || 'http://localhost:8080';
test.beforeEach(async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
    ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
    : { ok: true, total: 0, artists: [], albums: [], tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
});
test('failed favorite update reports an error without an unhandled rejection and permits retry', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/browse/album?*', route => route.fulfill({ json: { album: { name: 'Audit', artist: 'Audit' }, tracks: [{ id: 1, title: 'Audit song', artist: 'Audit', artists: [], duration_ms: 10000 }] } }));
  let fail = true;
  await page.route('**/api/favorites/1', route => route.fulfill(fail ? { status: 503, json: { error: 'Unavailable' } } : { json: { ok: true } }));
  await page.goto(`${base}/#/browse/album/Audit/Audit`);
  const add = page.getByRole('button', { name: 'Add Audit song to favorites', exact: true });
  await add.click();
  await expect(page.getByText('Could not update favorites. Please try again.', { exact: true })).toBeVisible();
  await expect(add).toBeVisible();
  fail = false;
  await add.click();
  await expect(page.getByRole('button', { name: 'Remove Audit song from favorites', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
for (const name of ['100%', '%E0%A4%A']) {
  test(`pasted route containing ${name} does not throw a URI error`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/#/browse/genre/${name}`);
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await page.evaluate(() => { location.hash = '#/browse/genre/Jazz'; });
    await expect(page.getByRole('heading', { name: 'Jazz', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
