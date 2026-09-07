import { test, expect } from '@playwright/test';

for (const fail of [false, true]) {
  test(`a delayed log ${fail ? 'failure' : 'response'} cannot replace the selected log`, async ({ page }) => {
    await page.routeWebSocket('**/*', () => {});
    await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, status: 'idle', activity: [], libraries: [], items: [], logs: [], tracks: [], playlists: [], devices: [], searches: [] }
    }));
    await page.route('**/api/admin/device-logs', route => route.fulfill({ json: { ok: true, logs: [1, 2].map(id => ({ name: `${id}.log`, device: `Device ${id}`, createdAt: '2026-09-07', size: 10, appVersion: null })) } }));
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started = false, finished = false;
    await page.route('**/api/admin/device-logs/*', async route => {
      const old = route.request().url().endsWith('/1.log');
      if (old) { started = true; await held; }
      await route.fulfill(old && fail ? { status: 503, json: { error: 'Unavailable' } } : { json: { ok: true, content: old ? 'Old log contents' : 'Current log contents' } });
      if (old) finished = true;
    });
    await page.goto('http://localhost:8080/#/admin');
    await page.getByRole('tab', { name: 'Device Logs', exact: true }).click();
    await page.getByText('Device 1', { exact: true }).click();
    await expect.poll(() => started).toBe(true);
    await page.getByText('Device 2', { exact: true }).click();
    await expect(page.locator('pre')).toHaveText('Current log contents');
    release();
    await expect.poll(() => finished).toBe(true);
    await page.waitForTimeout(250);
    await expect(page.locator('pre')).toHaveText('Current log contents');
    await page.getByRole('button', { name: 'Close log viewer', exact: true }).click();
    const view = page.getByRole('button', { name: 'View log 2.log', exact: true });
    await view.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('pre')).toHaveText('Current log contents');
  });
}
