import { test, expect } from '@playwright/test';

for (const mode of ['available', 'denied', 'missing']) {
  test(`device log endpoint copy handles ${mode} clipboard access`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); console.log('Browser error:', error.message); });
    await page.addInitScript(mode => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'missing' ? undefined : {
        writeText: async (value: string) => {
          if (mode === 'denied') throw new Error('Clipboard blocked');
          (window as any).__copiedEndpoint = value;
        },
      } });
    }, mode);
    await page.routeWebSocket('**/*', () => {});
    await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, status: 'idle', items: [], activity: [], libraries: [], users: [], logs: [], tracks: [], playlists: [], podcasts: [], devices: [], searches: [], plugins: [] }
    }));
    await page.goto('http://localhost:8080/#/admin');
    await page.getByRole('tab', { name: 'Device Logs', exact: true }).click();
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    if (mode === 'available') {
      await expect.poll(() => page.evaluate(() => (window as any).__copiedEndpoint)).toBe('http://localhost:8080/api/logs/upload');
      await expect(page.getByText('Upload endpoint copied.', { exact: true })).toBeVisible();
    } else {
      const address = page.getByRole('textbox', { name: 'Android log upload endpoint', exact: true });
      await expect(address).toBeFocused();
      expect(await address.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!))).toBe('http://localhost:8080/api/logs/upload');
      await expect(page.getByText('Could not copy automatically. The address is selected so you can copy it manually.', { exact: true })).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
}
