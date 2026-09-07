import { test, expect } from '@playwright/test';
const base = process.env.MVBAR_TEST_URL || 'http://localhost:8080';
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json:
    new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, total: 0, artists: [], albums: [], genres: [], countries: [], languages: [], items: [], tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
});
const detail = (album: string) => ({ album: { name: album, artist: 'Audit', art_path: null, total_discs: 1 }, tracks: [{ id: album === 'Older' ? 1 : 2, title: `${album} song`, artist: 'Audit', artists: [], duration_ms: 10000 }] });

test('Browse preserves the current album when an older request finishes', async ({ page }) => {
  let started = false;
  let finished = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/browse/album?*', async route => {
    const album = new URL(route.request().url()).searchParams.get('album')!;
    if (album === 'Older') { started = true; await held; }
    await route.fulfill({ json: detail(album) });
    if (album === 'Older') finished = true;
  });
  await page.goto(`${base}/#/browse/album/Audit/Older`);
  await expect.poll(() => started).toBe(true);
  await page.evaluate(() => { location.hash = '#/browse/album/Audit/Newer'; });
  await expect(page.getByText('Newer song', { exact: true })).toBeVisible();
  release();
  await expect.poll(() => finished).toBe(true);
  await page.waitForTimeout(250);
  await expect(page.getByRole('heading', { name: 'Newer', exact: true })).toBeVisible();
  await expect(page.getByText('Newer song', { exact: true })).toBeVisible();
  await expect(page.getByText('Older song', { exact: true })).toHaveCount(0);
});

for (const suffix of ['', '?artistId=7']) {
  test(`album links preserve encoded punctuation and artist IDs ${suffix}`, async ({ page }) => {
    const queries: URLSearchParams[] = [];
    await page.route('**/api/browse/album?*', route => {
      const query = new URL(route.request().url()).searchParams;
      queries.push(query);
      return route.fulfill({ json: detail(query.get('album')!) });
    });
    const hash = `#/browse/album/Audit/Who%3F%20Me%3F${suffix}`;
    await page.goto(`${base}/${hash}`);
    await expect(page.getByRole('heading', { name: 'Who? Me?', exact: true })).toBeVisible();
    expect(queries[0].get('album')).toBe('Who? Me?');
    if (suffix) expect(queries[0].get('artistId')).toBe('7');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Who? Me?', exact: true })).toBeVisible();
    expect(queries.every(query => query.get('album') === 'Who? Me?')).toBe(true);
  });
}

test('recommendation dialog traps focus, closes with Escape and restores focus', async ({ page }) => {
  await page.route('**/api/recommendations', route => route.fulfill({ json: { buckets: [{ key: 'audit', name: 'Audit Mix', count: 1, tracks: [{ id: 1, title: 'Audit song', artist: 'Audit' }], art_paths: [], art_hashes: [] }] } }));
  await page.goto(`${base}/#/for-you`);
  const opener = page.getByRole('button', { name: 'Why Audit Mix was recommended', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog');
  const close = dialog.getByRole('button', { name: 'Close', exact: true });
  const hide = dialog.getByRole('button', { name: 'Hide this mix', exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(hide).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});
