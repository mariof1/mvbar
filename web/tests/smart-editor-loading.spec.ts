import { test, expect } from '@playwright/test';

for (const create of [false, true]) {
  test(`a delayed artist lookup cannot change ${create ? 'a new draft' : 'another playlist’s criteria'}`, async ({ page }) => {
    await page.routeWebSocket('**/*', () => {});
    await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, items: [], tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
    }));
    const playlists = [1, 2].map(id => ({ id, name: `Playlist ${id}`, sort: 'random', filters: { favoriteOnly: false, include: { artists: [id], genres: [id === 1 ? 'Rock' : 'Jazz'] }, exclude: {} } }));
    let saved: any = null;
    await page.route('**/api/smart-playlists', route => {
      if (route.request().method() === 'POST') saved = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true, items: playlists } });
    });
    await page.route('**/api/smart-playlists/2', route => {
      saved = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true } });
    });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started = false, finished = false;
    await page.route('**/api/smart-playlists/suggest?*', async route => {
      const id = Number(new URL(route.request().url()).searchParams.get('ids'));
      if (id === 1) { started = true; await held; }
      await route.fulfill({ json: { items: [{ id, name: `Artist ${id}` }] } });
      if (id === 1) finished = true;
    });
    await page.goto('http://localhost:8080/#/playlists/smart');
    await page.getByTitle('Edit', { exact: true }).nth(0).click();
    await expect.poll(() => started).toBe(true);
    if (create) {
      await page.getByRole('button', { name: 'Create Smart Playlist', exact: true }).click();
      await page.getByLabel('Name', { exact: true }).fill('New draft');
    } else {
      await page.getByTitle('Edit', { exact: true }).nth(1).click();
      await expect(page.getByRole('button', { name: 'Remove Jazz', exact: true })).toBeVisible();
    }
    release();
    await expect.poll(() => finished).toBe(true);
    await page.waitForTimeout(250);
    await expect(page.getByRole('button', { name: 'Remove Rock', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(create ? 'New draft' : 'Playlist 2');
    await page.getByRole('button', { name: create ? 'Create Playlist' : 'Save Changes', exact: true }).click();
    await expect.poll(() => saved).not.toBeNull();
    expect(saved.filters.include.genres).toEqual(create ? [] : ['Jazz']);
    expect(saved.filters.include.artists).toEqual(create ? [] : [2]);
  });
}
