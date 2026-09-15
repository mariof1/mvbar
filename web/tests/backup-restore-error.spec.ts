import { test, expect } from '@playwright/test';

test('a rejected restore stays in Admin and shows the server reason', async ({ page }) => {
  let restoreCalls = 0;
  const backup = { name: 'invalid.mvbar-backup', size: 4, createdAt: '2026-09-01T00:00:00Z', storedAt: '2026-09-01T00:00:00Z',
    includesCaches: false, cacheFiles: 0, cacheBytes: 0, appVersion: '2.6.0', commit: 'audit' };
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { ok: true, user: { id: 'backup-audit', email: 'backup@example.test', role: 'admin' } } });
    if (path === '/api/admin/backups') return route.fulfill({ json: { ok: true, creating: null, backups: [backup] } });
    if (path.endsWith('/restore')) {
      restoreCalls++;
      return route.fulfill({ status: 400, json: { ok: false, error: 'The archive does not contain an administrator' } });
    }
    return route.fulfill({ json: { ok: true, tracks: [], playlists: [], backups: [], items: [], devices: [], searches: [] } });
  });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/admin`);
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByText(backup.name, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Replace the MVBar database?' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore backup' }).click();
  await expect.poll(() => restoreCalls).toBe(1);
  await expect(page.getByText('The archive does not contain an administrator', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeEnabled();
  expect(new URL(page.url()).hash).toBe('#/admin');
});
