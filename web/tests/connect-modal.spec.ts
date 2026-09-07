import { test, expect } from '@playwright/test';

for (const width of [390, 820, 1280]) {
  const mobile = width < 1024;
  test(`Connect at ${width}px opens as a ${mobile ? 'mobile modal' : 'desktop popover'}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    await page.routeWebSocket('**/*', () => {});
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      return route.fulfill({ json: path.endsWith('/auth/me')
        ? { ok: true, user: { id: 'modal-test', email: 'test@local', role: 'admin' } }
        : { ok: true, items: [], tracks: [], playlists: [], devices: [], searches: [] } });
    });
    await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/playlists/smart`);
    const trigger = page.getByRole('button', { name: 'MVBar Connect players', exact: true }).filter({ visible: true }).first();
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'MVBar Connect', exact: true });
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('connect.png') });
    if (mobile) {
      await expect(dialog).toHaveAttribute('aria-modal', 'true');
      await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(16);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width - 16);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(844);
      await page.keyboard.press('Shift+Tab');
      expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
      await trigger.click();
      await page.mouse.click(4, 4);
      await expect(dialog).toHaveCount(0);
      await trigger.click();
    } else {
      await expect(dialog).not.toHaveAttribute('aria-modal', 'true');
      await expect(dialog).toHaveCSS('position', 'absolute');
    }
    await dialog.getByRole('button', { name: 'Close MVBar Connect' }).click();
    await expect(dialog).toHaveCount(0);
  });
}
