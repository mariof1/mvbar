import { test, expect } from '@playwright/test';
const base = process.env.MVBAR_TEST_URL || 'http://localhost:8080';
for (const kind of ['artists', 'albums']) {
  for (const width of [1280, 390]) {
    test(`${kind} pagination and live refresh preserve scroll at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      let emitUpdate = () => {};
      await page.routeWebSocket('**/*', socket => {
        emitUpdate = () => socket.send(JSON.stringify({ type: 'library:update', data: { event: 'track_updated', ts: Date.now() } }));
      });
      await page.addInitScript(() => {
        (window as any).cardMoves = [];
        const animate = Element.prototype.animate;
        Element.prototype.animate = function (frames, options) {
          if (this.hasAttribute('data-flip-id')) (window as any).cardMoves.push(frames);
          return animate.call(this, frames, options);
        };
      });
      await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
        ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
        : { ok: true, total: 0, artists: [], albums: [], tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
      }));
      const calls: { offset: number; limit: number }[] = [];
      await page.route(`**/api/browse/${kind}?*`, async route => {
        const q = new URL(route.request().url()).searchParams;
        const offset = Number(q.get('offset')), limit = Math.min(200, Number(q.get('limit')));
        calls.push({ offset, limit });
        await new Promise(resolve => setTimeout(resolve, 150));
        await route.fulfill({ json: { total: 288, [kind]: Array.from({ length: Math.min(limit, 288 - offset) }, (_, i) => ({ id: offset + i + 1, name: `Artist ${offset + i + 1}`, album: `Album ${offset + i + 1}`, display_artist: 'Audit', track_count: 1, album_count: 1 })) } });
      });
      await page.goto(`${base}/#/browse/${kind}`);
      const cards = page.locator('[data-flip-id]');
      const scroll = page.locator('div.overflow-y-auto.no-scrollbar');
      await expect(cards).toHaveCount(48);
      expect(calls).toEqual([{ offset: 0, limit: 48 }]);
      for (let count = 96; count <= 240; count += 48) {
        const before = await scroll.evaluate(el => {
          el.scrollTop = el.scrollHeight - el.clientHeight - 100;
          // Multiple scroll events before React rerenders must share one request.
          for (let i = 0; i < 8; i++) el.dispatchEvent(new Event('scroll', { bubbles: true }));
          return el.scrollTop;
        });
        await expect(cards).toHaveCount(count);
        expect(await scroll.evaluate(el => el.scrollTop)).toBeCloseTo(before, 0);
      }
      expect(calls.map(call => call.offset)).toEqual([0, 48, 96, 144, 192]);
      expect(await page.evaluate(() => (window as any).cardMoves)).toEqual([]);
      const beforeRefresh = await scroll.evaluate(el => el.scrollTop);
      emitUpdate();
      await expect.poll(() => calls.length).toBe(7);
      await page.waitForTimeout(250);
      await expect(cards).toHaveCount(240);
      expect(calls.slice(-2)).toEqual([{ offset: 0, limit: 200 }, { offset: 200, limit: 40 }]);
      expect(await scroll.evaluate(el => el.scrollTop)).toBeCloseTo(beforeRefresh, 0);
      expect(await cards.evaluateAll(elements => new Set(elements.map(el => el.getAttribute('data-flip-id'))).size)).toBe(240);
    });
  }
}
