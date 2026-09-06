import { test, expect, closedOverlay } from './fixtures.mjs';

const intent = 'Draft quarterly report';
const lockHost = '#intentlock-intervention-host';

async function onboard(journey) {
  const page = await journey.context.newPage();
  await page.goto(journey.extensionUrl('newtab.html'));
  await expect(page.getByRole('heading', { name: 'Declare your intent.' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText('Works on this device with no account.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByRole('heading', { name: 'This is the lock.', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue anyway' })).toBeDisabled();
  await page.getByRole('button', { name: 'Got it', exact: true }).click();
  return page;
}

async function configure(journey) {
  const options = await journey.context.newPage();
  await options.goto(journey.extensionUrl('options.html'));
  await expect(options.locator('#api-key')).toHaveValue('');
  await options.locator('#custom-block-domains').fill('distraction.localhost\nother.localhost');
  await options.getByRole('button', { name: 'Save site policies' }).click();
  await expect(options.locator('#sites-status')).toHaveText('Site policies saved.');
  await expect.poll(async () => (await journey.storage()).heuristicPolicy.customBlockDomains)
    .toEqual(['distraction.localhost', 'other.localhost']);
  return options;
}

async function start(page, journey) {
  await page.locator('#intent-input').fill(intent);
  await expect(page.locator('#time-budget')).toHaveValue('');
  await page.getByRole('button', { name: 'Lock in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'End session', exact: true })).toBeVisible();
  const state = await journey.storage();
  expect(state.activeSession.timeBudget).toBeNull();
  expect(state.activeSession.intent).toBe(intent);
  expect(state.llmApiKey || state.openaiApiKey).toBeFalsy();
  expect(await journey.worker.evaluate(() => chrome.storage.session.get(null)))
    .not.toHaveProperty('llmApiKey');
  return state.activeSession.id;
}

async function visit(journey, host, path) {
  const page = await journey.context.newPage();
  await page.goto(journey.fixtureUrl(host, path));
  await page.bringToFront();
  return page;
}

async function locked(page, journey) {
  await expect(page.locator(lockHost)).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('inert', '');
  await expect.poll(async () => Object.values((await journey.storage()).interventionStates || {})
    .some(state => state.originalUrl === page.url())).toBe(true);
}

test('first run, blank budget, related work, real lock, reflection, reload and session-scoped exception', async ({ journey }) => {
  const home = await onboard(journey);
  await configure(journey);
  await home.reload(); // pick up the saved policy through the production UI
  const firstId = await start(home, journey);
  const work = await visit(journey, 'work.localhost', '/quarterly/report');
  await expect.poll(async () => (await journey.storage()).activeSession.events
    .some(event => event.url === work.url())).toBe(true);
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
