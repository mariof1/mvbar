import { test, expect } from '@playwright/test';

test('changing the query removes the previous song while the new search is pending', async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  let betaStarted = false;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/me')) return route.fulfill({ json: { ok: true, user: { id: 'search-audit', email: 'search@example.test', role: 'user' } } });
    if (url.pathname === '/api/search') {
      const beta = url.searchParams.get('q') === 'beta';
      if (beta && url.searchParams.has('quick')) {
        betaStarted = true;
        await new Promise(resolve => setTimeout(resolve, 450));
      }
      const title = beta ? 'Beta song' : 'Alpha song';
      return route.fulfill({ json: { ok: true, hits: [{ id: beta ? 2 : 1, title, artist: 'Test Artist', path: title, ext: 'mp3' }],
        artists: [], albums: [], playlists: [], podcasts: [], podcastEpisodes: [], audiobooks: [] } });
    }
    return route.fulfill({ json: { ok: true, tracks: [], playlists: [], devices: [], searches: [] } });
  });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/for-you`);
  await page.getByRole('button', { name: /^Search/ }).filter({ visible: true }).first().click();
  const search = page.getByRole('textbox', { name: 'Search library', exact: true });
  await search.fill('alpha');
  await expect(page.getByText('Alpha song', { exact: true })).toBeVisible();
  await search.fill('beta');
  await expect.poll(() => betaStarted).toBe(true);
  expect(await page.getByText('Alpha song', { exact: true }).isVisible()).toBe(false);
  await expect(page.getByText('Beta song', { exact: true })).toBeVisible();
});
