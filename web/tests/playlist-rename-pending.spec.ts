import { test, expect } from '@playwright/test';
const base = process.env.MVBAR_TEST_URL || 'http://localhost:8080';
test('playlist rename submits once, preserves failed draft, and clears error on retry', async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
    ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
    : { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
  let name = 'Original', patches = 0;
  await page.route('**/api/playlists', route => route.fulfill({ json: { playlists: [{ id: '1', name, is_owner: true, item_count: 1 }] } }));
  await page.route('**/api/playlists/1', async route => {
    expect(route.request().method()).toBe('PATCH');
    patches++;
    await new Promise(resolve => setTimeout(resolve, 450));
    if (patches === 1) return route.fulfill({ status: 503, json: { error: 'Rename unavailable' } });
    name = route.request().postDataJSON().name;
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto(`${base}/#/playlists/regular`);
  await page.getByTitle('Rename playlist', { exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Rename Original', exact: true });
  await input.fill('Changed');
  await input.press('Enter');
  await expect(input).toBeDisabled();
  await page.getByPlaceholder('New playlist name...').click();
  await expect(page.getByText('Rename unavailable', { exact: true })).toBeVisible();
  expect(patches).toBe(1);
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('Changed');
  await input.press('Enter');
  await expect(page.getByText('Changed', { exact: true })).toBeVisible();
  await expect(page.getByText('Rename unavailable', { exact: true })).toHaveCount(0);
  expect(patches).toBe(2);
  await page.getByTitle('Rename playlist', { exact: true }).click();
  await page.getByRole('textbox', { name: 'Rename Changed', exact: true }).fill('Cancelled');
  await page.getByRole('textbox', { name: 'Rename Changed', exact: true }).press('Escape');
  await expect(page.getByText('Changed', { exact: true })).toBeVisible();
  expect(patches).toBe(2);
});
