import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { ok: true, user: { id: 'mobile-test', email: 'test@local', role: 'admin' } } });
    if (path.endsWith('/smart-playlists')) return route.fulfill({ json: { ok: true, items: [{ id: 1, name: 'A very long playlist name '.repeat(45), rules: {}, sort: 'random', limit: 50 }] } });
    return route.fulfill({ json: { ok: true, items: [], tracks: [], playlists: [], devices: [], searches: [] } });
  });
});

for (const viewport of [{ width: 320, height: 568 }, { width: 667, height: 320 }, { width: 390, height: 240 }]) {
  test(`search fits ${viewport.width}x${viewport.height} and has a touch close button`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/for-you`);
    const opener = page.getByRole('button', { name: 'Search', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Search library' });
    await expect(dialog.getByRole('textbox', { name: 'Search library' })).toBeFocused();
    const close = dialog.getByRole('button', { name: 'Close search', exact: true });
    await expect(close).toBeInViewport();
    await expect.poll(async () => {
      const bounds = await dialog.boundingBox();
      return !!bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height;
    }).toBe(true);
    const target = await close.boundingBox();
    expect(Math.round(target!.width)).toBeGreaterThanOrEqual(44);
    expect(Math.round(target!.height)).toBeGreaterThanOrEqual(44);
    await close.click();
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
}

test('long confirmation text scrolls while actions stay reachable on a short phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 320 });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/playlists/smart`);
  await page.getByTitle('Convert to playlist (snapshot current tracks)').click();
  const dialog = page.getByRole('dialog', { name: 'Convert to Playlist', exact: true });
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Convert', exact: true })).toBeInViewport();
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const body = dialog.locator('div').first();
  expect(await body.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
