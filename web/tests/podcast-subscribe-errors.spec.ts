import { test, expect } from '@playwright/test';

test('an invalid RSS feed reports the server reason in the subscribe modal', async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { ok: true, user: { id: 'podcast-audit', email: 'podcast@example.test', role: 'user' } } });
    if (path === '/api/podcasts/subscribe' && route.request().method() === 'POST') {
      return route.fulfill({ status: 400, json: { ok: false, error: 'This URL does not contain a podcast RSS feed' } });
    }
    if (path.endsWith('/podcasts/episodes/new')) return route.fulfill({ json: { ok: true, episodes: [] } });
    if (path === '/api/podcasts') return route.fulfill({ json: { ok: true, podcasts: [] } });
    return route.fulfill({ json: { ok: true, tracks: [], playlists: [], backups: [], items: [], devices: [], searches: [] } });
  });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/podcasts/subscriptions`);
  await page.getByRole('button', { name: 'Add show' }).click();
  await page.getByRole('button', { name: 'RSS URL' }).click();
  await page.getByRole('textbox', { name: 'Podcast RSS feed URL' }).fill('https://example.invalid/feed');
  await page.getByRole('button', { name: 'Subscribe', exact: true }).click();
  await expect(page.getByText('This URL does not contain a podcast RSS feed', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Podcast RSS feed URL' })).toBeVisible();
});

test('a podcast directory error does not claim there are no matching shows', async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { ok: true, user: { id: 'podcast-audit', email: 'podcast@example.test', role: 'user' } } });
    if (path === '/api/podcasts/search') return route.fulfill({ status: 503, json: { ok: false, error: 'Podcast directory temporarily unavailable' } });
    if (path.endsWith('/podcasts/episodes/new')) return route.fulfill({ json: { ok: true, episodes: [] } });
    if (path === '/api/podcasts') return route.fulfill({ json: { ok: true, podcasts: [] } });
    return route.fulfill({ json: { ok: true, tracks: [], playlists: [], backups: [], items: [], devices: [], searches: [] } });
  });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/podcasts/subscriptions`);
  await page.getByRole('button', { name: 'Add show' }).click();
  await page.getByRole('textbox', { name: 'Search for podcasts' }).fill('fixture');
  await page.getByRole('textbox', { name: 'Search for podcasts' }).press('Enter');
  await expect(page.getByText('Podcast directory temporarily unavailable', { exact: true })).toBeVisible();
  await expect(page.getByText('No podcasts found. Try a different search term.', { exact: true })).toBeHidden();
});

test('subscribing to a search result shows the feed validation error', async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) return route.fulfill({ json: { ok: true, user: { id: 'podcast-audit', email: 'podcast@example.test', role: 'user' } } });
    if (path === '/api/podcasts/search') return route.fulfill({ json: { ok: true, results: [{ id: 5, title: 'Fixture show',
      author: 'Fixture publisher', feedUrl: 'https://example.invalid/feed', imageUrl: null, genre: 'Music', episodeCount: 2 }] } });
    if (path === '/api/podcasts/subscribe' && route.request().method() === 'POST') {
      return route.fulfill({ status: 422, json: { ok: false, error: 'This show has no playable episodes' } });
    }
    if (path.endsWith('/podcasts/episodes/new')) return route.fulfill({ json: { ok: true, episodes: [] } });
    if (path === '/api/podcasts') return route.fulfill({ json: { ok: true, podcasts: [] } });
    return route.fulfill({ json: { ok: true, tracks: [], playlists: [], backups: [], items: [], devices: [], searches: [] } });
  });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/podcasts/subscriptions`);
  await page.getByRole('button', { name: 'Add show' }).click();
  await page.getByRole('textbox', { name: 'Search for podcasts' }).fill('fixture');
  await page.getByRole('textbox', { name: 'Search for podcasts' }).press('Enter');
  await expect(page.getByText('Fixture show', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Subscribe', exact: true }).click();
  await expect(page.getByText('This show has no playable episodes', { exact: true })).toBeVisible();
  await expect(page.getByText('Fixture show', { exact: true })).toBeVisible();
});
