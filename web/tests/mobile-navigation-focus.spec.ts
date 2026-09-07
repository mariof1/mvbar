import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
    ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
    : { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
  await page.goto('http://localhost:8080/#/favorites');
  await page.getByRole('button', { name: 'Open menu', exact: true }).click();
});

test('mobile navigation traps keyboard focus and returns it on Escape', async ({ page }) => {
  const menu = page.getByRole('dialog', { name: 'Navigation menu' });
  const close = menu.getByRole('button', { name: 'Close menu' });
  const logout = menu.getByRole('button', { name: 'Sign Out' });
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(logout).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeFocused();
});

test('switching to desktop closes mobile navigation and releases scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe('hidden');
  await page.getByRole('complementary').getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/#\/settings$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('dialog', { name: 'Navigation menu' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open menu', exact: true })).toBeVisible();
});
