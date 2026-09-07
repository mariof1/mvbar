import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
    ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
    : { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
  await page.route('**/api/social/summary', route => route.fulfill({ json: { unreadShares: 0, incoming: [], outgoing: [], friends: [] } }));
  await page.route('**/api/social/shares?*', route => route.fulfill({ json: { shares: [], total: 0 } }));
});

for (const failure of [false, true]) {
  test(`changing friend search ignores an old ${failure ? 'failure' : 'result'}`, async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started = false, finished = false;
    await page.route('**/api/social/users?*', async route => {
      const old = new URL(route.request().url()).searchParams.get('q') === 'old';
      if (old) { started = true; await held; }
      await route.fulfill(old && failure ? { status: 503, json: { error: 'Unavailable' } } : { json: { users: [{ id: old ? 'old' : 'new', email: old ? 'old@local' : 'new@local', avatarPath: null, relationship: 'friend' }] } });
      if (old) finished = true;
    });
    await page.goto('http://localhost:8080/#/social/friends');
    const input = page.getByLabel('Friend email address');
    await input.fill('old');
    await input.press('Enter');
    await expect.poll(() => started).toBe(true);
    await input.fill('new');
    await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeEnabled();
    await input.press('Enter');
    await expect(page.getByText('new@local', { exact: true })).toBeVisible();
    release();
    await expect.poll(() => finished).toBe(true);
    await page.waitForTimeout(250);
    await expect(page.getByText('new@local', { exact: true })).toBeVisible();
    await expect(page.getByText('old@local', { exact: true })).toHaveCount(0);
    await expect(page.getByText(/Could not search users/)).toHaveCount(0);
    await input.fill('');
    await expect(page.getByText('new@local', { exact: true })).toHaveCount(0);
  });
}

test('failed friend search shows a retryable error instead of no matching users', async ({ page }) => {
  let fail = true;
  await page.route('**/api/social/users?*', route => route.fulfill(fail ? { status: 503, json: { error: 'Unavailable' } } : { json: { users: [] } }));
  await page.goto('http://localhost:8080/#/social/friends');
  const input = page.getByLabel('Friend email address');
  await input.fill('friend');
  await input.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'Could not search users' })).toBeVisible();
  await expect(page.getByText('No approved user found.', { exact: true })).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('No approved user found.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Could not search users' })).toHaveCount(0);
});
