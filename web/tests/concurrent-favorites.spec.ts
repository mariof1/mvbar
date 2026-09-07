import { test, expect } from '@playwright/test';
const base = process.env.MVBAR_TEST_URL || 'http://localhost:8080';
for (const removeFirst of [false, true]) {
  test(`concurrent favorite ${removeFirst ? 'removal and addition' : 'additions'} preserve both results`, async ({ page }) => {
    await page.routeWebSocket('**/*', () => {});
    await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, total: 0, artists: [], albums: [], tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
    }));
    await page.route('**/api/favorites?*', route => route.fulfill({ json: { tracks: removeFirst ? [{ id: 1 }] : [] } }));
    await page.route('**/api/browse/album?*', route => route.fulfill({ json: { album: { name: 'Audit', artist: 'Audit' }, tracks: [1, 2].map(id => ({ id, title: `Song ${id}`, artist: 'Audit', artists: [], duration_ms: 10000 })) } }));
    let release!: () => void;
    let started = false;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/favorites/*', async route => {
      const id = new URL(route.request().url()).pathname.split('/').pop();
      if (id === '1') {
        expect(route.request().method()).toBe(removeFirst ? 'DELETE' : 'POST');
        started = true;
        await held;
      }
      await route.fulfill({ json: { ok: true } });
    });
    await page.goto(`${base}/#/browse/album/Audit/Audit`);
    await page.getByRole('button', { name: removeFirst ? 'Remove Song 1 from favorites' : 'Add Song 1 to favorites', exact: true }).click();
    await expect.poll(() => started).toBe(true);
    await page.getByRole('button', { name: 'Add Song 2 to favorites', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Remove Song 2 from favorites', exact: true })).toBeVisible();
    release();
    await expect(page.getByRole('button', { name: removeFirst ? 'Add Song 1 to favorites' : 'Remove Song 1 from favorites', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove Song 2 from favorites', exact: true })).toBeVisible();
  });
}
