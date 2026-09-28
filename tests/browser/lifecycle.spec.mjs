import { test, expect } from './fixtures.mjs';
import { lockHost, onboard, configure, visit } from './steps.mjs';

// Reads go through an extension page so they keep working after the worker
// that the fixture discovered has been stopped.
const pageStorage = page => page.evaluate(() => chrome.storage.local.get(null));
const budgetAlarm = page => page.evaluate(() => chrome.alarms.get('intentlock-budget-alarm'));

async function startWithBudget(home, minutes) {
  await home.locator('#intent-input').fill('Draft quarterly report');
  await home.locator('#time-budget').fill(String(minutes));
  await expect(home.locator('#effective-rules')).toContainText(`${minutes}-minute budget`);
  await home.getByRole('button', { name: 'Lock in', exact: true }).click();
  await expect(home.getByRole('button', { name: 'End session', exact: true })).toBeVisible();
  return (await pageStorage(home)).activeSession;
}

async function lockedIn(page, home) {
  await expect(page.locator(lockHost)).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('inert', '');
  await expect.poll(async () => Object.values((await pageStorage(home)).interventionStates || {})
    .filter(state => state.originalTabId !== undefined && state.originalUrl === page.url()).length)
    .toBeGreaterThan(0);
}

test('a lock and a paused timer survive a service-worker restart', async ({ journey }) => {
  const home = await onboard(journey);
  await configure(journey);
  await home.reload();
  const session = await startWithBudget(home, 30);
  expect((await budgetAlarm(home)).scheduledTime).toBe(session.startTime + 30 * 60_000);
  const distraction = await visit(journey, 'distraction.localhost', '/feed');
  await lockedIn(distraction, home);

  await home.bringToFront();
  await home.getByRole('button', { name: 'Pause timer', exact: true }).click();
  await expect(home.getByRole('button', { name: 'Resume timer', exact: true })).toBeVisible();
  const paused = (await pageStorage(home)).activeSession;
  expect(Number.isFinite(paused.pausedAt)).toBe(true);
  expect(await budgetAlarm(home)).toBeUndefined();

  // Stop the real MV3 worker, then let page activity revive it.
  // Close the worker's DevTools target until that instance is really gone (a
  // worker busy with an event can ignore one request); its handle then fails.
  const cdp = await journey.context.newCDPSession(home);
  const workerUrl = journey.worker.url();
  const stopWorker = async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    for (const info of targetInfos.filter(t => t.type === 'service_worker' && t.url === workerUrl)) {
      await cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {});
    }
    return journey.worker.evaluate(() => true).then(() => 'alive', () => 'dead');
  };
  await expect.poll(stopWorker, { timeout: 15_000, intervals: [250, 500, 1_000] }).toBe('dead');
  await cdp.detach();
  // Page activity revives a fresh worker, which must restore the lock from
  // storage alone (its in-memory state started empty).
  await distraction.reload();
  await lockedIn(distraction, home);

  const afterRestart = (await pageStorage(home)).activeSession;
  expect(afterRestart.id).toBe(session.id);
  expect(afterRestart.pausedAt).toBe(paused.pausedAt);
  expect(await budgetAlarm(home)).toBeUndefined();

  await home.bringToFront();
  await home.getByRole('button', { name: 'Resume timer', exact: true }).click();
  await expect(home.getByRole('button', { name: 'Pause timer', exact: true })).toBeVisible();
  const resumed = (await pageStorage(home)).activeSession;
  expect(resumed.pausedAt).toBeNull();
  expect(resumed.pausedMs).toBeGreaterThan(0);
  expect((await budgetAlarm(home)).scheduledTime).toBe(session.startTime + 30 * 60_000 + resumed.pausedMs);
});

// Separate windows are not covered here: headless Chromium moves a tab opened
// in a new window (chrome.windows.create, CDP newWindow) back into the first
// window, so a two-window assertion cannot be made honestly in this harness.
test('the same URL in two tabs locks independently and deletion unlocks both', async ({ journey }) => {
  const home = await onboard(journey);
  const options = await configure(journey);
  await home.reload();
  await startWithBudget(home, 60);
  const url = journey.fixtureUrl('distraction.localhost', '/feed');
  const first = await visit(journey, 'distraction.localhost', '/feed');
  await lockedIn(first, home);
  // Opened immediately after the first: must not be skipped by the drift debounce.
  const second = await visit(journey, 'distraction.localhost', '/feed');
  await lockedIn(second, home);
  const states = Object.values((await pageStorage(home)).interventionStates);
  expect(states).toHaveLength(2);
  expect(states.every(state => state.originalUrl === url)).toBe(true);
  expect(new Set(states.map(state => state.originalTabId)).size).toBe(2);
  expect(new Set(states.map(state => state.nonce)).size).toBe(2);

  await options.bringToFront();
  await options.getByRole('button', { name: 'Delete all data', exact: true }).click();
  await options.getByRole('button', { name: 'Confirm delete', exact: true }).click();
  await expect(options.locator('#data-status')).toHaveText('All data deleted.');
  for (const page of [first, second]) {
    await expect(page.locator(lockHost)).not.toBeVisible();
    await expect(page.locator('#document')).toBeEditable();
  }
  const deleted = await pageStorage(home);
  expect(deleted.activeSession).toBeUndefined();
  expect(deleted.interventionStates).toBeUndefined();

  // With no lock left, the fallback page explains that instead of offering dead controls.
  const fallback = await journey.context.newPage();
  await fallback.goto(journey.extensionUrl('intervention.html'));
  await expect(fallback.getByRole('heading', { name: 'This lock is no longer active' })).toBeVisible();
  await expect(fallback.getByRole('button', { name: 'Start a new session' })).toBeVisible();
});

test('a real one-minute time budget expires and locks the active page', async ({ journey }) => {
  test.setTimeout(150_000);
  const home = await onboard(journey);
  await home.reload();
  const session = await startWithBudget(home, 1);
  const work = await visit(journey, 'work.localhost', '/quarterly/report');
  await expect(work.locator(lockHost)).not.toBeVisible();
  await expect.poll(async () => Object.values((await pageStorage(home)).interventionStates || {})
    .find(state => state.originalUrl === work.url())?.reason, { timeout: 90_000, intervals: [2_000] })
    .toBe('Time budget exceeded.');
  await expect(work.locator(lockHost)).toBeVisible();
  expect(Date.now()).toBeGreaterThanOrEqual(session.startTime + 60_000);
});
