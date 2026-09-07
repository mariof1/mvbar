import { test, expect } from '@playwright/test';

for (const fail of [false, true]) {
  test(`sign-out clears the push-enabled flag when server cleanup ${fail ? 'fails' : 'succeeds'}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => {
      let subscription: any = {
        endpoint: 'https://push.invalid/audit', expirationTime: null,
        toJSON: () => ({ keys: { p256dh: 'mock', auth: 'mock' } }),
        unsubscribe: async () => { subscription = null; return true; },
      };
      Object.defineProperty(navigator, 'serviceWorker', { value: { register: async () => ({ pushManager: { getSubscription: async () => subscription } }) } });
      if (!('PushManager' in window)) Object.defineProperty(window, 'PushManager', { value: class {} });
    });
    await page.routeWebSocket('**/*', () => {});
    let loggedIn = true, deletes = 0;
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/auth/logout')) loggedIn = false;
      if (path.endsWith('/auth/me')) return route.fulfill(loggedIn
        ? { json: { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } } }
        : { status: 401, json: { ok: false } });
      if (path.endsWith('/push/subscriptions') && route.request().method() === 'DELETE') {
        deletes++;
        return route.fulfill(fail ? { status: 503, json: { error: 'Unavailable' } } : { json: { ok: true } });
      }
      return route.fulfill({ json: { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [] } });
    });
    await page.goto('http://localhost:8080/#/favorites');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('mvbar_web_push_enabled'))).toBe('true');
    await page.getByRole('complementary').getByRole('button', { name: 'Sign Out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect(deletes).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('mvbar_web_push_enabled'))).toBeNull();
  });
}
