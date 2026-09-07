import { test, expect } from '@playwright/test';

for (const oldResponse of ['expired', 'old account']) {
  test(`a delayed automatic login ${oldResponse} response cannot replace a completed login`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.routeWebSocket('**/*', () => {});
    await page.route('**/api/**', route => route.fulfill({ json: { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [] } }));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let reads = 0, finished = false;
    await page.route('**/api/auth/me', async route => {
      reads++;
      if (reads === 1) {
        await held;
        await route.fulfill(oldResponse === 'expired'
          ? { status: 401, json: { ok: false } }
          : { json: { ok: true, user: { id: 'old', email: 'old@local', role: 'admin' } } });
        finished = true;
      } else await route.fulfill({ json: { ok: true, user: { id: 'current', email: 'current@local', role: 'admin' } } });
    });
    await page.goto('http://localhost:8080/#/favorites');
    await expect.poll(() => reads).toBe(1);
    await page.getByLabel('Email', { exact: true }).fill('current@local');
    await page.getByLabel('Password', { exact: true }).fill('MockPassword123!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('complementary').getByText('current@local', { exact: true })).toBeVisible();
    release();
    await expect.poll(() => finished).toBe(true);
    await page.waitForTimeout(300);
    await expect(page.getByRole('complementary').getByText('current@local', { exact: true })).toBeVisible();
    await expect(page.getByText('old@local', { exact: true })).toHaveCount(0);
    expect(reads).toBe(2);
  });
}
