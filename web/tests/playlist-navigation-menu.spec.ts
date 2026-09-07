import { test, expect, type Page } from '@playwright/test';

const base = process.env.MVBAR_TEST_URL || 'http://localhost:8080';
const playlist = (id: number) => ({ id: String(id), name: `Playlist ${id}`, is_owner: true, item_count: 1 });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json:
    new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, items: [], tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
});

test('navigation rejects older songs and collaborators', async ({ page }) => {
  await page.route('**/api/playlists', route => route.fulfill({ json: { playlists: [playlist(1), playlist(2)] } }));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started = 0;
  let finished = 0;
  await page.route(/\/api\/playlists\/\d+\/(items|collaborators)$/, async route => {
    const path = new URL(route.request().url()).pathname;
    const id = path.split('/')[3];
    if (id === '1') { started++; await held; }
    await route.fulfill({ json: path.endsWith('/items')
      ? { items: [{ id, track_id: id, position: 0, title: `Song ${id}`, artist: 'Audit', added_at: new Date().toISOString() }] }
      : { owner: { id, email: `owner${id}@local` }, isOwner: false, collaborators: [], eligibleFriends: [] }
    });
    if (id === '1') finished++;
  });
  await page.goto(`${base}/#/playlist/1`);
  await expect.poll(() => started).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => { location.hash = '#/playlist/2'; });
  await expect(page.getByText('Song 2', { exact: true })).toBeVisible();
  await expect(page.getByText('Shared by owner2@local', { exact: true })).toBeVisible();
  release();
  await expect.poll(() => finished).toBe(started);
  // Allow the released HTTP bodies to reach React before checking their effects.
  await page.waitForTimeout(250);
  await expect(page.getByText('Song 2', { exact: true })).toBeVisible();
  await expect(page.getByText('Shared by owner2@local', { exact: true })).toBeVisible();
  await expect(page.getByText('Song 1', { exact: true })).toHaveCount(0);
});

async function openMenu(page: Page, index = 0) {
  await page.route('**/api/favorites?*', route => route.fulfill({ json: { tracks:
    Array.from({ length: 12 }, (_, i) => ({ id: i + 1, title: `Audit ${i + 1}`, artist: 'Audit' }))
  } }));
  await page.goto(`${base}/#/favorites`);
  await page.getByRole('button', { name: 'Add to...', exact: true }).nth(index).click();
  await page.getByRole('button', { name: 'Add to playlist', exact: true }).click();
}

test('playlist submenu stays inside viewport as content and viewport change', async ({ page }) => {
  await page.route('**/api/playlists', route => route.fulfill({ json: { playlists: Array.from({ length: 20 }, (_, i) => playlist(i + 1)) } }));
  await openMenu(page, 5);
  await expect(page.getByRole('button', { name: 'Playlist 1', exact: true })).toBeVisible();
  const checkBounds = async () => {
    await expect.poll(async () => {
      const box = await page.getByRole('menu').boundingBox();
      const viewport = page.viewportSize()!;
      return !!box && box.y >= 8 && box.x >= 8 && box.y + box.height <= viewport.height - 7 && box.x + box.width <= viewport.width - 7;
    }).toBe(true);
  };
  await checkBounds();
  await page.getByRole('button', { name: 'New playlist...', exact: true }).click();
  await expect(page.getByPlaceholder('Playlist name')).toBeFocused();
  await checkBounds();
  await page.setViewportSize({ width: 390, height: 260 });
  await checkBounds();
  await page.getByPlaceholder('Playlist name').fill('Small screen');
  await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeInViewport();
});

test('playlist loading, failure, retry and empty results are distinct', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/playlists', async route => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 350));
    return calls === 1
      ? route.fulfill({ status: 503, json: { error: 'Unavailable' } })
      : route.fulfill({ json: { playlists: [] } });
  });
  await openMenu(page);
  await expect(page.getByText('Loading playlists...', { exact: true })).toBeVisible();
  await expect(page.getByText('No playlists yet', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('menu').getByRole('alert')).toHaveText('Could not load playlists.');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Loading playlists...', { exact: true })).toBeVisible();
  await expect(page.getByText('No playlists yet', { exact: true })).toBeVisible();
  await expect(page.getByRole('menu').getByRole('alert')).toHaveCount(0);
  expect(calls).toBe(2);
});
