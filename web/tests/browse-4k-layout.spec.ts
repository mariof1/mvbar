import { expect, test } from '@playwright/test';

test('4K browse fills its visible rows and preserves results in the artist side card', async ({ page }) => {
  await page.setViewportSize({ width: 3840, height: 2160 });
  await page.routeWebSocket('**/*', () => {});
  const listOffsets: number[] = [];
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/auth/me')) {
      return route.fulfill({ json: { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } } });
    }
    if (path.endsWith('/browse/artists')) {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      listOffsets.push(offset);
      const limit = Number(url.searchParams.get('limit') ?? 48);
      return route.fulfill({ json: { ok: true, total: 288, artists: Array.from(
        { length: Math.min(limit, 288 - offset) }, (_, i) => ({
          id: offset + i + 1, name: `Artist ${offset + i + 1}`,
          album_count: 1, track_count: 2,
        })) } });
    }
    const artistId = Number(path.match(/\/browse\/artist\/(\d+)$/)?.[1]);
    if (artistId) {
      return route.fulfill({ json: { ok: true, artist: { id: artistId, name: `Artist ${artistId}`, art_path: null },
        albums: [{ album: 'Album 1', display_artist: 'Artist 1', track_count: 2, art_path: null }],
        appearsOn: [] } });
    }
    if (path.endsWith('/browse/album')) {
      return route.fulfill({ json: { ok: true,
        album: { name: 'Album 1', artist: 'Artist 1', track_count: 2, art_path: null },
        tracks: [{ id: 11, title: 'First track', artist: 'Artist 1', album: 'Album 1',
          duration_ms: 180000, artists: [{ id: 1, name: 'Artist 1' }] }] } });
    }
    return route.fulfill({ json: { ok: true, total: 0, tracks: [], albums: [], artists: [],
      playlists: [], devices: [] } });
  });

  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/browse/artists`);
  const cards = page.locator('[data-flip-id^="artist:"]');
  await expect.poll(() => cards.count()).toBeGreaterThan(48);
  const scroll = page.locator('div.overflow-y-auto.no-scrollbar');
  await expect.poll(() => scroll.evaluate(element => element.scrollHeight - element.clientHeight))
    .toBeGreaterThanOrEqual(200);
  const geometry = await scroll.evaluate(element => {
    const grid = element.querySelector('.media-card-grid');
    const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0;
    const bottom = element.getBoundingClientRect().bottom;
    const rows = new Map<number, number>();
    for (const card of grid?.querySelectorAll('[data-flip-id^="artist:"]') ?? []) {
      const rect = card.getBoundingClientRect();
      if (rect.top >= bottom) continue;
      const top = Math.round(rect.top);
      rows.set(top, (rows.get(top) ?? 0) + 1);
    }
    return { columns, lastVisibleRow: [...rows.values()].at(-1),
      gapBelow: element.scrollHeight - element.clientHeight };
  });
  expect(geometry.columns).toBeGreaterThan(6);
  expect(geometry.lastVisibleRow).toBe(geometry.columns);

  await scroll.evaluate(element => {
    element.scrollTop = element.scrollHeight - element.clientHeight - 100;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect.poll(() => cards.count()).toBeGreaterThan(96);
  await page.waitForTimeout(350);
  const before = await scroll.evaluate(element => {
    element.scrollTop = 350;
    return element.scrollTop;
  });
  expect(before).toBeGreaterThan(0);
  const listStartRequests = listOffsets.filter(offset => offset === 0).length;
  const visibleArtistId = geometry.columns * 3 + 1;
  await page.locator(`[data-flip-id="artist:${visibleArtistId}"]`).click();
  const panel = page.getByTestId('browse-detail-panel');
  await panel.getByRole('button', { name: /Album 1/ }).first().click();
  await expect(panel.getByText('First track', { exact: true })).toBeVisible();
  expect(listOffsets.filter(offset => offset === 0)).toHaveLength(listStartRequests);
  expect(await scroll.evaluate(element => element.scrollTop)).toBe(before);
  await panel.getByRole('button', { name: 'Close details' }).click();
  await expect(panel).toBeHidden();
  expect(await scroll.evaluate(element => element.scrollTop)).toBe(before);
});
