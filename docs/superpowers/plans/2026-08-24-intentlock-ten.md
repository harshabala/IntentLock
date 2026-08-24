# IntentLock 1.6.0 Ship-the-Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the already-hardened 1.5.1 runtime into a stranger-installable 1.6.0: two-step first run (no LLM), MIT license, honest privacy URL, ParseKit-style README, store listing assets, and a split of the onboarding module out of `newtab.js`.

**Architecture:** Stay on the `feat/v1.5.1-hardening` runtime (classic content scripts, `alarms`, non-bypassable overlay, `package.json` + CI + release zip). Do not re-implement those. Product work lives in new-tab onboarding, docs, store assets, and a focused file split. Zero-dependency Chrome MV3; tests use `node:test`.

**Tech Stack:** Vanilla JS ES modules for extension pages, classic scripts for content, Node `node:test`, GitHub Actions already on the branch.

## Global Constraints

- Do not rewrite TypeScript, add a bundler, add npm runtime dependencies, or add telemetry.
- Heuristics-only is the default. LLM setup belongs only in Settings (`options.html` / `options.js`).
- Intervention contract stays as 1.5.1: reflection required to continue; Close tab / End session are the alternatives; no Escape dismiss; overlay and `intervention.html` share mark-related + end-session.
- No `eval`, no `innerHTML` with user-controlled data — `createElement` / `textContent` / `appendChild` only (existing overlay `innerHTML` for static chrome may stay).
- Host permissions stay `http://*/*` and `https://*/*` (content scripts must run on browsed pages).
- `npm test` (`node --test tests/*.test.mjs`) must stay green; do not change the glob to `tests/` as a directory.
- Existing test `newtab.js contains showOnboardingWizard function` must keep passing until Task 6, which is allowed to move the function and update that test to `onboarding.js`.
- Version becomes `1.6.0` only in Task 7. Earlier tasks leave `manifest.json` at `1.5.1`.
- Copyright holder: `Harsha Balakrishnan`. License: MIT. Year: 2026.
- Work from this worktree only. Commit after each task. Do not push.

**Already done on this branch (do not redo):** classic content-script order, `alarms` permission, overlay Close tab / End session / mark-related, CI workflows, `scripts/package-release.mjs`, hybrid privacy copy in `docs/privacy-policy.md`.

---

### Task 1: MIT license

**Files:**
- Create: `LICENSE`
- Modify: `.gitignore` (ensure `.worktrees/` and `dist/` are listed)
- Test: `tests/static-smoke.test.mjs`

**Interfaces:**
- Consumes: none
- Produces: repo-root `LICENSE` file, MIT text, copyright `Copyright (c) 2026 Harsha Balakrishnan`

- [ ] **Step 1: Write the failing test**

Add to `tests/static-smoke.test.mjs`:

```js
test('repository includes an MIT LICENSE with the project copyright holder', async () => {
  const license = await text('LICENSE');
  assert.match(license, /MIT License/);
  assert.match(license, /Copyright \(c\) 2026 Harsha Balakrishnan/);
  assert.match(license, /Permission is hereby granted, free of charge/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/static-smoke.test.mjs`

Expected: FAIL with `ENOENT` or missing LICENSE.

- [ ] **Step 3: Write LICENSE**

Create `LICENSE` with the standard MIT text, copyright line exactly `Copyright (c) 2026 Harsha Balakrishnan`.

Ensure `.gitignore` contains:

```
.DS_Store
.claude/
dist/
.worktrees/
```

- [ ] **Step 4: Run tests**

