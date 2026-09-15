import { test, expect } from '@playwright/test';

test('a failed backup list shows a retry state and recovers after refresh', async ({ page }) => {
  let reads = 0;
  const backup = { name: 'available.mvbar-backup', size: 4, createdAt: '2026-09-01T00:00:00Z', storedAt: '2026-09-01T00:00:00Z',
    includesCaches: false, cacheFiles: 0, cacheBytes: 0, appVersion: '2.6.0', commit: 'audit' };
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { ok: true, user: { id: 'backup-audit', email: 'backup@example.test', role: 'admin' } } });
    if (path === '/api/admin/backups') {
      reads++;
      if (reads === 1) return route.fulfill({ status: 503, json: { ok: false, error: 'Backup storage temporarily unavailable' } });
      return route.fulfill({ json: { ok: true, creating: null, backups: [backup] } });
    }
    return route.fulfill({ json: { ok: true, tracks: [], playlists: [], backups: [], items: [], devices: [], searches: [] } });
  });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/admin`);
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('Could not load backups: Backup storage temporarily unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('No server backups yet.', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click();
  await expect(page.getByText(backup.name, { exact: true })).toBeVisible();
  await expect(page.getByText('Could not load backups: Backup storage temporarily unavailable', { exact: true })).toBeHidden();
});
