import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json:
    new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, items: [], tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
});
const base = process.env.MVBAR_TEST_URL || 'http://localhost:8080';

test('playlist creation blocks repeated submissions and permits retry after failure', async ({ page }) => {
  let posts = 0;
  await page.route('**/api/playlists', async route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { playlists: [] } });
    posts++;
    await new Promise(resolve => setTimeout(resolve, 700));
    return posts === 1
      ? route.fulfill({ status: 500, json: { error: 'Please retry' } })
      : route.fulfill({ json: { ok: true, playlist: { id: 1 } } });
  });
  await page.goto(`${base}/#/playlists/regular`);
  const input = page.getByPlaceholder('New playlist name...');
  await input.fill('Audit playlist');
  await input.press('Enter');
  await expect(input).toBeDisabled();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Please retry', { exact: true })).toBeVisible();
  expect(posts).toBe(1);
  await expect(input).toHaveValue('Audit playlist');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  expect(posts).toBe(2);
});

test('older podcast search cannot replace newer results', async ({ page }) => {
  let finishOlder!: () => void;
  const olderFinished = new Promise<void>(resolve => { finishOlder = resolve; });
  await page.route('**/api/podcasts/search?*', async route => {
    const query = new URL(route.request().url()).searchParams.get('q');
    await new Promise(resolve => setTimeout(resolve, query === 'older' ? 1200 : 50));
    await route.fulfill({ json: { results: [{ id: query, title: `${query} result`, author: 'Audit', feedUrl: `https://example.test/${query}` }] } });
    if (query === 'older') finishOlder();
  });
  await page.goto(`${base}/#/podcasts`);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Search for podcasts' });
  await input.fill('older');
  const started = page.waitForRequest('**/api/podcasts/search?q=older');
  await input.press('Enter');
  await started;
  await input.fill('newer');
  await input.press('Enter');
  await expect(page.getByRole('heading', { name: 'newer result' })).toBeVisible();
  await olderFinished;
  await expect(page.getByRole('heading', { name: 'newer result' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'older result' })).toHaveCount(0);
});

test('Connect from remote playback bar stays in viewport and closes with Escape', async ({ page }) => {
  await page.routeWebSocket('**/*', socket => {
    socket.onMessage(() => socket.send(JSON.stringify({ type: 'connect:devices', data: { devices: [{
      id: 'remote', name: 'Audit TV', type: 'tv', platform: 'Android', capabilities: [],
      state: { track: { id: 1, title: 'Audit song', artist: 'Audit' }, queue: [], queueIndex: 0,
        queueLength: 1, isPlaying: true, positionMs: 0, durationMs: 120000, volume: 1, updatedAt: Date.now() }
    }] } })));
  });
  await page.goto(`${base}/#/playlists/smart`);
  await expect(page.getByRole('button', { name: 'Queue on Audit TV' })).toBeVisible();
  const trigger = page.getByRole('button', { name: 'MVBar Connect players', exact: true }).filter({ visible: true }).last();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'MVBar Connect', exact: true });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(900);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