Run: `npm test`

Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add LICENSE .gitignore tests/static-smoke.test.mjs
git commit -m "chore: add MIT license"
```

---

### Task 2: Heuristics-first onboarding (no LLM on first run)

**Files:**
- Modify: `newtab.js` (`showOnboardingWizard`)
- Test: `tests/static-smoke.test.mjs` (new tests in this file)

**Interfaces:**
- Consumes: `INTENT_CATEGORIES`, `buildDefaultPolicy` from `heuristic-policy.js` (already imported)
- Produces: onboarding of exactly two screens — Welcome, then Default policy (category + strictness). Completing onboarding sets `hasSeenOnboarding: true` and writes `heuristicPolicy` via `buildDefaultPolicy(categoryId, strictness)` with `setupCompleted: true`. Does not write API keys. Sets `llmProviderConfig` to `{ providerId: 'none' }` only if no config is stored yet.

**Copy (verbatim):**
- Welcome heading: `Welcome to IntentLock`
- Welcome body: `Declare an intent before you browse. If you drift, IntentLock locks the page until you reflect or leave.`
- Welcome button: `Continue`
- Policy heading: `Set your default policy`
- Policy body: `Heuristics work with no API key. Add an AI provider later in Settings.`
- Policy save button: `Save policy`
- No Skip button.

- [ ] **Step 1: Write the failing tests**

Add to `tests/static-smoke.test.mjs`:

```js
test('onboarding wizard does not collect an API key', async () => {
  const code = await text('newtab.js');
  const wizard = code.slice(
    code.indexOf('function showOnboardingWizard'),
    code.indexOf('function showNewSessionForm'),
  );
  assert.ok(wizard.length > 50, 'showOnboardingWizard must exist before showNewSessionForm');
  assert.equal(wizard.includes('api-key-input'), false);
  assert.equal(wizard.includes('CHOOSE YOUR DETECTION MODE'), false);
  assert.equal(wizard.includes('provider-select'), false);
  assert.match(wizard, /Welcome to IntentLock/);
  assert.match(wizard, /Set your default policy/);
  assert.match(wizard, /Add an AI provider later in Settings/);
  assert.match(wizard, /id=['"]onboarding-category['"]/);
  assert.match(wizard, /id=['"]onboarding-strictness['"]/);
  assert.equal(/\bSKIP\b/.test(wizard), false);
});

test('LLM provider fields remain on the options page', async () => {
  const html = await text('options.html');
  assert.match(html, /id=["']provider-select["']/);
  assert.match(html, /id=["']api-key-group["']/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/static-smoke.test.mjs`

Expected: FAIL because wizard still contains detection-mode / `api-key-input`.

- [ ] **Step 3: Replace `showOnboardingWizard`**

Delete `showStep2` (detection mode + API key). Keep welcome as step 1. Make Continue go to the existing policy UI (current `showStep3`) with the verbatim copy above. Remove the Skip button. On Save policy:

```js
const policy = buildDefaultPolicy(categorySelect.value, strictnessSelect.value);
policy.setupCompleted = true;
chrome.storage.local.get(['llmProviderConfig'], (result) => {
  const patch = { heuristicPolicy: policy, hasSeenOnboarding: true };
  if (!result.llmProviderConfig) {
    patch.llmProviderConfig = { providerId: 'none' };
  }
  chrome.storage.local.set(patch, () => {
    chrome.runtime.sendMessage({ type: 'CONFIG_UPDATED' }, () => {
      void chrome.runtime.lastError;
    });
    showNewSessionForm(container);
  });
});
```

Do not import additional provider helpers for this path. Leave `showNewSessionForm` unchanged.

Respect existing `dataDeletionInProgress` guards if that flag is in scope; if the 1.5.1 wizard checks it before storage writes, keep those checks on the save path.

- [ ] **Step 4: Run tests**

Run: `npm test`

Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add newtab.js tests/static-smoke.test.mjs
git commit -m "feat: skip LLM during onboarding"
```

---

### Task 3: Stranger-install README

**Files:**
- Modify: `README.md`
- Test: `tests/static-smoke.test.mjs`

**Interfaces:**
- Consumes: license from Task 1, onboarding copy from Task 2
- Produces: a README a novice can follow in two minutes

- [ ] **Step 1: Write the failing test**

```js
test('README tells a novice how to install from a release zip', async () => {
  const readme = await text('README.md');
  assert.match(readme, /Releases/);
  assert.match(readme, /Load unpacked/);
  assert.match(readme, /MIT/);
  assert.match(readme, /docs\/privacy-policy\.md/);
  assert.match(readme, /Settings/);
  assert.equal(readme.includes('**2 — LLM setup**'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/static-smoke.test.mjs`

Expected: FAIL on `**2 — LLM setup**` still present or missing Releases.

- [ ] **Step 3: Rewrite README**

Replace `README.md` with this structure (keep the mermaid architecture and drift pipeline sections that already exist, but put them under a heading `## How it works (technical)` after the novice section). Opening must be:

```markdown
# IntentLock

Declare what you are doing. IntentLock watches your tabs and locks the page when you drift.

Heuristics run with no API key. An optional AI provider in Settings is a second opinion only.

## Install (about two minutes)

1. Open [Releases](https://github.com/harshabala/IntentLock/releases/latest) and download the latest `IntentLock-*.zip`.
2. Unzip it.
3. Chrome → `chrome://extensions` → enable **Developer mode**.
4. **Load unpacked** → select the unzipped folder.
5. Open a new tab. Welcome → set default policy → **Lock in** an intent.

From source: clone this repo, load the repo folder unpacked, then `npm test`.

## First run

1. Welcome
2. Default intent type + strictness (you can change this later in Settings)
3. Type this session's intent and optional time budget. Click **Lock in**.

AI providers are not part of setup. Add one in **Settings** if you want a second drift check.

## What it does

- Blocks the page when you leave your declared intent
- Requires a written reflection to continue, or Close tab / End session
- Stores session data only on this device

## What it does not do

- No accounts, cloud sync, or telemetry
- No habit dashboard or rewards
- No Chrome Web Store listing yet (use the GitHub Release zip)

## Privacy

See [docs/privacy-policy.md](docs/privacy-policy.md). Optional remote LLM providers receive minimized intent and origin-only context when you configure a key.

## License

[MIT](LICENSE) © 2026 Harsha Balakrishnan
```

After that, keep the existing mermaid + architecture + testing + development sections from the current README, retitled under `## How it works (technical)`. Update the onboarding table there so it no longer lists LLM setup as step 2.

- [ ] **Step 4: Run `npm test`**

Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add README.md tests/static-smoke.test.mjs
git commit -m "docs: write novice install README"
```

---

### Task 4: Privacy policy URL and GitHub Pages

**Files:**
- Modify: `docs/privacy-policy.md`
- Create: `docs/site/index.html` (redirect/home)
- Create: `docs/site/privacy.html` (rendered privacy policy)
- Create: `.github/workflows/pages.yml`
- Test: `tests/static-smoke.test.mjs`

**Interfaces:**
- Consumes: current `docs/privacy-policy.md` hybrid wording
- Produces: hosted path `https://harshabala.github.io/IntentLock/privacy.html`

- [ ] **Step 1: Write the failing test**

```js
test('privacy site page exists for Chrome Web Store hosting', async () => {
  const html = await text('docs/site/privacy.html');
  assert.match(html, /<h1[^>]*>Privacy Policy<\/h1>/);
  assert.match(html, /chrome.storage/);
  assert.match(html, /Ollama/);
  assert.match(html, /does not operate an intermediary/);
  const workflow = await text('.github/workflows/pages.yml');
  assert.match(workflow, /peaceiris\/actions-gh-pages@v4/);
  assert.match(workflow, /docs\/site/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: missing `docs/site/privacy.html`.

- [ ] **Step 3: Implement**

1. Set `docs/privacy-policy.md` **Effective Date** to `August 24, 2026`. Keep the hybrid LLM sections. Add at the top: `Public URL: https://harshabala.github.io/IntentLock/privacy.html`.
2. Create `docs/site/privacy.html`: valid HTML document, `lang="en"`, title `IntentLock Privacy Policy`, body content matching the markdown policy (local storage, optional providers including OpenAI/Gemini/Grok/Ollama/LM Studio, no telemetry, delete-all in Settings). No analytics scripts.
3. Create `docs/site/index.html` that links to `privacy.html` with the product one-liner from the README.
4. Create `.github/workflows/pages.yml`:

```yaml
name: GitHub Pages
on:
  push:
    branches: [main]
    paths:
      - 'docs/site/**'
      - '.github/workflows/pages.yml'
permissions:
  contents: write
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: peaceiris/actions-gh-pages@v4
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: docs/site
```

Pin `peaceiris/actions-gh-pages@v4` is acceptable here; do not add a third-party analytics action.

- [ ] **Step 4: Run `npm test`**

- [ ] **Step 5: Commit**

```bash
git add docs/privacy-policy.md docs/site .github/workflows/pages.yml tests/static-smoke.test.mjs
git commit -m "docs: host privacy policy for store review"
```

---

### Task 5: Chrome Web Store listing pack

**Files:**
- Create: `store/LISTING.md`
- Create: `store/screenshots/README.md`
- Modify: `docs/store-assets-plan.md` (point at `store/LISTING.md`)
- Test: `tests/static-smoke.test.mjs`

**Interfaces:**
- Consumes: README copy, privacy URL
- Produces: listing fields ready to paste into CWS; screenshot shot list. Do not invent photographic PNG screenshots of a running Chrome profile.

- [ ] **Step 1: Write the failing test**

```js
test('store listing pack has CWS fields and a five-shot plan', async () => {
  const listing = await text('store/LISTING.md');
  assert.ok(listing.split('## Short description')[1].trim().split('\n')[0].length <= 132);
  assert.match(listing, /https:\/\/harshabala\.github\.io\/IntentLock\/privacy\.html/);
  assert.match(listing, /Load unpacked/);
  const shots = await text('store/screenshots/README.md');
  assert.match(shots, /1280x800/);
  assert.match(shots, /new tab intent form/);
  assert.match(shots, /intervention/);
  assert.match(shots, /settings/);
});
```

Short description max is 132 characters (CWS). Put the short description on the first non-empty line after `## Short description`.

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Write listing copy**

`store/LISTING.md`:

- Name: `IntentLock`
- Short description (≤132 chars): `Declare your intent. IntentLock watches your tabs and locks the page when you drift. Heuristics work with no API key.`
- Full description: declare → lock → reflect or leave; local-only; optional AI in Settings; not a dashboard.
- Category: Productivity
- Language: English
- Privacy: single purpose (enforce declared browsing intent); hosted policy URL as above; permissions justification for `tabs`, `storage`, `idle`, `tabGroups`, `alarms`, host permissions (page overlay + dwell).
- Install note: GitHub Release until CWS review completes.

`store/screenshots/README.md`: five required 1280×800 captures from a loaded unpacked build, in this order: (1) new tab intent form (2) active session (3) intervention overlay on a real site (4) Settings heuristics grid (5) Settings LLM section collapsed as optional. State that a human must capture these from Chrome; do not commit fake PNGs.

Update `docs/store-assets-plan.md` first paragraph to say canonical listing copy lives in `store/LISTING.md`.

- [ ] **Step 4: Run `npm test`**

- [ ] **Step 5: Commit**

```bash
git add store docs/store-assets-plan.md tests/static-smoke.test.mjs
git commit -m "docs: add Chrome Web Store listing pack"
```

---

### Task 6: Extract onboarding module from `newtab.js`

**Files:**
- Create: `onboarding.js`
- Modify: `newtab.js`
- Modify: `newtab.html` if a second module script is required (prefer importing from `newtab.js` so HTML stays one script tag)
- Modify: `tests/static-smoke.test.mjs` (wizard tests now read `onboarding.js`)
- Modify: `scripts/package-release.mjs` only if it uses an explicit file allowlist — add `onboarding.js`

**Interfaces:**
- Consumes: `INTENT_CATEGORIES`, `buildDefaultPolicy`; `showNewSessionForm` passed in as a callback
- Produces:

```js
export function showOnboardingWizard(container, { showNewSessionForm }) { /* ... */ }
```

`newtab.js` imports that function and calls it where it currently does. Theme loading stays in `newtab.js`.

- [ ] **Step 1: Write the failing tests**

Change the existing `newtab.js contains showOnboardingWizard function` test to:

```js
test('onboarding wizard lives in onboarding.js', async () => {
  const code = await text('onboarding.js');
  assert.match(code, /export function showOnboardingWizard/);
  const newtab = await text('newtab.js');
  assert.match(newtab, /from '\.\/onboarding\.js'/);
  assert.equal(newtab.includes('function showOnboardingWizard'), false);
});
```

Update Task 2's `onboarding wizard does not collect an API key` test to read `onboarding.js` instead of slicing `newtab.js`. If the test still slices `newtab.js`, rewrite it to `await text('onboarding.js')` and drop the slice.

If `scripts/package-release.mjs` has an allowlist array, add a test assertion in `tests/manifest-runtime.test.mjs` or the packaging test that `onboarding.js` is included. Read that script first and extend the existing allowlist test rather than inventing a new packaging format.

- [ ] **Step 2: Run tests to verify they fail**

Expected: missing `onboarding.js`.

- [ ] **Step 3: Move the wizard**

Move `showOnboardingWizard` and its inner helpers (`setOnboardingStatus` if local, policy save) into `onboarding.js`. Keep using `createElement`. Import `INTENT_CATEGORIES` and `buildDefaultPolicy` in `onboarding.js` so `newtab.js` can drop those imports if unused.

Do not move `showNewSessionForm`, timers, or history UI.

If `package-release.mjs` allowlists files, add `'onboarding.js'`.

- [ ] **Step 4: Run `npm test` and `npm run package`**

Expected: tests pass; zip contains `onboarding.js`.

- [ ] **Step 5: Commit**

```bash
git add onboarding.js newtab.js tests/static-smoke.test.mjs scripts/package-release.mjs tests/manifest-runtime.test.mjs
git commit -m "refactor: extract onboarding module"
```

---

### Task 7: Version 1.6.0, changelog, task list

**Files:**
- Modify: `manifest.json` version to `1.6.0`
- Modify: `CHANGELOG.md`
- Modify: `docs/TASKS.md`
- Modify: `package.json` only if it has a version field; if not, leave it
- Test: `tests/static-smoke.test.mjs` or existing version tests in `tests/manifest-runtime.test.mjs`

**Interfaces:**
- Consumes: all previous tasks
- Produces: shippable 1.6.0 metadata

- [ ] **Step 1: Write / update version test**

If `tests/manifest-runtime.test.mjs` asserts `1.5.1`, update it to `1.6.0`. Add if missing:

```js
test('manifest version is 1.6.0', async () => {
  const manifest = JSON.parse(await text('manifest.json'));
  assert.equal(manifest.version, '1.6.0');
});
```

Put this in `tests/static-smoke.test.mjs` if that file already imports `text()`.

- [ ] **Step 2: Run test to verify it fails**

Expected: actual `1.5.1`.

- [ ] **Step 3: Update metadata**

`CHANGELOG.md` new top section:

```markdown
## [1.6.0] — 2026-08-24

### Added
- MIT license
- GitHub Pages privacy policy
- Chrome Web Store listing pack under `store/`

### Changed
- First-run onboarding is welcome + default policy only; LLM stays in Settings
- README leads with a two-minute GitHub Release install
- Onboarding lives in `onboarding.js`
```

`docs/TASKS.md`: mark README, onboarding heuristics-only, and ship-doc tasks Done. Do not claim Chrome Web Store approval.

`manifest.json` `"version": "1.6.0"`.

- [ ] **Step 4: Run `npm test` and `npm run validate:version -- v1.6.0` if that script exists**

If `validate-version` expects a git tag, run `npm test` only and note that in the report.

- [ ] **Step 5: Commit**

```bash
git add manifest.json CHANGELOG.md docs/TASKS.md tests/static-smoke.test.mjs tests/manifest-runtime.test.mjs
git commit -m "chore: release 1.6.0 metadata"
```
