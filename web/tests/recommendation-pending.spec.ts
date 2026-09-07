import { test, expect } from '@playwright/test';
const base = process.env.MVBAR_TEST_URL || 'http://localhost:8080';
test.beforeEach(async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
    ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
    : { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
  await page.route('**/api/recommendations', route => route.fulfill({ json: { buckets: ['First', 'Second'].map(name => ({ key: name, name, count: 1, tracks: [{ id: 1, title: 'Song', artist: 'Audit' }], art_paths: [], art_hashes: [] })) } }));
});
test('hiding a mix blocks repeat submissions and permits retry after failure', async ({ page }) => {
  let posts = 0;
  await page.route('**/api/recommendations/feedback', async route => {
    posts++;
    await new Promise(resolve => setTimeout(resolve, 450));
    await route.fulfill(posts === 1 ? { status: 503, json: { error: 'Unavailable' } } : { json: { ok: true, hiddenMixCount: 1 } });
  });
  await page.goto(`${base}/#/for-you`);
  await page.getByRole('button', { name: 'Why First was recommended', exact: true }).click();
  await page.getByRole('button', { name: 'Hide this mix', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Could not save recommendation feedback', { exact: true })).toBeVisible();
  expect(posts).toBe(1);
  await page.getByRole('button', { name: 'Hide this mix', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Why First was recommended', exact: true })).toHaveCount(0);
  expect(posts).toBe(2);
});
test('finishing an old hide request does not dismiss a different mix dialog', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/recommendations/feedback', async route => { await held; await route.fulfill({ json: { ok: true, hiddenMixCount: 1 } }); });
  await page.goto(`${base}/#/for-you`);
  await page.getByRole('button', { name: 'Why First was recommended', exact: true }).click();
  await page.getByRole('button', { name: 'Hide this mix', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Why Second was recommended', exact: true }).click();
  release();
  await expect(page.getByRole('button', { name: 'Why First was recommended', exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Second', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide this mix', exact: true })).toBeEnabled();
});
