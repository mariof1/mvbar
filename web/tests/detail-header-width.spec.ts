import { test, expect } from '@playwright/test';
for (const kind of ['artist', 'recent']) {
  for (const width of [320, 390, 1280]) {
    test(`${kind} long detail names fit at ${width}px without collapsing artwork`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.routeWebSocket('**/*', () => {});
      await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
        ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
        : { ok: true, total: 0, artists: [], albums: [], tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
      }));
      const name = 'Supercalifragilisticexpialidocious';
      const base = process.env.MVBAR_TEST_URL || 'http://localhost:8080';
      if (kind === 'artist') {
        await page.route('**/api/browse/artist/1', route => route.fulfill({ json: { artist: { id: 1, name }, albums: [], appearsOn: [] } }));
        await page.goto(`${base}/#/browse/artist/1/${name}`);
      } else {
        await page.route('**/api/browse/albums?*', route => route.fulfill({ json: { albums: [{ album: name, display_artist: name, track_count: 1, first_track_id: 1 }] } }));
        await page.goto(`${base}/#/recently-added`);
        await page.getByRole('button', { name: `Open album ${name}`, exact: true }).click();
      }
      const heading = page.getByRole('heading', { name, exact: true });
      await expect(heading).toBeVisible();
      const box = (await heading.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      const header = heading.locator('..').locator('..');
      const artwork = await header.locator(':scope > :first-child').boundingBox();
      expect(artwork!.width).toBe(width < 640 ? 96 : kind === 'artist' ? 128 : 160);
      expect(artwork!.height).toBe(artwork!.width);
      const action = page.getByRole('button', { name: kind === 'artist' ? `Add ${name}...` : 'Play All', exact: true });
      const actionBox = (await action.boundingBox())!;
      expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(width);
    });
  }
}
