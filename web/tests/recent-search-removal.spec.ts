import { test, expect } from '@playwright/test';

const searches = ['First', 'Second'].map((title, i) => ({ itemType: 'track', itemKey: String(i + 1), title, subtitle: 'Audit', imageUrl: null, payload: { id: i + 1 }, accessedAt: '2026-09-07T10:00:00Z' }));
test.beforeEach(async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
    ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
    : { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
});

for (const clearAll of [false, true]) {
  test(`late ${clearAll ? 'clear' : 'remove'} failure leaves a reopened search intact`, async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started = false, finished = false;
    await page.route('**/api/search/recent**', async route => {
      if (route.request().method() !== 'DELETE') return route.fulfill({ json: { searches: started ? [searches[1]] : searches } });
      started = true;
      await held;
      await route.fulfill({ status: 503, json: { error: 'Unavailable' } });
      finished = true;
    });
    await page.goto('http://localhost:8080/#/favorites');
    await page.keyboard.press('Control+k');
    await page.getByRole('button', { name: clearAll ? 'Clear all' : 'Remove First from recent searches', exact: true }).click();
    await expect.poll(() => started).toBe(true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('button', { name: 'Remove Second from recent searches' })).toBeVisible();
    release();
    await expect.poll(() => finished).toBe(true);
    await page.waitForTimeout(250);
    await expect(page.getByRole('button', { name: 'Remove Second from recent searches' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove First from recent searches' })).toHaveCount(0);
    await expect(page.getByText(/Could not (remove|clear)/)).toHaveCount(0);
  });
}

test('recent removals serialize and failed removals remain retryable', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let deletes = 0;
  await page.route('**/api/search/recent**', async route => {
    if (route.request().method() !== 'DELETE') return route.fulfill({ json: { searches } });
    deletes++;
    if (deletes === 1) {
      await held;
      return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('http://localhost:8080/#/favorites');
  await page.keyboard.press('Control+k');
  const first = page.getByRole('button', { name: 'Remove First from recent searches' });
  await first.click();
  await expect.poll(() => deletes).toBe(1);
  await expect(page.getByRole('button', { name: 'Remove Second from recent searches' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Clear all', exact: true })).toBeDisabled();
  release();
  await expect(page.getByText('Could not remove that recent search.', { exact: true })).toBeVisible();
  await expect(first).toBeEnabled();
  await first.click();
  await expect.poll(() => deletes).toBe(2);
  await expect(first).toHaveCount(0);
  await expect(page.getByText('Could not remove that recent search.', { exact: true })).toHaveCount(0);
});
