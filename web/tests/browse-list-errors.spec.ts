import { test, expect } from '@playwright/test';
for (const kind of ['artists', 'albums', 'genres', 'countries', 'languages']) {
  test(`${kind} initial failure offers retry without claiming an empty library`, async ({ page }) => {
    await page.routeWebSocket('**/*', () => {});
    await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
    }));
    let fail = true;
    await page.route(`**/api/browse/${kind}*`, route => route.fulfill(fail ? { status: 503, json: { error: 'Unavailable' } } : { json: { total: 1, [kind]: [{ id: 1, name: 'Recovered', album: 'Recovered', display_artist: 'Audit', genre: 'Recovered', country: 'Recovered', language: 'Recovered', track_count: 1, album_count: 1, artist_count: 1 }] } }));
    await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/browse/${kind}`);
    await expect(page.getByText(`Could not load ${kind}. Please try again.`, { exact: true })).toBeVisible();
    await expect(page.getByText('Unavailable', { exact: true })).toBeVisible();
    fail = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByText('Recovered', { exact: true })).toBeVisible();
    await expect(page.getByText(`Could not load ${kind}. Please try again.`, { exact: true })).toHaveCount(0);
  });
}

test('failed artist pagination keeps loaded cards and retries the same page', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
    ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
    : { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
  let fail = true;
  const offsets: number[] = [];
  await page.route('**/api/browse/artists?*', route => {
    const offset = Number(new URL(route.request().url()).searchParams.get('offset'));
    offsets.push(offset);
    return route.fulfill(offset > 0 && fail ? { status: 503, json: { error: 'Unavailable' } } : { json: { total: 96, artists: Array.from({ length: 48 }, (_, i) => ({ id: offset + i + 1, name: `Artist ${offset + i + 1}`, track_count: 1, album_count: 1 })) } });
  });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/browse/artists`);
  const cards = page.locator('[data-flip-id]');
  await expect(cards).toHaveCount(48);
  await page.locator('div.overflow-y-auto.no-scrollbar').evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 100; });
  await expect(page.getByText('Could not load artists. Please try again.', { exact: true })).toBeVisible();
  await expect(cards).toHaveCount(48);
  fail = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(cards).toHaveCount(96);
  expect(offsets).toEqual([0, 48, 48]);
});
