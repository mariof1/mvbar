import { test, expect } from '@playwright/test';
const base = process.env.MVBAR_TEST_URL || 'http://localhost:8080';
test('share target failure clears cached recipients and retry distinguishes empty results', async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
    ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
    : { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
  await page.route('**/api/favorites?*', route => route.fulfill({ json: { tracks: [{ id: 1, title: 'Audit song', artist: 'Audit' }] } }));
  let mode = 'friends';
  await page.route('**/api/social/share-targets/*', route => route.fulfill(mode === 'error' ? { status: 503, json: { error: 'Unavailable' } } : { json: { friends: mode === 'friends' ? [{ id: 'friend', email: 'friend@local', canAccess: true }] : [] } }));
  await page.goto(`${base}/#/favorites`);
  const open = async () => {
    await page.getByRole('button', { name: 'Add to...', exact: true }).click();
    await page.getByRole('button', { name: 'Share with a friend', exact: true }).click();
  };
  await open();
  await expect(page.getByText('friend@local', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  mode = 'error';
  await open();
  await expect(page.getByText('Could not load your friends.', { exact: true })).toBeVisible();
  await expect(page.getByText('friend@local', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Add a friend first', { exact: true })).toHaveCount(0);
  mode = 'friends';
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('friend@local', { exact: true })).toBeVisible();
  await expect(page.getByText('Could not load your friends.', { exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  mode = 'empty';
  await open();
  await expect(page.getByText('Add a friend first', { exact: true })).toBeVisible();
  await expect(page.getByText('friend@local', { exact: true })).toHaveCount(0);
});
