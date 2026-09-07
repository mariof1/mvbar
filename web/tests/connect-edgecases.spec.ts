import { test, expect } from '@playwright/test';
import { connectFixture } from './helpers/connect';

test('remote seeking keeps the drag position through delayed snapshots and sends one command on release', async ({ page }) => {
  const fixture = await connectFixture(page);
  const device = { id: 'remote', name: 'Other browser', type: 'web', capabilities: ['remote-control'],
    state: { track: { id: 1, title: 'One' }, queue: [{ id: 1, title: 'One' }], queueIndex: 0, queueLength: 1,
      isPlaying: false, positionMs: 10000, durationMs: 100000 } };
  fixture.devices([device]);
  await page.getByRole('button', { name: 'MVBar Connect players', exact: true }).filter({ visible: true }).first().click();
  await page.getByRole('dialog', { name: 'MVBar Connect', exact: true }).getByRole('button', { name: /Other browser/ }).click();
  const slider = page.getByRole('slider', { name: 'Seek on Other browser' });
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width * .2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .7, box.y + box.height / 2, { steps: 12 });
  const draft = Number(await slider.inputValue());
  expect(draft).toBeGreaterThan(65000);
  fixture.devices([{ ...device, state: { ...device.state, positionMs: 11000 } }]);
  await page.waitForTimeout(150);
  expect(Number(await slider.inputValue())).toBe(draft);
  expect(fixture.outgoing.filter(m => m.data?.command === 'seek')).toHaveLength(0);
  await page.mouse.up();
  await expect.poll(() => fixture.outgoing.filter(m => m.data?.command === 'seek').length).toBe(1);
  expect(fixture.outgoing.find(m => m.data?.command === 'seek').data.payload.positionMs).toBe(draft);
  fixture.devices([{ ...device, state: { ...device.state, positionMs: draft } }]);
  await expect(slider).toHaveValue(String(draft));
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => fixture.outgoing.filter(m => m.data?.command === 'seek').length).toBe(2);
});

