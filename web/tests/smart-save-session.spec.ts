import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
    ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
    : { ok: true, items: [], tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
});

for (const fail of [false, true]) {
  test(`a pending smart playlist ${fail ? 'failure' : 'success'} cannot close or alter a new editor`, async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let requests = 0, finished = false;
    await page.route('**/api/smart-playlists', async route => {
      if (route.request().method() !== 'POST') return route.fulfill({ json: { ok: true, items: [] } });
      requests++;
      await held;
      await route.fulfill(fail ? { status: 503, json: { error: 'Old save failed' } } : { json: { ok: true, id: 1 } });
      finished = true;
    });
    await page.goto('http://localhost:8080/#/playlists/smart');
    await page.getByRole('button', { name: 'Create Smart Playlist', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('First draft');
    await page.getByRole('button', { name: 'Create Playlist', exact: true }).dblclick();
    await expect.poll(() => requests).toBeGreaterThan(0);
    expect(requests).toBe(1);
    await expect(page.getByLabel('Name', { exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Close smart playlist editor' }).click();
    await page.getByRole('button', { name: 'Create Smart Playlist', exact: true }).click();
    const name = page.getByLabel('Name', { exact: true });
    await name.fill('New draft');
    release();
    await expect.poll(() => finished).toBe(true);
    await page.waitForTimeout(250);
    await expect(name).toHaveValue('New draft');
    await expect(page.getByRole('button', { name: 'Create Playlist', exact: true })).toBeEnabled();
    await expect(page.getByText('Old save failed', { exact: true })).toHaveCount(0);
  });
}

test('a failed smart playlist save preserves the draft for retry', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/smart-playlists', route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: { ok: true, items: [] } });
    return route.fulfill(++requests === 1 ? { status: 503, json: { error: 'Save unavailable' } } : { json: { ok: true, id: 1 } });
  });
  await page.goto('http://localhost:8080/#/playlists/smart');
  await page.getByRole('button', { name: 'Create Smart Playlist', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Keep this draft');
  await page.getByRole('button', { name: 'Create Playlist', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Save unavailable' })).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Keep this draft');
  await page.getByRole('button', { name: 'Create Playlist', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create Smart Playlist', exact: true })).toBeVisible();
  expect(requests).toBe(2);
});
