import { test, expect, type Page } from '@playwright/test';

const base = process.env.MVBAR_TEST_URL || 'http://localhost:8080';
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json:
    new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, items: [], tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
});

async function albums(page: Page) {
  await page.route('**/api/browse/albums?*', route => route.fulfill({ json: { albums:
    ['Older', 'Newer'].map((album, index) => ({ album, display_artist: 'Audit', track_count: 1, first_track_id: index + 1 }))
  } }));
  await page.goto(`${base}/#/recently-added`);
}

test('leaving an album cancels its pending request and preserves the next album', async ({ page }) => {
  let started = false;
  let cancelled = false;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  page.on('requestfailed', request => {
    if (request.url().includes('/browse/album?album=Older')) cancelled = true;
  });
  await page.route('**/api/browse/album?*', async route => {
    const album = new URL(route.request().url()).searchParams.get('album');
    if (album === 'Older') { started = true; await held; }
    await route.fulfill({ json: { tracks: [{ id: album === 'Older' ? 1 : 2, title: `${album} song`, artist: 'Audit', duration_ms: 10000 }] } });
  });
  await albums(page);
  await page.getByRole('button', { name: 'Open album Older', exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('button', { name: 'Open album Newer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play Newer song', exact: true })).toBeVisible();
  await expect.poll(() => cancelled).toBe(true);
  release();
  await expect(page.getByRole('heading', { name: 'Newer', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play Older song', exact: true })).toHaveCount(0);
});

test('album and song controls work with keyboard and reveal focused actions', async ({ page }) => {
  await page.route('**/api/browse/album?*', route => route.fulfill({ json: { tracks: [{ id: 1, title: 'Keyboard song', artist: 'Audit', duration_ms: 10000 }] } }));
  await albums(page);
  await page.mouse.move(0, 0);
  const open = page.getByRole('button', { name: 'Open album Older', exact: true });
  const playAlbum = page.getByRole('button', { name: 'Play album Older', exact: true });
  await open.focus();
  await page.keyboard.press('Tab');
  await expect(playAlbum).toBeFocused();
  await expect.poll(() => playAlbum.evaluate(el => getComputedStyle(el.parentElement!).opacity)).toBe('1');
  await page.keyboard.press('Tab');
  const add = page.getByRole('button', { name: 'Add Older...', exact: true });
  await expect(add).toBeFocused();
  await expect.poll(() => add.evaluate(el => getComputedStyle(el.parentElement!).opacity)).toBe('1');
  await open.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Older', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Play All', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Play Keyboard song', exact: true })).toBeFocused();
  const stream = page.waitForRequest('**/api/stream/1');
  await page.keyboard.press('Space');
  await stream;
});

test('failed playlist deletion shows an error and succeeds on retry', async ({ page }) => {
  let attempts = 0;
  let removed = false;
  await page.route('**/api/playlists', route => route.fulfill({ json: { playlists: removed ? [] : [{ id: '1', name: 'Keep me', is_owner: true, item_count: 1 }] } }));
  await page.route('**/api/playlists/1', route => {
    expect(route.request().method()).toBe('DELETE');
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
    removed = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(`${base}/#/playlists/regular`);
  const remove = async () => {
    await page.getByRole('button', { name: 'Delete playlist', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  };
  await remove();
  await expect(page.getByText('Could not delete playlist. Please try again.', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Keep me', { exact: true })).toBeVisible();
  await remove();
  await expect(page.getByText('Keep me', { exact: true })).toHaveCount(0);
  expect(attempts).toBe(2);
});