test('failed and overlapping transfers leave the controller on its original player', async ({ page }) => {
  const fixture = await connectFixture(page);
  const track = { id: 1, title: 'One' };
  const local = { track, queue: [track], queueIndex: 0, queueLength: 1, isPlaying: false, positionMs: 0, durationMs: 100000 };
  const empty = { ...local, track: null, queue: [], queueIndex: -1, queueLength: 0 };
  fixture.devices(['A', 'B'].map(id => ({ id, name: `Browser ${id}`, type: 'web', state: empty })), local);
  const choose = async (name: string) => {
    await page.getByRole('button', { name: 'MVBar Connect players', exact: true }).filter({ visible: true }).first().click();
    await page.getByRole('dialog', { name: 'MVBar Connect', exact: true }).getByRole('button', { name }).click();
  };
  await choose('Browser A WEB');
  await expect.poll(() => fixture.outgoing.filter(m => m.type === 'connect:transfer').length).toBe(1);
  await choose('Browser B WEB');
  expect(fixture.outgoing.filter(m => m.type === 'connect:transfer')).toHaveLength(1);
  const transfer = fixture.outgoing.find(m => m.type === 'connect:transfer').data;
  fixture.event('connect:command_ack', { commandId: transfer.commandId, accepted: false, error: 'Playback was blocked on Browser A.' });
  await expect(page.getByText('Playback was blocked on Browser A.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'MVBar Connect players', exact: true }).filter({ visible: true }).first()).toHaveAttribute('title', 'Playing on Test browser');
  await choose('Browser B WEB');
  await expect.poll(() => fixture.outgoing.filter(m => m.type === 'connect:transfer').length).toBe(2);
  const retry = fixture.outgoing.filter(m => m.type === 'connect:transfer')[1].data;
  fixture.event('connect:command_ack', { commandId: retry.commandId, accepted: true, executed: true });
  await expect(page.getByRole('button', { name: 'MVBar Connect players', exact: true }).filter({ visible: true }).first()).toHaveAttribute('title', 'Playing on Browser B');
});

test('attempting to transfer a podcast keeps the episode playing and explains the limitation', async ({ page }) => {
  const fixture = await connectFixture(page);
  const podcast = { id: 900001, title: 'Audit podcast', author: 'Audit', description: '', feed_url: 'https://example.invalid/feed', episode_count: 1 };
  const episode = { id: 900002, podcast_id: podcast.id, title: 'Audit episode', audio_url: 'https://example.invalid/audio', duration_ms: 100000, position_ms: 0, played: false };
  await page.route('**/api/podcasts', r => r.fulfill({ json: { podcasts: [podcast] } }));
  await page.route('**/api/podcasts/900001', r => r.fulfill({ json: { podcast, episodes: [episode] } }));
  await page.goto('http://localhost:8080/#/podcast/900001');
  await page.getByRole('button', { name: 'Play Audit episode', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).auditMedia.some((a: HTMLAudioElement) => a.src.includes('/podcasts/') && !a.paused))).toBe(true);
  fixture.devices([{ id: 'other', name: 'Other browser', type: 'web', state: { track: null, queue: [], queueIndex: -1, queueLength: 0, isPlaying: false, durationMs: 0, positionMs: 0 } }]);
  await page.getByRole('button', { name: 'MVBar Connect players', exact: true }).filter({ visible: true }).first().click();
  await page.getByRole('dialog', { name: 'MVBar Connect', exact: true }).getByRole('button', { name: /Other browser/ }).click();
  await expect(page.getByText('Connect transfers music only. Podcast or audiobook playback stays on this device.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).auditMedia.some((a: HTMLAudioElement) => a.src.includes('/podcasts/') && !a.paused))).toBe(true);
  expect(fixture.outgoing.some(m => m.type === 'connect:transfer')).toBe(false);
});

test('unknown duration disables seeking, and a song change cancels an in-progress drag', async ({ page }) => {
  const fixture = await connectFixture(page);
  const device = { id: 'other', name: 'Other browser', type: 'web', state: { track: { id: 1 }, queue: [{ id: 1 }], queueIndex: 0, queueLength: 1, isPlaying: false, durationMs: 0, positionMs: 0 } };
  fixture.devices([device]);
  await page.getByRole('button', { name: 'MVBar Connect players', exact: true }).filter({ visible: true }).first().click();
  await page.getByRole('dialog', { name: 'MVBar Connect', exact: true }).getByRole('button', { name: /Other browser/ }).click();
  const slider = page.getByRole('slider', { name: 'Seek on Other browser' });
  await expect(slider).toBeDisabled();
  fixture.devices([{ ...device, state: { ...device.state, durationMs: 100000 } }]);
  await expect(slider).toBeEnabled();
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + box.width * .3, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * .6, box.y + box.height / 2);
  fixture.devices([{ ...device, state: { ...device.state, track: { id: 2 }, queue: [{ id: 2 }], durationMs: 200000 } }]);
  await expect(slider).toHaveValue('0');
  await page.mouse.up();
  expect(fixture.outgoing.filter(m => m.data?.command === 'seek')).toHaveLength(0);
});

test('selecting an already playing device does not overwrite it with an old paused queue', async ({ page }) => {
  const fixture = await connectFixture(page);
  const local = { track: { id: 1 }, queue: [{ id: 1 }], queueIndex: 0, queueLength: 1, isPlaying: false, durationMs: 100000, positionMs: 0 };
  fixture.devices([{ id: 'other', name: 'Other browser', type: 'web', state: { ...local, track: { id: 2 }, queue: [{ id: 2 }], isPlaying: true, positionMs: 40000 } }], local);
  await page.getByRole('button', { name: 'MVBar Connect players', exact: true }).filter({ visible: true }).first().click();
  await page.getByRole('dialog', { name: 'MVBar Connect', exact: true }).getByRole('button', { name: /Other browser/ }).click();
  await expect(page.getByRole('button', { name: 'Pause on Other browser', exact: true })).toBeVisible();
  expect(fixture.outgoing.filter(m => m.type === 'connect:transfer')).toHaveLength(0);
});
