import { test, expect } from '@playwright/test';

for (const all of [false, true]) {
  test(`failed deletion of ${all ? 'all logs' : 'one log'} stays retryable without browser exceptions`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.routeWebSocket('**/*', () => {});
    await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, status: 'idle', activity: [], libraries: [], items: [], tracks: [], playlists: [], devices: [], searches: [] }
    }));
    let logs = [1, 2].map(id => ({ name: `${id}.log`, device: `Device ${id}`, createdAt: '2026-09-07', size: 10, appVersion: null }));
    let deletes = 0;
    await page.route('**/api/admin/device-logs**', route => {
      if (route.request().method() === 'DELETE') {
        if (++deletes === 1) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
        logs = all ? [] : logs.slice(1);
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: { ok: true, logs, content: 'Selected log contents' } });
    });
    await page.goto('http://localhost:8080/#/admin');
    await page.getByRole('tab', { name: 'Device Logs', exact: true }).click();
    await page.getByRole('button', { name: 'View log 1.log', exact: true }).click();
    await expect(page.locator('pre')).toHaveText('Selected log contents');
    const remove = async () => {
      if (all) await page.getByRole('button', { name: 'Delete All', exact: true }).click();
      else await page.getByRole('button', { name: 'View log 1.log', exact: true }).locator('..').getByRole('button').last().click();
      await page.getByRole('dialog').getByRole('button', { name: all ? 'Delete All' : 'Delete', exact: true }).click();
    };
    await remove();
    await expect(page.getByRole('alert').filter({ hasText: 'Could not delete device logs. Please try again.' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^View log/ })).toHaveCount(2);
    await expect(page.locator('pre')).toHaveText('Selected log contents');
    await remove();
    await expect(page.getByRole('button', { name: /^View log/ })).toHaveCount(all ? 0 : 1);
    await expect(page.locator('pre')).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: 'Could not delete device logs' })).toHaveCount(0);
    expect(deletes).toBe(2);
    expect(errors).toEqual([]);
  });
}

test('a pending deletion does not close a different log selected meanwhile', async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
    ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
    : { ok: true, status: 'idle', activity: [], libraries: [], items: [], tracks: [], playlists: [], devices: [], searches: [] }
  }));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  await page.route('**/api/admin/device-logs**', async route => {
    if (route.request().method() === 'DELETE') {
      started = true;
      await held;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { ok: true, logs: [1, 2].map(id => ({ name: `${id}.log`, device: `Device ${id}`, createdAt: '2026-09-07', size: 10 })), content: route.request().url().endsWith('2.log') ? 'Second contents' : 'First contents' } });
  });
  await page.goto('http://localhost:8080/#/admin');
  await page.getByRole('tab', { name: 'Device Logs', exact: true }).click();
  await page.getByRole('button', { name: 'View log 1.log', exact: true }).click();
  await page.getByRole('button', { name: 'Delete log 1.log', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await expect(page.getByRole('button', { name: 'Delete log 2.log', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'View log 2.log', exact: true }).click();
  await expect(page.locator('pre')).toHaveText('Second contents');
  release();
  await expect(page.getByRole('button', { name: 'View log 1.log', exact: true })).toHaveCount(0);
  await expect(page.locator('pre')).toHaveText('Second contents');
});
