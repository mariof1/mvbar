import { test, expect } from '@playwright/test';

for (const height of [540, 720, 900]) {
  test(`desktop navigation remains reachable at ${height}px height`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height });
    await page.routeWebSocket('**/*', () => {});
    await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
    }));
    await page.goto('http://localhost:8080/#/favorites');
    const sidebar = page.getByRole('complementary');
    await expect(sidebar).toBeVisible();
    await sidebar.hover();
    await page.mouse.wheel(0, 1600);
    const logout = sidebar.getByRole('button', { name: 'Sign Out', exact: true });
    await expect(logout).toBeInViewport({ ratio: 1 });
    await logout.click({ trial: true });
    await sidebar.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/#\/settings$/);
    await sidebar.getByRole('button', { name: 'For You', exact: true }).focus();
    await expect(sidebar.getByRole('button', { name: 'For You', exact: true })).toBeInViewport({ ratio: 1 });
    const buttons = sidebar.getByRole('button');
    for (let i = 1; i < await buttons.count(); i++) await page.keyboard.press('Tab');
    await expect(logout).toBeFocused();
    await expect(logout).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
