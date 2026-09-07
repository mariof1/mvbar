import { test, expect } from '@playwright/test';
const base = process.env.MVBAR_TEST_URL || 'http://localhost:8080';
for (const kind of ['album', 'genre', 'country', 'language']) {
  test(`${kind} track playback is reachable and operable with the keyboard`, async ({ page }) => {
    await page.routeWebSocket('**/*', () => {});
    await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, total: 0, artists: [], albums: [], tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
    }));
    const tracks = [{ id: 1, title: 'Keyboard song', artist: 'Audit', artists: [], duration_ms: 10000 }];
    await page.route(kind === 'album' ? '**/api/browse/album?*' : `**/api/browse/${kind}/*/tracks?*`, route => route.fulfill({ json: { album: { name: 'Audit', artist: 'Audit' }, tracks } }));
    await page.goto(`${base}/#/browse/${kind === 'album' ? 'album/Audit/Audit' : `${kind}/Audit`}`);
    const play = page.getByRole('button', { name: 'Play Keyboard song', exact: true });
    await expect(play).toBeVisible();
    await page.getByRole('button', { name: 'Add Audit...', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(play).toBeFocused();
    await expect(play.locator('svg')).toBeVisible();
    const stream = page.waitForRequest('**/api/stream/1');
    await page.keyboard.press('Enter');
    await stream;
  });
}
