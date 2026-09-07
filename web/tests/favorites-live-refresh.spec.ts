import { test, expect } from '@playwright/test';
for (const added of [true, false]) {
  test(`live favorite ${added ? 'addition' : 'removal'} survives an older refresh`, async ({ page }) => {
    let update = () => {};
    await page.routeWebSocket('**/*', socket => { update = () => socket.send(JSON.stringify({ type: added ? 'favorite:added' : 'favorite:removed', data: { trackId: 1 } })); });
    await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, total: 0, artists: [], albums: [], tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
    }));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started = false, finished = false;
    await page.route('**/api/favorites?*', async route => {
      started = true;
      await held;
      await route.fulfill({ json: { tracks: added ? [] : [{ id: 1 }] } });
      finished = true;
    });
    await page.route('**/api/browse/album?*', route => route.fulfill({ json: { album: { name: 'Audit', artist: 'Audit' }, tracks: [{ id: 1, title: 'Song', artist: 'Audit', artists: [], duration_ms: 10000 }] } }));
    await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/browse/album/Audit/Audit`);
    await expect.poll(() => started).toBe(true);
    await expect(page.getByText('Song', { exact: true })).toBeVisible();
    update();
    const label = added ? 'Remove Song from favorites' : 'Add Song to favorites';
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
    // A removal can leave the pre-refresh UI unchanged; allow event delivery.
    await page.waitForTimeout(150);
    release();
    await expect.poll(() => finished).toBe(true);
    await page.waitForTimeout(200);
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
  });
}
