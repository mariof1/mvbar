import { test, expect } from '@playwright/test';

for (const value of [0, null, 120]) {
  test(`editing a smart playlist preserves numeric filters set to ${value}`, async ({ page }) => {
    await page.routeWebSocket('**/*', () => {});
    await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, items: [], tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
    }));
    await page.route('**/api/smart-playlists', route => route.fulfill({ json: { ok: true, items: [{ id: 1, name: 'Roundtrip', sort: 'random', filters: { favoriteOnly: false, include: {}, exclude: {}, duration: { min: value, max: value }, bpm: { min: value, max: value } } }] } }));
    let saved: any = null;
    await page.route('**/api/smart-playlists/1', route => {
      saved = route.request().postDataJSON();
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto('http://localhost:8080/#/playlists/smart');
    await page.getByTitle('Edit', { exact: true }).click();
    for (const label of ['Min Duration (sec)', 'Max Duration (sec)', 'Min BPM', 'Max BPM']) {
      await expect(page.getByLabel(label, { exact: true })).toHaveValue(value === null ? '' : String(value));
    }
    await page.getByRole('button', { name: 'Save Changes', exact: true }).click();
    await expect.poll(() => saved).not.toBeNull();
    expect(saved.filters.duration).toEqual({ min: value, max: value });
    expect(saved.filters.bpm).toEqual({ min: value, max: value });
  });
}
