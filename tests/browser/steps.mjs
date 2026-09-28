import { expect } from './fixtures.mjs';

// Production-UI steps shared by browser journeys.
export const intent = 'Draft quarterly report';
export const lockHost = '#intentlock-intervention-host';

export async function onboard(journey) {
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

export async function configure(journey) {
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

export async function start(page, journey) {
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

export async function visit(journey, host, path) {
  const page = await journey.context.newPage();
  await page.goto(journey.fixtureUrl(host, path));
  await page.bringToFront();
  return page;
}

export async function locked(page, journey) {
  await expect(page.locator(lockHost)).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('inert', '');
  await expect.poll(async () => Object.values((await journey.storage()).interventionStates || {})
    .some(state => state.originalUrl === page.url())).toBe(true);
}

