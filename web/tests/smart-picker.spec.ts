import { test, expect } from '@playwright/test';

test('smart criteria support repeated keyboard selection and delayed suggestions', async ({ page }) => {
  await page.routeWebSocket('**/*', () => {});
  const genres = ['Rock', ...Array.from({ length: 12 }, (_, i) => `Rock style ${i + 1}`), 'Hard Rock'];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/me')) {
      return route.fulfill({ json: { ok: true, user: { id: 'keyboard-test', email: 'test@local', role: 'admin' } } });
    }
    if (path.endsWith('/smart-playlists/suggest')) {
      await new Promise(resolve => setTimeout(resolve, 400));
      return route.fulfill({ json: { items: genres } });
    }
    return route.fulfill({ json: { ok: true, items: [], tracks: [], playlists: [], devices: [], searches: [] } });
  });
  await page.goto(`${process.env.MVBAR_TEST_URL || 'http://localhost:8080'}/#/playlists/smart`);
  await page.getByRole('button', { name: 'Create Smart Playlist', exact: true }).click();
  const input = page.getByRole('combobox', { name: 'Genres', exact: true }).first();
  await input.fill('rock');
  await input.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'Rock', exact: true })).toHaveAttribute('aria-selected', 'true');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Remove Rock', exact: true })).toBeVisible();
  await expect(input).toBeFocused();
  await input.fill('rock');
  await input.press('ArrowUp');
  const last = page.getByRole('option', { name: 'Hard Rock', exact: true });
  await expect(last).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('option', { name: 'Rock', exact: true })).toHaveCount(0);
  await expect(last).toBeInViewport();
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Remove Hard Rock', exact: true })).toBeVisible();
  await expect(input).toBeFocused();
  await input.fill('rock');
  await expect(page.getByRole('listbox').getByRole('option').first()).toBeVisible();
  await input.press('ArrowDown');
  await input.press('ArrowUp');
  await expect(page.getByRole('listbox').getByRole('option').last()).toHaveAttribute('aria-selected', 'true');
  await input.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  await expect(input).toBeFocused();
});
