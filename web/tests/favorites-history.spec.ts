import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json:
    new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, items: [], tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
});
const base = process.env.MVBAR_TEST_URL || 'http://localhost:8080';

const song = (id: number) => ({ id, title: `Audit song ${id}`, artist: 'Audit', path: 'audit.mp3', played_at: new Date().toISOString() });

test('favorites can load and remove a song beyond the first 200', async ({ page }) => {
  let songs = Array.from({ length: 201 }, (_, index) => song(index + 1));
  let removed = false;
  await page.route('**/api/favorites?*', route => {
    const url = new URL(route.request().url());
    const offset = Number(url.searchParams.get('offset') || 0);
    return route.fulfill({ json: { ok: true, tracks: songs.slice(offset, offset + 200), limit: 200, offset } });
  });
  await page.route('**/api/favorites/201', route => {
    expect(route.request().method()).toBe('DELETE');
    removed = true;
    songs = songs.filter(track => track.id !== 201);
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(`${base}/#/favorites`);
  await expect(page.getByRole('button', { name: /^Play Audit song / })).toHaveCount(200);
  await page.getByRole('button', { name: 'Load more favorites', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play Audit song 201', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more favorites', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove Audit song 201 from favorites', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play Audit song 201', exact: true })).toHaveCount(0);
  expect(removed).toBe(true);
});

for (const section of ['favorites', 'history']) {
  test(`${section} clears its error after a successful refresh`, async ({ page }) => {
    let fail = true;
    await page.route(`**/api/${section}?*`, route => route.fulfill(fail
      ? { status: 500, json: { error: 'Temporary failure' } }
      : { json: { ok: true, tracks: [song(1)] } }));
    await page.goto(`${base}/#/${section}`);
    const error = page.getByText(section === 'favorites' ? 'Could not load favorites. Please try again.' : 'Could not load recently played songs. Please try again.', { exact: true });
    await expect(error).toBeVisible();
    fail = false;
    await page.getByTitle('Refresh', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Play Audit song 1', exact: true })).toBeVisible();
    await expect(error).toHaveCount(0);
    if (section === 'history') {
      await page.getByTitle('Refresh', { exact: true }).focus();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name: 'Play Audit song 1', exact: true })).toBeFocused();
    }
  });
}

test('failed favorite removal shows an error and allows retry', async ({ page }) => {
  let removed = false;
  let fail = true;
  await page.route('**/api/favorites?*', route => route.fulfill({ json: { ok: true, tracks: removed ? [] : [song(1)] } }));
  await page.route('**/api/favorites/1', route => {
    if (fail) return route.fulfill({ status: 500, json: { error: 'Unavailable' } });
    removed = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(`${base}/#/favorites`);
  const remove = page.getByRole('button', { name: 'Remove Audit song 1 from favorites', exact: true });
  await remove.click();
  await expect(page.getByText('Could not remove this song from favorites. Please try again.', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play Audit song 1', exact: true })).toBeVisible();
  fail = false;
  await remove.click();
  await expect(page.getByRole('button', { name: 'Play Audit song 1', exact: true })).toHaveCount(0);
});
