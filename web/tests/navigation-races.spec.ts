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

test('audiobook navigation ignores the previous detail response', async ({ page }) => {
  await page.route('**/api/audiobooks', route => route.fulfill({ json: [] }));
  let finishOld!: () => void;
  const oldFinished = new Promise<void>(resolve => { finishOld = resolve; });
  await page.route('**/api/audiobooks/*', async route => {
    const id = Number(new URL(route.request().url()).pathname.split('/').pop());
    await new Promise(resolve => setTimeout(resolve, id === 1 ? 1200 : 50));
    await route.fulfill({ json: { audiobook: { id, title: `Book ${id}`, author: 'Audit', duration_ms: 0 }, chapters: [], progress: null } });
    if (id === 1) finishOld();
  });
  const oldStarted = page.waitForRequest('**/api/audiobooks/1');
  await page.goto(`${base}/#/audiobook/1`);
  await oldStarted;
  await page.evaluate(() => { location.hash = '#/audiobook/2'; });
  await expect(page.getByRole('heading', { name: 'Book 2', exact: true })).toBeVisible();
  await oldFinished;
  await expect(page.getByRole('heading', { name: 'Book 2', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Book 1', exact: true })).toHaveCount(0);
});

test('search shortcut respects mobile Connect and works again after closing it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/#/playlists/smart`);
  await page.getByRole('button', { name: 'MVBar Connect players', exact: true }).filter({ visible: true }).first().click();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Search library', exact: true })).toHaveCount(0);
  const connect = page.getByRole('dialog', { name: 'MVBar Connect', exact: true });
  await expect(connect).toBeVisible();
  expect(await connect.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Search library', exact: true })).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
});

test('RSS subscription has independent loading state from search', async ({ page }) => {
  let finishSearch!: () => void;
  const searchFinished = new Promise<void>(resolve => { finishSearch = resolve; });
  await page.route('**/api/podcasts/search?*', async route => {
    await new Promise(resolve => setTimeout(resolve, 1200));
    await route.fulfill({ json: { results: [] } });
    finishSearch();
  });
  let releaseSubscription!: () => void;
  const pending = new Promise<void>(resolve => { releaseSubscription = resolve; });
  let posts = 0;
  await page.route('**/api/podcasts/subscribe', async route => {
    posts++;
    await pending;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`${base}/#/podcasts`);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Search for podcasts' });
  await input.fill('history');
  const started = page.waitForRequest('**/api/podcasts/search?*');
  await input.press('Enter');
  await started;
  await page.getByRole('button', { name: 'RSS URL', exact: true }).click();
  await page.getByRole('textbox', { name: 'Podcast RSS feed URL' }).fill('https://example.test/feed.xml');
  const subscribe = page.getByRole('button', { name: 'Subscribe', exact: true });
  await expect(subscribe).toBeEnabled();
  await subscribe.click();
  await searchFinished;
  await expect(page.getByRole('button', { name: 'Subscribing...', exact: true })).toBeDisabled();
  expect(posts).toBe(1);
  releaseSubscription();
  await expect(page.getByRole('dialog', { name: 'Add Podcast', exact: true })).toHaveCount(0);
});
