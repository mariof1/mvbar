import { test, expect } from '@playwright/test';

for (const update of ['live update', 'account switch', 'page visit']) {
  test(`an old social badge response cannot overwrite a ${update}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    let emit!: () => void;
    await page.routeWebSocket('**/*', socket => { emit = () => socket.send(JSON.stringify({ type: 'social:shares_read_all', data: {} })); });
    let loggedIn = true, account = 'first';
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/auth/logout')) loggedIn = false;
      if (path.endsWith('/auth/login')) { loggedIn = true; account = 'second'; }
      if (path.endsWith('/auth/me')) return route.fulfill(loggedIn
        ? { json: { ok: true, user: { id: account, email: `${account}@local`, role: 'admin' } } }
        : { status: 401, json: { ok: false } });
      return route.fulfill({ json: { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [] } });
    });
    await page.route('**/api/social/shares?*', route => route.fulfill({ json: { shares: [], total: 0 } }));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let requests = 0, finished = false;
    await page.route('**/api/social/summary', async route => {
      const old = ++requests === 1;
      if (old) await held;
      await route.fulfill({ json: { unreadShares: old ? 9 : 0, incoming: [], outgoing: [], friends: [] } });
      if (old) finished = true;
    });
    await page.goto('http://localhost:8080/#/favorites');
    await expect.poll(() => requests).toBe(1);
    if (update === 'account switch') {
      await page.getByRole('complementary').getByRole('button', { name: 'Sign Out', exact: true }).click();
      await page.getByLabel('Email', { exact: true }).fill('second@local');
      await page.getByLabel('Password', { exact: true }).fill('MockPassword123!');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByRole('complementary').getByText('second@local', { exact: true })).toBeVisible();
    } else if (update === 'page visit') {
      await page.getByRole('complementary').getByRole('button', { name: 'Friends & Sharing', exact: true }).click();
      await expect(page.getByText('No songs shared with you yet', { exact: true })).toBeVisible();
    } else {
      await expect.poll(() => typeof emit).toBe('function');
      emit();
    }
    await expect.poll(() => requests).toBe(2);
    const badge = page.getByRole('complementary').getByRole('button', { name: /^Friends & Sharing/ });
    await expect(badge).toHaveText('Friends & Sharing');
    release();
    await expect.poll(() => finished).toBe(true);
    await page.waitForTimeout(250);
    await expect(badge).toHaveText('Friends & Sharing');
  });
}
