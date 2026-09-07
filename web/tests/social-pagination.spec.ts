import { test, expect } from '@playwright/test';

for (const retry of [false, true]) {
  test(`older shared songs remain accessible${retry ? ' after a failed page load' : ' after a live refresh'}`, async ({ page }) => {
    let emit!: () => void;
    await page.routeWebSocket('**/*', socket => { emit = () => socket.send(JSON.stringify({ type: 'social:shares_read_all', data: {} })); });
    await page.route('**/api/**', route => route.fulfill({ json: new URL(route.request().url()).pathname.endsWith('/auth/me')
      ? { ok: true, user: { id: 'audit', email: 'test@local', role: 'admin' } }
      : { ok: true, tracks: [], playlists: [], podcasts: [], devices: [], searches: [] }
    }));
    await page.route('**/api/social/summary', route => route.fulfill({ json: { unreadShares: 0, incoming: [], outgoing: [], friends: [] } }));
    let fail = retry;
    const requests: Array<{ limit: number; offset: number }> = [];
    const shares = Array.from({ length: 125 }, (_, index) => ({
      id: index + 1, track: { id: index + 1, title: `Shared song ${index + 1}`, artist: 'Audit', album: null, durationMs: 10000, artPath: null, artHash: null },
      sender: { id: 'friend', email: 'friend@local', avatarPath: null }, message: null, createdAt: '2026-09-07T10:00:00Z', readAt: '2026-09-07T10:00:00Z',
    }));
    await page.route('**/api/social/shares?*', route => {
      const params = new URL(route.request().url()).searchParams;
      const limit = Number(params.get('limit')), offset = Number(params.get('offset'));
      requests.push({ limit, offset });
      if (fail && (limit > 50 || offset > 0)) return route.fulfill({ status: 503, json: { error: 'Unavailable' } });
      return route.fulfill({ json: { shares: shares.slice(offset, offset + limit), total: shares.length, unread: 0, limit, offset } });
    });
    await page.goto('http://localhost:8080/#/social/shares');
    await expect(page.getByRole('article')).toHaveCount(50);
    await page.getByRole('button', { name: 'Load older songs', exact: true }).click();
    if (retry) {
      await expect(page.getByRole('alert').filter({ hasText: 'Could not load friends and shares' })).toBeVisible();
      await expect(page.getByRole('article')).toHaveCount(50);
      fail = false;
      await page.getByRole('button', { name: 'Retry', exact: true }).click();
    }
    await expect(page.getByRole('article')).toHaveCount(100);
    await page.getByRole('button', { name: 'Load older songs', exact: true }).click();
    await expect(page.getByRole('article')).toHaveCount(125);
    await expect(page.getByRole('heading', { name: 'Shared song 125', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Load older songs', exact: true })).toHaveCount(0);
    const previousRequests = requests.length;
    await expect.poll(() => typeof emit).toBe('function');
    emit();
    await expect.poll(() => requests.length).toBeGreaterThan(previousRequests);
    await expect.poll(() => requests.at(-1)?.offset).toBe(100);
    await expect(page.getByRole('article')).toHaveCount(125);
  });
}
