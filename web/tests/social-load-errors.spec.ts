import { test, expect } from '@playwright/test';

for (const tab of ['shares', 'friends']) {
  for (const endpoint of ['summary', 'shares']) {
    test(`${tab} recovers from a failed ${endpoint} load without showing false empty content`, async ({ page }) => {
      await page.routeWebSocket('**/*', () => {});
      await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
        ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
        : { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
      }));
      let retrying = false, started = false;
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      await page.route('**/api/social/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith(`/${endpoint}`)) {
          if (!retrying) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
          started = true;
          await held;
        }
        return route.fulfill({ json: path.endsWith('/summary')
          ? { unreadShares: 0, incoming: [], outgoing: [], friends: [] }
          : { shares: [], total: 0, unread: 0 }
        });
      });
      await page.goto(`http://localhost:8080/#/social/${tab}`);
      await expect(page.getByRole('alert').filter({ hasText: 'Could not load friends and shares' })).toBeVisible();
      await expect(page.getByText('No songs shared with you yet', { exact: true })).toHaveCount(0);
      await expect(page.getByText('You haven’t added any friends yet.', { exact: true })).toHaveCount(0);
      retrying = true;
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
      await expect.poll(() => started).toBe(true);
      await expect(page.getByRole('button', { name: 'Retrying…', exact: true })).toBeDisabled();
      release();
      await expect(page.getByRole('alert').filter({ hasText: 'Could not load friends and shares' })).toHaveCount(0);
      await expect(page.getByText(tab === 'shares' ? 'No songs shared with you yet' : 'You haven’t added any friends yet.', { exact: true })).toBeVisible();
    });
  }
}

test('a failed live refresh keeps the known friend list visible', async ({ page }) => {
  let emit!: () => void;
  await page.routeWebSocket('**/*', socket => { emit = () => socket.send(JSON.stringify({ type: 'social:friend_removed', data: { userId: 'other' } })); });
  await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
    ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
    : { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
  }));
  let fail = false;
  await page.route('**/api/social/**', route => {
    if (fail) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
    return route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/summary')
      ? { unreadShares: 0, incoming: [], outgoing: [], friends: [{ relationshipId: 1, createdAt: '2026-09-07T10:00:00Z', user: { id: 'friend', email: 'friend@local', avatarPath: null } }] }
      : { shares: [], total: 0, unread: 0 }
    });
  });
  await page.goto('http://localhost:8080/#/social/friends');
  await expect(page.getByText('friend@local', { exact: true })).toBeVisible();
  await expect.poll(() => typeof emit).toBe('function');
  fail = true;
  emit();
  await expect(page.getByRole('alert').filter({ hasText: 'Could not load friends and shares' })).toBeVisible();
  await expect(page.getByText('friend@local', { exact: true })).toBeVisible();
  fail = false;
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Could not load friends and shares' })).toHaveCount(0);
});
