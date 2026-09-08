import { test, expect, Page } from '@playwright/test';

const song = { recordingId: '22222222-2222-4222-8222-222222222222', title: 'Missing Song', artist: 'Test Artist', album: null,
  musicBrainzArtistId: '11111111-1111-4111-8111-111111111111', musicBrainzReleaseGroupId: null, musicBrainzReleaseId: null, present: false, requested: false };

async function fixture(page: Page, enabled = true, fail = false) {
  const requests: any[] = [];
  let lookups = 0;
  await page.routeWebSocket('**/*', () => {});
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/me')) return route.fulfill({ json: { ok: true, user: { id: 'test', email: 'test@local', role: 'user' } } });
    if (url.pathname.endsWith('/missing-music/status')) return route.fulfill({ json: { ok: true, enabled } });
    if (url.pathname.endsWith('/songs/search')) {
      lookups++;
      if (fail) return route.fulfill({ status: 502, json: { ok: false } });
      const query = url.searchParams.get('q');
      if (query === 'older') await new Promise(resolve => setTimeout(resolve, 1600));
      return route.fulfill({ json: { ok: true, enabled, songs: [
        { ...song, title: query === 'newer' ? 'New result' : song.title },
        { ...song, recordingId: 'present', title: 'Existing Song', present: true },
        { ...song, recordingId: 'requested', title: 'Already Requested', requested: true },
      ] } });
    }
    if (url.pathname.endsWith('/missing-music/requests') && route.request().method() === 'POST') {
      requests.push(route.request().postDataJSON());
      return route.fulfill({ status: 201, json: { ok: true } });
    }
    if (url.pathname === '/api/search') return route.fulfill({ json: { ok: true, hits: [{ id: 9, title: 'Local song', artist: 'Local artist' }] } });
    return route.fulfill({ json: { ok: true, items: [], tracks: [], playlists: [], devices: [], searches: [] } });
  });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/for-you`);
  await page.getByRole('button', { name: /^Search/ }).filter({ visible: true }).first().click();
  return { input: page.getByRole('textbox', { name: 'Search library', exact: true }), requests, lookups: () => lookups };
}

test('song search offers track requests, labels present/requested songs, and fits mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  await state.input.fill('Missing Song');
  const section = page.getByRole('region', { name: 'Missing songs' });
  const request = section.getByRole('button', { name: 'Request Missing Song by Test Artist' });
  await expect(request).toBeVisible();
  await expect(section.getByText('In library', { exact: true })).toBeVisible();
  await expect(section.getByText('Requested', { exact: true })).toBeVisible();
  expect(await section.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await request.click();
  expect(state.requests).toHaveLength(1);
  expect(state.requests[0]).toMatchObject({ itemType: 'track', title: 'Missing Song', musicBrainzRecordingId: song.recordingId, musicBrainzReleaseGroupId: null });
  await expect(request).toHaveCount(0);
  await expect(section.getByText('Requested', { exact: true })).toHaveCount(2);
});

test('disabled plugin never performs an external song lookup', async ({ page }) => {
  const state = await fixture(page, false);
  await state.input.fill('Missing Song');
  await page.waitForTimeout(1200);
  expect(state.lookups()).toBe(0);
  await expect(page.getByRole('region', { name: 'Missing songs' })).toHaveCount(0);
  await expect(page.getByText('Local song', { exact: true })).toBeVisible();
});

test('catalog failure leaves local results available and provides retry', async ({ page }) => {
  const state = await fixture(page, true, true);
  await state.input.fill('Missing Song');
  await expect(page.getByText('Local song', { exact: true })).toBeVisible();
  const retry = page.getByRole('button', { name: 'Retry', exact: true });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect.poll(state.lookups).toBe(2);
});

test('changing the query discards an older catalog response', async ({ page }) => {
  const state = await fixture(page);
  await state.input.fill('older');
  await expect.poll(state.lookups).toBe(1);
  await state.input.fill('newer');
  await expect(page.getByRole('button', { name: 'Request New result by Test Artist' })).toBeVisible();
  await page.waitForTimeout(1600);
  await expect(page.getByRole('button', { name: 'Request Missing Song by Test Artist' })).toHaveCount(0);
});
