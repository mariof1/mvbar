import { test, expect } from '@playwright/test';

for (const initialFailure of [true, false]) {
  test(`device logs recover from a failed ${initialFailure ? 'initial load' : 'refresh'}`, async ({ page }) => {
    await page.routeWebSocket('**/*', () => {});
    await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, status: 'idle', activity: [], libraries: [], items: [], tracks: [], playlists: [], devices: [], searches: [] }
    }));
    let fail = initialFailure;
    await page.route('**/api/admin/device-logs', route => route.fulfill(fail
      ? { status: 503, json: { error: 'Unavailable' } }
      : { json: { ok: true, logs: [{ name: 'audit.log', device: 'Audit device', createdAt: '2026-09-07', size: 20 }] } }
    ));
    await page.goto('http://localhost:8080/#/admin');
    await page.getByRole('tab', { name: 'Device Logs', exact: true }).click();
    if (!initialFailure) {
      await expect(page.getByRole('button', { name: 'View log audit.log', exact: true })).toBeVisible();
      fail = true;
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    }
    await expect(page.getByRole('alert').filter({ hasText: 'Could not load device logs. Please try again.' })).toBeVisible();
    await expect(page.getByText('No device logs', { exact: true })).toHaveCount(0);
    if (!initialFailure) await expect(page.getByRole('button', { name: 'View log audit.log', exact: true })).toBeVisible();
    fail = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('button', { name: 'View log audit.log', exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Could not load device logs' })).toHaveCount(0);
  });
}
