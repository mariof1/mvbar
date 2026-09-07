import { test, expect } from '@playwright/test';
import { connectFixture } from './helpers/connect';

test('paused transfer stays silent and playing transfer starts only once', async ({ page }) => {
  const fixture = await connectFixture(page);
  const tracks = [{ id: 1, title: 'First' }, { id: 2, title: 'Second' }];
  expect((await fixture.command('play_tracks', { tracks, queueIndex: 1, isPlaying: false, positionMs: 5000 })).success).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).musicPlayCalls)).toBe(0);
  await expect(page.locator('#mvbar-music-audio')).toHaveAttribute('src', '/api/stream/2');
  expect((await fixture.command('play_tracks', { tracks, queueIndex: 0, isPlaying: true })).success).toBe(true);
  expect(await page.evaluate(() => (window as any).musicPlayCalls)).toBe(1);
  expect((await fixture.command('clear_queue')).success).toBe(true);
  await expect.poll(() => fixture.outgoing.some(m => m.type === 'connect:state' && m.data.queue.length === 1 && m.data.track?.id === 1)).toBe(true);
  expect((await fixture.command('stop')).success).toBe(true);
  await expect(page.locator('#mvbar-music-audio')).not.toHaveAttribute('src');
});

test('a duplicated tab obtains a distinct identity and reconnects with it', async ({ page }) => {
  const fixture = await connectFixture(page);
  const firstId = fixture.outgoing.find(m => m.type === 'connect:register').data.deviceId;
  fixture.event('connect:replaced', { deviceId: firstId });
  await expect.poll(() => fixture.outgoing.filter(m => m.type === 'connect:register').length).toBe(2);
  const secondId = fixture.outgoing.filter(m => m.type === 'connect:register')[1].data.deviceId;
  expect(secondId).not.toBe(firstId);
  fixture.disconnect();
  await expect.poll(() => fixture.outgoing.filter(m => m.type === 'connect:register').length).toBe(3);
  expect(fixture.outgoing.filter(m => m.type === 'connect:register')[2].data.deviceId).toBe(secondId);
  await page.getByRole('button', { name: 'MVBar Connect players', exact: true }).filter({ visible: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'MVBar Connect', exact: true });
  await dialog.getByRole('button', { name: 'Rename this player', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'This player name' }).fill('Office browser');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => fixture.outgoing.filter(m => m.type === 'connect:register').at(-1)?.data.name).toBe('Office browser');
  expect(await page.evaluate(() => localStorage.getItem('mvbar_connect_device_name'))).toBe('Office browser');
});

test('remote picker and player controls dispatch to the selected device', async ({ page }) => {
  const fixture = await connectFixture(page);
  const tracks = [{ id: 1, title: 'One' }, { id: 2, title: 'Two' }, { id: 3, title: 'Three' }];
  fixture.devices([{ id: 'tv', name: 'Living room TV', type: 'tv', capabilities: ['remote-control'],
    state: { track: tracks[1], queue: tracks, queueIndex: 1, queueLength: 3, isPlaying: false, positionMs: 0, durationMs: 100000 } }]);
  const trigger = page.getByRole('button', { name: 'MVBar Connect players', exact: true }).filter({ visible: true }).first();
  await trigger.click();
  await page.getByRole('dialog', { name: 'MVBar Connect', exact: true }).getByRole('button', { name: /Living room TV/ }).click();
  for (const [label, command] of [['Play', 'toggle'], ['Next', 'next'], ['Previous', 'previous']]) {
    await page.getByRole('button', { name: `${label} on Living room TV`, exact: true }).click();
    expect(fixture.outgoing.some(m => m.type === 'connect:command' && m.data.command === command && m.data.targetDeviceId === 'tv')).toBe(true);
  }
  await page.getByRole('slider', { name: 'Seek on Living room TV' }).fill('25000');
  await expect.poll(() => fixture.outgoing.some(m => m.data?.command === 'seek' && m.data.payload.positionMs === 25000)).toBe(true);
  await page.getByRole('button', { name: 'Queue on Living room TV', exact: true }).click();
  await page.getByRole('button', { name: 'Play Three on Living room TV', exact: true }).click();
  await page.getByRole('button', { name: 'Remove One from queue', exact: true }).click();
  await page.getByRole('button', { name: 'Clear upcoming', exact: true }).click();
  for (const command of ['play_index', 'remove_index', 'clear_queue']) {
    expect(fixture.outgoing.some(m => m.data?.command === command && m.data.targetDeviceId === 'tv')).toBe(true);
  }
  expect(await page.evaluate(() => (window as any).musicPlayCalls)).toBe(0);
  fixture.devices([]);
  await expect(page.getByRole('button', { name: 'Play on Living room TV', exact: true })).toHaveCount(0);
});

test('blocked playback and invalid queue commands return failure acknowledgements', async ({ page }) => {
  const fixture = await connectFixture(page);
  await page.evaluate(() => { (window as any).blockPlayback = true; });
  const result = await fixture.command('play_tracks', { tracks: [{ id: 1 }], isPlaying: true });
  expect(result.success).toBe(false);
  expect(result.error).toContain('blocked');
  expect((await fixture.command('play_index', { index: 5 })).success).toBe(false);
  expect((await fixture.command('play_tracks', { tracks: [] })).success).toBe(false);
});

test('remote next and previous preserve pause, and play-index reports a playback failure', async ({ page }) => {
  const fixture = await connectFixture(page);
  await fixture.command('play_tracks', { tracks: [{ id: 1 }, { id: 2 }, { id: 3 }], queueIndex: 1, isPlaying: false });
  expect((await fixture.command('next')).success).toBe(true);
  await expect(page.locator('#mvbar-music-audio')).toHaveAttribute('src', '/api/stream/3');
  expect((await fixture.command('previous')).success).toBe(true);
  await expect(page.locator('#mvbar-music-audio')).toHaveAttribute('src', '/api/stream/2');
  expect(await page.evaluate(() => (window as any).musicPlayCalls)).toBe(0);
  await page.evaluate(() => { (window as any).blockPlayback = true; });
  expect((await fixture.command('play_index', { index: 0 })).success).toBe(false);
});
