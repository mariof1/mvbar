import { test, expect } from '@playwright/test';

test('a missing backup download reports an error without leaving Admin', async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  let downloads = 0;
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { ok: true, user: { id: 'backup-audit', email: 'backup@example.test', role: 'admin' } } });
    if (path === '/api/admin/backups') return route.fulfill({ json: { ok: true, creating: null,
      backups: [{ name: 'missing.mvbar-backup', size: 1234, createdAt: '2026-09-01T00:00:00Z', storedAt: '2026-09-01T00:00:00Z',
        includesCaches: false, cacheFiles: 0, cacheBytes: 0, appVersion: '2.6.0', commit: 'audit' }] } });
    if (path.endsWith('/download')) {
      downloads++;
      return route.fulfill({ status: 404, json: { ok: false, error: 'Backup not found' } });
    }
    return route.fulfill({ json: { ok: true, tracks: [], playlists: [], backups: [], items: [], devices: [], searches: [] } });
  });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/admin`);
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('missing.mvbar-backup', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  await expect.poll(() => downloads).toBeGreaterThan(0);
  await expect(page.getByText('Backup not found', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Backup and restore' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#/admin');
});

test('a valid backup still downloads as a streamed browser attachment', async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  const methods: string[] = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { ok: true, user: { id: 'backup-audit', email: 'backup@example.test', role: 'admin' } } });
    if (path === '/api/admin/backups') return route.fulfill({ json: { ok: true, creating: null,
      backups: [{ name: 'available.mvbar-backup', size: 4, createdAt: '2026-09-01T00:00:00Z', storedAt: '2026-09-01T00:00:00Z',
        includesCaches: false, cacheFiles: 0, cacheBytes: 0, appVersion: '2.6.0', commit: 'audit' }] } });
    if (path.endsWith('/download')) {
      methods.push(route.request().method());
      return route.fulfill({ status: 200, body: route.request().method() === 'HEAD' ? '' : 'test', headers: {
        'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="available.mvbar-backup"',
      } });
    }
    return route.fulfill({ json: { ok: true, tracks: [], playlists: [], backups: [], items: [], devices: [], searches: [] } });
  });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/admin`);
  await page.getByRole('tab', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('available.mvbar-backup', { exact: true })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('available.mvbar-backup');
  expect(methods).toEqual(['HEAD', 'GET']);
  expect(new URL(page.url()).hash).toBe('#/admin');
});
