import { test, expect, closedOverlay } from './fixtures.mjs';
import { lockHost, onboard, configure, start, visit, locked } from './steps.mjs';

test('first run, blank budget, related work, real lock, reflection, reload and session-scoped exception', async ({ journey }) => {
  const home = await onboard(journey);
  await configure(journey);
  await home.reload(); // pick up the saved policy through the production UI
  const firstId = await start(home, journey);
  const work = await visit(journey, 'work.localhost', '/quarterly/report');
  await expect.poll(async () => (await journey.storage()).activeSession.events
    .some(event => event.url === new URL(work.url()).origin && event.intentMatch === true)).toBe(true);
  // Stored events keep origins only; the path's keyword verdict is precomputed.
  expect(JSON.stringify((await journey.storage()).activeSession.events)).not.toContain('/quarterly/report');
  await work.locator('#document').fill('Quarterly report draft');
  await work.getByRole('button', { name: 'Save local draft' }).click();
  await expect(work.locator(lockHost)).not.toBeVisible();

  const distraction = await visit(journey, 'distraction.localhost', '/feed');
  await locked(distraction, journey);
  const beforeReload = Object.values((await journey.storage()).interventionStates)
    .find(state => state.originalUrl === distraction.url());
  await distraction.reload();
  await locked(distraction, journey);
  const afterReload = Object.values((await journey.storage()).interventionStates)
    .find(state => state.originalUrl === distraction.url());
  expect(afterReload.nonce).toBe(beforeReload.nonce);
  const overlay = await closedOverlay(distraction);
  try {
    await overlay.click('.override-btn');
    await expect.poll(() => overlay.read('#transition-error', 'this.textContent'))
      .toBe('Write why, or close this tab.');
    await locked(distraction, journey);
    expect((await journey.storage()).activeSession.events.filter(e => e.actionType === 'OVERRIDE')).toHaveLength(0);
    await overlay.click('#intentlock-reflection');
    await distraction.keyboard.type('This source provides evidence for the quarterly report.');
    await overlay.click('#intentlock-mark-related');
    await overlay.click('.override-btn');
    await expect(distraction.locator(lockHost)).not.toBeVisible();
    await expect.poll(async () => (await journey.storage()).relatedDomainMarks?.['distraction.localhost']?.count).toBe(1);
    const overrides = (await journey.storage()).activeSession.events.filter(e => e.actionType === 'OVERRIDE');
    expect(overrides).toHaveLength(1);
    expect(overrides[0].reflection).toBe('This source provides evidence for the quarterly report.');
    await distraction.reload();
    await expect(distraction.locator('#document')).toBeEditable();
    await expect(distraction.locator(lockHost)).not.toBeVisible();
  } finally {
    await overlay.close();
  }

  await home.bringToFront();
  await home.getByRole('button', { name: 'End session', exact: true }).click();
  await home.getByRole('dialog').getByRole('button', { name: 'End session', exact: true }).click();
  await expect(home.getByRole('heading', { name: 'Session report', exact: true })).toBeVisible();
  await home.goto(journey.extensionUrl('newtab.html'));
  expect(await start(home, journey)).not.toBe(firstId);
  expect((await journey.storage()).relatedDomainMarks || {}).toEqual({});
  await distraction.reload();
  await distraction.bringToFront();
  await locked(distraction, journey);
});

test('independent tab locks, opt-out, deletion and fresh onboarding', async ({ journey }) => {
  const home = await onboard(journey);
  const options = await configure(journey);
  await home.reload();
  await start(home, journey);
  const first = await visit(journey, 'distraction.localhost', '/feed');
  await locked(first, journey);
  const second = await visit(journey, 'other.localhost', '/feed');
  await locked(second, journey);
  let states = Object.values((await journey.storage()).interventionStates);
  expect(states).toHaveLength(2);
  expect(new Set(states.map(s => s.originalTabId)).size).toBe(2);
  expect(new Set(states.map(s => s.nonce)).size).toBe(2);
  await first.bringToFront();
  const overlay = await closedOverlay(first);
  try {
    await overlay.click('#intentlock-reflection');
    await first.keyboard.type('I choose to check this source.');
    await overlay.click('.override-btn');
    await expect(first.locator(lockHost)).not.toBeVisible();
  } finally {
    await overlay.close();
  }
  await locked(second, journey);
  states = Object.values((await journey.storage()).interventionStates);
  expect(states).toHaveLength(1);
  expect(states[0].originalUrl).toBe(second.url());

  await options.bringToFront();
  await options.locator('#tracking-toggle').uncheck();
  await expect(options.locator('#data-status')).toHaveText('Tracking disabled.');
  await expect(second.locator(lockHost)).not.toBeVisible();
  const optedOut = (await journey.storage()).activeSession.events;
  await second.goto(journey.fixtureUrl('other.localhost', '/after-opt-out'));
  await second.locator('#document').fill('Untracked work');
  await expect(second.locator(lockHost)).not.toBeVisible();
  expect((await journey.storage()).activeSession.events).toEqual(optedOut);
  expect((await journey.storage()).trackingEnabled).toBe(false);

  await options.getByRole('button', { name: 'Delete all data', exact: true }).click();
  await options.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(options.locator('#data-status')).toHaveText('All data deleted.');
  await expect.poll(async () => (await journey.storage()).activeSession).toBeUndefined();
  const deleted = await journey.storage();
  for (const key of ['sessionHistory', 'relatedDomainMarks', 'interventionStates', 'overrideCooldowns']) {
    expect(deleted[key] == null || Object.keys(deleted[key]).length === 0, key).toBe(true);
  }
  expect(await journey.worker.evaluate(() => chrome.storage.session.get(null))).toEqual({});
  await second.reload();
  await expect(second.locator('#document')).toBeEditable();
  await home.reload();
  await expect(home.getByRole('heading', { name: 'Declare your intent.' })).toBeVisible();
  expect((await journey.storage()).activeSession).toBeUndefined();
});
