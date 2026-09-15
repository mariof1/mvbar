import { test, expect } from '@playwright/test';

test('a background backup failure is reported even without WebSocket events', async ({ page }) => {
  const job = { id: 'failed-job', startedAt: '2026-09-01T00:00:00Z', includeCaches: false };
  let started = false;
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { ok: true, user: { id: 'backup-audit', email: 'backup@example.test', role: 'admin' } } });
    if (path === '/api/admin/backups' && route.request().method() === 'POST') {
      started = true;
      return route.fulfill({ status: 202, json: { ok: true, job } });
    }
    if (path === '/api/admin/backups') return route.fulfill({ json: {
      ok: true, creating: null, backups: [],
      lastFinished: started ? { jobId: job.id, status: 'failed', error: 'Archive writing failed' } : null,
    } });
    return route.fulfill({ json: { ok: true, tracks: [], playlists: [], backups: [], items: [], devices: [], searches: [] } });
  });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/admin`);
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Create backup' }).click();
  await expect(page.getByRole('button', { name: 'Backup running on server…' })).toBeVisible();
  await expect(page.getByText('Archive writing failed', { exact: true })).toBeVisible({ timeout: 7000 });
  await expect(page.getByRole('button', { name: 'Create backup' })).toBeEnabled();
});

test('a completed backup clears its spinner and lists the archive without WebSocket events', async ({ page }) => {
  const job = { id: 'created-job', startedAt: '2026-09-01T00:00:00Z', includeCaches: false };
  const backup = { name: 'created.mvbar-backup', size: 4, createdAt: '2026-09-01T00:00:01Z', storedAt: '2026-09-01T00:00:01Z',
    includesCaches: false, cacheFiles: 0, cacheBytes: 0, appVersion: '2.6.0', commit: 'audit' };
  let started = false;
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { ok: true, user: { id: 'backup-audit', email: 'backup@example.test', role: 'admin' } } });
    if (path === '/api/admin/backups' && route.request().method() === 'POST') {
      started = true;
      return route.fulfill({ status: 202, json: { ok: true, job } });
    }
    if (path === '/api/admin/backups') return route.fulfill({ json: {
      ok: true, creating: null, backups: started ? [backup] : [],
      lastFinished: started ? { jobId: job.id, status: 'created' } : null,
    } });
    return route.fulfill({ json: { ok: true, tracks: [], playlists: [], backups: [], items: [], devices: [], searches: [] } });
  });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/admin`);
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Create backup' }).click();
  await expect(page.getByRole('button', { name: 'Backup running on server…' })).toBeVisible();
  await expect(page.getByText(backup.name, { exact: true })).toBeVisible({ timeout: 7000 });
  await expect(page.getByRole('button', { name: 'Create backup' })).toBeEnabled({ timeout: 7000 });
  await expect(page.getByText('Backup creation failed', { exact: true })).toBeHidden();
});
