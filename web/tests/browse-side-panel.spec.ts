import { test, expect } from '@playwright/test';

test('wide artist side card opens album tracks and returns without reloading browse results', async ({ page }) => {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.routeWebSocket('**/*', () => {});
  let artistListRequests = 0;
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) {
      return route.fulfill({ json: { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } } });
    }
    if (path.endsWith('/browse/artists')) {
      artistListRequests++;
      return route.fulfill({ json: { ok: true, total: 2, artists: [
        { id: 1, name: 'Artist A', album_count: 1, track_count: 2 },
        { id: 2, name: 'Artist B', album_count: 1, track_count: 2 },
      ] } });
    }
    if (path.endsWith('/browse/artist/1')) {
      return route.fulfill({ json: { ok: true, artist: { id: 1, name: 'Artist A', art_path: null },
        albums: [{ album: 'Album A', display_artist: 'Artist A', track_count: 2, art_path: null }], appearsOn: [] } });
    }
    if (path.endsWith('/browse/album')) {
      return route.fulfill({ json: { ok: true,
        album: { name: 'Album A', artist: 'Artist A', track_count: 2, art_path: null },
        tracks: [{ id: 11, title: 'First track', artist: 'Artist A', album: 'Album A',
          duration_ms: 180000, art_path: null, artists: [{ id: 1, name: 'Artist A' }] }] } });
    }
    return route.fulfill({ json: { ok: true, total: 0, artists: [], albums: [], tracks: [], playlists: [], devices: [] } });
  });

  const base = process.env.MVBAR_TEST_URL || 'http://localhost:8080';
  await page.goto(`${base}/#/browse/artists`);
  const cards = page.locator('[data-flip-id^="artist:"]');
  await expect(cards).toHaveCount(2);
  await page.locator('[data-flip-id="artist:1"]').click();
  const panel = page.getByTestId('browse-detail-panel');
  await expect(panel.getByRole('heading', { name: 'Artist A' })).toBeVisible();
  const artistUrl = page.url();
  const listRequests = artistListRequests;

  await panel.getByRole('button', { name: /Album A/ }).first().click();
  await expect(panel.getByRole('heading', { name: 'Album A' })).toBeVisible();
  await expect(panel.getByText('First track', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Back to Artist A albums' })).toBeVisible();
  expect(page.url()).toBe(artistUrl);
  await expect(cards).toHaveCount(2);
  expect(artistListRequests).toBe(listRequests);

  await panel.getByRole('button', { name: 'Back to Artist A albums' }).click();
  await expect(panel.getByRole('heading', { name: 'Artist A' })).toBeVisible();
  await expect(panel.getByRole('button', { name: /Album A/ }).first()).toBeVisible();
  expect(page.url()).toBe(artistUrl);
  expect(artistListRequests).toBe(listRequests);
});
