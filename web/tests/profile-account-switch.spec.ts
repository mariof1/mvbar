import { test, expect } from '@playwright/test';

test('late profile response from signed-out account cannot replace the current avatar', async ({ page }) => {
  let account = 'first', loggedIn = true, firstStarted = false, firstFinished = false;
  let releaseFirst!: () => void;
  const heldFirst = new Promise<void>(resolve => { releaseFirst = resolve; });
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/logout')) loggedIn = false;
    if (path.endsWith('/auth/login')) loggedIn = true;
    if (path.endsWith('/auth/me')) return route.fulfill(loggedIn
      ? { json: { ok: true, user: { id: account, email: `${account}@local`, role: 'admin' } } }
      : { status: 401, json: { ok: false } });
    if (path.endsWith('/users/profile')) {
      const requestedAccount = account;
      if (requestedAccount === 'first') { firstStarted = true; await heldFirst; }
      await route.fulfill({ json: { id: requestedAccount, email: `${requestedAccount}@local`, role: 'admin',
        avatar_path: `${requestedAccount}-avatar`, auth_type: 'local', created_at: '2026-09-01T00:00:00Z' } });
      if (requestedAccount === 'first') firstFinished = true;
      return;
    }
    return route.fulfill({ json: { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [], preferences: [] } });
  });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/settings`);
  await expect.poll(() => firstStarted).toBe(true);
  await page.getByRole('main').getByRole('button', { name: 'Sign Out', exact: true }).click();
  account = 'second';
  await page.locator('input[type="email"]').fill('second@local');
  await page.locator('input[type="password"]').fill('MockPassword123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('img[src="/api/avatars/second-avatar"]').first()).toBeVisible();
  releaseFirst();
  await expect.poll(() => firstFinished).toBe(true);
  await page.waitForTimeout(250);
  await expect(page.locator('img[src="/api/avatars/first-avatar"]')).toHaveCount(0);
  await expect(page.locator('img[src="/api/avatars/second-avatar"]').first()).toBeVisible();
});

test('late integration status from signed-out account cannot appear under the next account', async ({ page }) => {
  let account = 'first', loggedIn = true, firstStarted = false, firstFinished = false;
  let releaseFirst!: () => void;
  const heldFirst = new Promise<void>(resolve => { releaseFirst = resolve; });
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/logout')) loggedIn = false;
    if (path.endsWith('/auth/login')) loggedIn = true;
    if (path.endsWith('/auth/me')) return route.fulfill(loggedIn
      ? { json: { ok: true, user: { id: account, email: `${account}@local`, role: 'admin' } } }
      : { status: 401, json: { ok: false } });
    if (path.endsWith('/lastfm/settings')) {
      const requestedAccount = account;
      if (requestedAccount === 'first') { firstStarted = true; await heldFirst; }
      await route.fulfill({ json: { ok: true, available: true, connected: requestedAccount === 'first',
        username: requestedAccount === 'first' ? 'first-lastfm' : null } });
      if (requestedAccount === 'first') firstFinished = true;
      return;
    }
    if (path.endsWith('/users/profile')) return route.fulfill({ json: { id: account, email: `${account}@local`, role: 'admin', avatar_path: null, auth_type: 'local' } });
    return route.fulfill({ json: { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [], preferences: [] } });
  });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/settings`);
  await expect.poll(() => firstStarted).toBe(true);
  await page.getByRole('main').getByRole('button', { name: 'Sign Out', exact: true }).click();
  account = 'second';
  await page.locator('input[type="email"]').fill('second@local');
  await page.locator('input[type="password"]').fill('MockPassword123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('tab', { name: 'Integrations', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Connect Last.fm account' })).toBeVisible();
  releaseFirst();
  await expect.poll(() => firstFinished).toBe(true);
  await page.waitForTimeout(250);
  await expect(page.getByText('first-lastfm', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect Last.fm account' })).toBeVisible();
});

test('late avatar removal cannot clear the next account avatar', async ({ page }) => {
  let account = 'first', loggedIn = true, removeStarted = false, removeFinished = false;
  let releaseRemove!: () => void;
  const heldRemove = new Promise<void>(resolve => { releaseRemove = resolve; });
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/logout')) loggedIn = false;
    if (path.endsWith('/auth/login')) loggedIn = true;
    if (path.endsWith('/auth/me')) return route.fulfill(loggedIn
      ? { json: { ok: true, user: { id: account, email: `${account}@local`, role: 'admin' } } }
      : { status: 401, json: { ok: false } });
    if (path.endsWith('/users/profile')) return route.fulfill({ json: { id: account, email: `${account}@local`, role: 'admin',
      avatar_path: `${account}-avatar`, auth_type: 'local', created_at: '2026-09-01T00:00:00Z' } });
    if (path.endsWith('/users/avatar') && route.request().method() === 'DELETE') {
      removeStarted = true;
      await heldRemove;
      await route.fulfill({ json: { ok: true, avatar_path: null } });
      removeFinished = true;
      return;
    }
    return route.fulfill({ json: { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [], preferences: [] } });
  });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/settings`);
  await expect(page.getByRole('button', { name: 'Remove', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect.poll(() => removeStarted).toBe(true);
  await page.getByRole('main').getByRole('button', { name: 'Sign Out', exact: true }).click();
  account = 'second';
  await page.locator('input[type="email"]').fill('second@local');
  await page.locator('input[type="password"]').fill('MockPassword123!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const secondAvatars = page.locator('img[src="/api/avatars/second-avatar"]');
  await expect.poll(() => secondAvatars.count()).toBeGreaterThan(1);
  const before = await secondAvatars.count();
  releaseRemove();
  await expect.poll(() => removeFinished).toBe(true);
  await page.waitForTimeout(250);
  await expect(secondAvatars).toHaveCount(before);
});
