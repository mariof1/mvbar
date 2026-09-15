import { test, expect } from '@playwright/test';

test('a delayed initial backup list cannot hide a newly uploaded archive', async ({ page }) => {
  let reads = 0, firstFinished = false;
  let releaseFirst!: () => void;
  const heldFirst = new Promise<void>(resolve => { releaseFirst = resolve; });
  const backup = { name: 'new.mvbar-backup', size: 4, createdAt: '2026-09-01T00:00:00Z', storedAt: '2026-09-01T00:00:00Z',
    includesCaches: false, cacheFiles: 0, cacheBytes: 0, appVersion: '2.6.0', commit: 'audit' };
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { ok: true, user: { id: 'backup-audit', email: 'backup@example.test', role: 'admin' } } });
    if (path === '/api/admin/backups' && route.request().method() === 'GET') {
      const read = ++reads;
      if (read === 1) await heldFirst;
      await route.fulfill({ json: { ok: true, creating: null, backups: read === 1 ? [] : [backup] } });
      if (read === 1) firstFinished = true;
      return;
    }
    if (path.endsWith('/admin/backups/upload')) return route.fulfill({ status: 201, json: { ok: true, backup } });
    return route.fulfill({ json: { ok: true, tracks: [], playlists: [], backups: [], items: [], devices: [], searches: [] } });
  });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/admin`);
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect.poll(() => reads).toBe(1);
  await page.locator('input[type="file"][accept*="mvbar-backup"]').setInputFiles({ name: 'fixture.mvbar-backup', mimeType: 'application/zip', buffer: Buffer.from('test') });
  await page.getByRole('button', { name: 'Upload to server', exact: true }).click();
  await expect.poll(() => reads).toBe(2);
  releaseFirst();
  await expect.poll(() => firstFinished).toBe(true);
  await page.waitForTimeout(250);
  await expect(page.getByText(backup.name, { exact: true })).toBeVisible();
});
