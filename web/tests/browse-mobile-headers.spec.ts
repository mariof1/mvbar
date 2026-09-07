import { test, expect } from '@playwright/test';
const base = process.env.MVBAR_TEST_URL || 'http://localhost:8080';
for (const [kind, name] of [['genre', 'Experimental/Atmospheric/Post-Rock'], ['country', 'Liechtenstein'], ['language', 'Português-Brasileiro']]) {
  for (const width of [320, 390, 1280]) {
    test(`${kind} long header keeps playback and add controls in view at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await page.routeWebSocket('**/*', () => {});
      await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
        ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
        : { ok: true, total: 0, artists: [], albums: [], tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
      }));
      await page.goto(`${base}/#/browse/${kind}/${encodeURIComponent(name)}`);
      const heading = page.getByRole('heading', { name, exact: true });
      const play = page.getByRole('button', { name: 'Play All', exact: true });
      const add = page.getByRole('button', { name: `Add ${name}...`, exact: true });
      await expect(heading).toBeVisible();
      for (const element of [heading, play, add]) {
        const box = (await element.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      expect((await play.boundingBox())!.height).toBeLessThan(50);
      await add.click();
      await expect(page.getByRole('menu')).toBeVisible();
      await page.keyboard.press('Escape');
      if (kind === 'genre' && width === 390) await page.screenshot({ path: testInfo.outputPath('mobile-header.png') });
    });
  }
}
