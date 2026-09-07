import { test, expect } from '@playwright/test';
for (const success of [true, false]) {
  test(`old share ${success ? 'success' : 'failure'} does not change a reopened dialog`, async ({ page }) => {
    await page.routeWebSocket('**/*', () => {});
    await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, incoming: [], tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
    }));
    await page.route('**/api/favorites?*', route => route.fulfill({ json: { tracks: [{ id: 1, title: 'Audit song', artist: 'Audit' }] } }));
    await page.route('**/api/social/share-targets/*', route => route.fulfill({ json: { friends: [{ id: 'friend', email: 'friend@local', canAccess: true }] } }));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started = false, finished = false;
    await page.route('**/api/social/shares', async route => {
      started = true;
      await held;
      await route.fulfill(success ? { json: { ok: true, shared: 1 } } : { status: 503, json: { error: 'Unavailable' } });
      finished = true;
    });
    await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/favorites`);
    const open = async () => {
      await page.getByRole('button', { name: 'Add to...', exact: true }).click();
      await page.getByRole('button', { name: 'Share with a friend', exact: true }).click();
      await page.getByRole('button', { name: /friend@local/ }).click();
    };
    await open();
    await page.getByRole('button', { name: 'Share (1)', exact: true }).click();
    await expect.poll(() => started).toBe(true);
    await page.keyboard.press('Escape');
    await open();
    const message = page.getByRole('dialog').getByRole('textbox');
    await message.fill('New draft');
    await expect(page.getByRole('button', { name: 'Share (1)', exact: true })).toBeEnabled();
    release();
    await expect.poll(() => finished).toBe(true);
    await page.waitForTimeout(250);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(message).toHaveValue('New draft');
    await expect(page.getByText('Could not share this song. Please try again.', { exact: true })).toHaveCount(0);
  });
}
