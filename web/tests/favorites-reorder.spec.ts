import { test, expect, Page } from '@playwright/test';

async function fixture(page: Page, count = 6, fail = false) {
  let ids = Array.from({ length: count }, (_, i) => i + 1);
  const moves: { trackId: number; beforeTrackId: number | null }[] = [];
  const outgoing: any[] = [];
  await page.routeWebSocket('**/*', socket => socket.onMessage(message => {
    try { outgoing.push(JSON.parse(String(message))); } catch {}
  }));
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/me')) return route.fulfill({ json: { ok: true, user: { id: 'test', email: 'test@local', role: 'admin' } } });
    if (url.pathname.endsWith('/favorites/reorder')) {
      const move = route.request().postDataJSON();
      moves.push(move);
      if (fail) return route.fulfill({ status: 500, json: { ok: false } });
      ids = ids.filter(id => id !== move.trackId);
      ids.splice(move.beforeTrackId === null ? ids.length : ids.indexOf(move.beforeTrackId), 0, move.trackId);
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname.endsWith('/favorites')) {
      const offset = Number(url.searchParams.get('offset') || 0);
      const limit = Number(url.searchParams.get('limit') || 100);
      return route.fulfill({ json: { ok: true, tracks: ids.slice(offset, offset + limit).map(id => ({ id, title: `Track ${id}`, artist: 'Test artist' })) } });
    }
    return route.fulfill({ json: { ok: true, tracks: [], items: [], devices: [], playlists: [] } });
  });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/favorites`);
  await expect(page.locator('[data-favorite-id]')).toHaveCount(Math.min(count, 200));
  await expect(page.getByRole('button', { name: 'Reorder Track 1', exact: true })).toBeEnabled();
  return { moves, outgoing, ids: () => ids };
}

async function order(page: Page) {
  return page.locator('[data-favorite-id]').evaluateAll(rows => rows.map(row => Number((row as HTMLElement).dataset.favoriteId)));
}

test('hold and drag changes order, saves the anchor, and survives refresh', async ({ page }) => {
  const state = await fixture(page);
  const grip = await page.getByRole('button', { name: 'Reorder Track 1', exact: true }).boundingBox();
  const target = await page.locator('[data-favorite-id="3"]').boundingBox();
  await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(400);
  await expect(page.getByRole('button', { name: 'Reorder Track 1', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-favorite-id="1"]')).toHaveAttribute('data-dragging', 'true');
  await expect(page.getByRole('button', { name: 'Play all', exact: true })).toBeDisabled();
  await page.mouse.move(grip!.x + grip!.width / 2, target!.y + target!.height - 5, { steps: 10 });
  await expect.poll(() => order(page)).toEqual([2, 3, 1, 4, 5, 6]);
  await page.mouse.up();
  await expect(page.locator('[data-favorite-id="1"]')).not.toHaveAttribute('data-dragging', 'true');
  await expect.poll(() => state.moves.length).toBe(1);
  expect(state.moves[0]).toEqual({ trackId: 1, beforeTrackId: 4 });
  await expect.poll(() => order(page)).toEqual([2, 3, 1, 4, 5, 6]);
  await page.reload();
  await expect.poll(() => order(page)).toEqual([2, 3, 1, 4, 5, 6]);
});

test('Play all queues every page in the saved favorites order', async ({ page }) => {
  await page.addInitScript(() => { HTMLMediaElement.prototype.play = async () => {}; });
  const state = await fixture(page, 205);
  await page.getByRole('button', { name: 'Reorder Track 2', exact: true }).press('ArrowUp');
  await expect.poll(() => state.moves.length).toBe(1);
  const play = page.getByRole('button', { name: 'Play all', exact: true });
  await expect(play).toBeEnabled();
  await play.click();
  await expect.poll(() => state.outgoing.some(message => message.type === 'connect:state' &&
    message.data.queue?.length === 205 && message.data.queue[0].id === 2 && message.data.queue[1].id === 1 &&
    message.data.queue[204].id === 205 && message.data.queueIndex === 0)).toBe(true);
});

test('keyboard moves save and failed saves restore server order', async ({ page }) => {
  const state = await fixture(page, 6, true);
  await page.getByRole('button', { name: 'Reorder Track 2', exact: true }).press('ArrowUp');
  await expect.poll(() => state.moves.length).toBe(1);
  await expect(page.getByText('Could not save favorites order. Please try again.')).toBeVisible();
  await expect.poll(() => order(page)).toEqual([1, 2, 3, 4, 5, 6]);
});

test('moving to a paginated boundary preserves unseen favorites', async ({ page }) => {
  const state = await fixture(page, 205);
  await expect(page.getByRole('button', { name: 'Reorder Track 199', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Reorder Track 199', exact: true }).press('ArrowDown');
  await expect.poll(() => state.moves.length).toBe(1);
  expect(state.moves[0]).toEqual({ trackId: 199, beforeTrackId: 201 });
  expect(state.ids().slice(197)).toEqual([198, 200, 199, 201, 202, 203, 204, 205]);
});

test('touch hold can reorder on a phone without starting playback; cancellation restores order', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await fixture(page);
  const session = await context.newCDPSession(page);
  const grip = await page.getByRole('button', { name: 'Reorder Track 1', exact: true }).boundingBox();
  const target = await page.locator('[data-favorite-id="3"]').boundingBox();
  const x = grip!.x + grip!.width / 2, y = grip!.y + grip!.height / 2;
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(400);
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: target!.y + target!.height - 5 }] });
  await expect.poll(() => order(page)).toEqual([2, 3, 1, 4, 5, 6]);
  await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  await expect.poll(() => order(page)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(state.moves).toEqual([]);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await page.waitForTimeout(400);
  await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: target!.y + target!.height - 5 }] });
  await page.waitForTimeout(100);
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(() => state.moves.length).toBe(1);
  expect(state.moves[0]).toEqual({ trackId: 1, beforeTrackId: 4 });
  expect(await page.locator('audio').evaluateAll(elements => elements.every(audio => (audio as HTMLAudioElement).paused))).toBe(true);
});
