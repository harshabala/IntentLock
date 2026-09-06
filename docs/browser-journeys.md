# Browser journeys

## Run

The existing `npm test` remains the dependency-free Node suite. It does not import
Playwright or discover `tests/browser/*.spec.mjs`; existing Node 18/20/22 CI can
continue running it without `npm install` or a browser.

Browser testing is a separate, opt-in development step:

```sh
npm ci
npx playwright install chromium
npm run test:browser
```

`@playwright/test`, Playwright, and Playwright Core are pinned to **1.60.0** by
`package.json` and `package-lock.json`. That release selects Chromium revision
**1223**, version **148.0.7778.96**. Use its bundled full Chromium, not a personal
Chrome installation or the headless shell. The full Chromium channel supports
headless unpacked extensions in a persistent context, as described in the
[official Playwright extension guide](https://playwright.dev/docs/chrome-extensions).

Dependency/browser downloads need network access during setup. If an environment
blocks installation, localhost listening, or browser launch, use its normal
approval workflow. Do not disable the browser sandbox or silently skip tests.
The fixture checks the pinned executable before launching and exits nonzero with
the install command when it is absent. A launch/dependency error also fails the run.

## Isolation and evidence

- Each test loads this worktree's unchanged manifest and runtime files as an
  unpacked MV3 extension, in a new OS-temporary `intentlock-browser-*` profile.
  The real `background.js` worker supplies the extension ID and read-only storage
  observations using native Chrome APIs. No mock Chrome APIs, seeded sessions,
  forced drift messages, substituted scripts, or cloud credentials are used.
- Browser navigation is limited to extension pages and HTTP synthetic fixtures
  at `work.localhost`, `distraction.localhost`, and `other.localhost`. Settings UI
  adds the latter two to the custom blocked-domain list. The local document is
  editable HTML, not a downloaded or authenticated Google Docs page.
- A server bound to `127.0.0.1` on an ephemeral port serves synthetic responses
  and acts as a non-forwarding HTTP proxy. It refuses every other hostname and
  every HTTPS CONNECT request, including browser background requests. Chromium
  uses that proxy even for loopback, disables QUIC/background networking, and
  rejects external DNS resolution. The server never contacts an upstream host.
- Closed-shadow-root inspection uses Chromium's DevTools DOM protocol. Actual
  mouse and keyboard events interact with the production overlay. Its closed
  shadow root and page-blocking behavior remain intact.
- Assertions and actions are bounded at 10 seconds, navigation/worker discovery
  at 15 seconds, and launch at 20 seconds. Tests have a 90-second timeout and the
  suite a 240-second deadline; retries are disabled. There are no arbitrary sleeps.
  Normal success/failure teardown closes the context and server and removes only
  the profile created by that test. An externally killed process may require
  manual cleanup of its specific temporary profile.
- Console output identifies the running browser. The ignored
  `test-results/browser-results.json` stores machine-readable outcomes and each
  test's `local-network-audit` attachment. Failed tests also attempt screenshots
  of their synthetic pages. No real browsing data is collected.

## Automated coverage

| Scenario | Actual assertion |
| --- | --- |
| First run without an API key | Welcome, policy settings, rehearsal heading and disabled rehearsal Continue; then Got it opens intent form. Settings key is blank. |
| Blank optional budget | UI starts a session with `timeBudget: null`; worker storage contains the declared intent and no API key. |
| Legitimate related work | `/quarterly/report` on the local work fixture produces a recorded event; its document remains editable and Save is clickable without a lock. |
| Unrelated blocked destination | Real navigation to `/feed` produces the real content-script overlay, inert document content, and a persisted worker lock state for that URL. No Test intervention shortcut is used. |
| Locked-page reload | Reload restores the overlay and the same persisted lock nonce. |
| Blank reflection | Clicking Continue with a blank reflection shows the rejection text; the lock remains and no override event is recorded. |
| Reflection and related exception | Typing a reason, checking related, and continuing removes the overlay; exactly one override stores the reason and one related-host mark is persisted. Reload remains usable. |
| Session scope | End session through its confirmation dialog, observe report, start a different session, assert marks cleared, reload the same blocked URL and observe a new real lock immediately. |
| Independent tabs | Two different blocked fixture domains have distinct original tab IDs/nonces; continuing in the first leaves the second locked with its state intact. |
| Tracking opt-out | Unchecking tracking removes the outstanding overlay. Navigating/editing the second fixture leaves the stored session event array unchanged and tracking false. |
| Deletion | The two-click Delete flow clears session/history/marks/locks/cooldowns and session storage. Reload remains usable; the new-tab page returns to first-run onboarding without restoring the session. |

These are **two end-to-end tests containing the assertions above**, not eleven
independent tests. The rehearsal is a preview; its success is not counted as real
lock evidence. Real locks come from blocked fixture navigation.

## Production regressions and calibration

Three narrow defects were reproduced before their fixes:

1. `Draft quarterly report` + Google Docs + a 120,000ms dwell was incorrectly
   classified `extended_unrelated_dwell` with score 0.7. A pure Node regression
   reproduced that result, then passed after adding the existing `productivity`
   site category to `deep_work` alignment. The same regression checks that YouTube
   entertainment still blocks. This allows the existing productivity category,
   not only Docs, unless the user explicitly custom-blocked the domain;
   classification within a productivity app remains heuristic.
2. Related-host marks survived session end/start. Node regressions for both
   boundaries failed; the actual browser end/start journey also reproduced the
   leaked mark. Finalization and start now clear stored and in-memory marks.
3. After clearing the marks, the browser journey still failed to relock the same
   destination immediately in the next session. The preceding session's URL
   debounce suppressed that evaluation. Session start now resets the debounce;
   the same failing browser assertion then passed.

The Google Docs regression evaluates the real hostname **as data in Node**, with
no network request. It is not evidence of browsing the Google Docs application or
of a two-minute wall-clock browser dwell.

**Unresolved calibration:** `Learn React hooks` can classify as `coding`, causing
YouTube video to block despite a potentially legitimate tutorial. No blanket
video allowance was added. That ambiguous intent/video case needs pilot feedback
and an explicit product decision.

## Manual / not established by this suite

- Real authenticated Google Docs, MDN, LinkedIn, YouTube, provider calls, API keys,
  public sites, and cloud latency. No public navigation occurred in these tests.
- Two-minute wall-clock dwell, time-budget alarm expiry, five-minute override
  cooldown expiry, OS idle/wake behavior, or an overnight session. The post-mark
  reload occurs within the cooldown; mark persistence is directly asserted, but
  exception behavior after cooldown expiry is not browser-proven here.
- Worker suspension/restart, extension reload/update, browser restart, crash
  recovery, and other operating systems/Chromium versions. Page reload persistence
  is covered; browser/worker lifecycle persistence is a separate check.
- Same-URL locks in two tabs, fallback intervention pages on restricted sites,
  keyboard-only/screen-reader usability, visual review, and tracking deletion
  while an overlay is still active. The automated deletion occurs after opt-out.
- Pilot completion, subjective false-lock rates, and user acceptance. This suite
  supplies reproducible mechanics evidence, not a pilot sign-off.

## Execution record — 2026-09-06

Worktree `.worktrees/browser-journeys`, branch `feat/browser-journeys`, starting
HEAD `195f57f`, manifest **1.6.0**. Host: **macOS arm64**, Node **26.5.0**, npm
**11.17.0**. Chromium reported **148.0.7778.96** from both real test contexts.
Chromium was already cached; no browser installation was necessary. Pinned npm
dependencies were installed with approved network access. An offline
`npm ci --offline --ignore-scripts --cache /private/tmp/intentlock-npm-cache`
also succeeded, verifying the generated lockfile against the downloaded cache.

| Check | Observed result |
| --- | --- |
| Before edits: `npm test` | 241 passed, 0 failed, 0 skipped. |
| Docs regression before fix | 1 failed: score 0.7, `extended_unrelated_dwell`. |
| Related-mark Node regressions before fix | Start and end each failed with retained `distraction.localhost` mark. |
| First sandboxed browser attempt | Failed with `listen EPERM: operation not permitted 127.0.0.1`; no browser evidence claimed. |
| Approved browser runs during development | Exposed harness socket/field issues, then the production exception leak and cross-session debounce issue described above. |
| Browser run after production fixes | 2 passed, 0 failed; 12.4s. |
| Final cleanup/version-evidence browser run | 2 passed, 0 failed; 11.0s. Both contexts printed Chromium 148.0.7778.96. |
| Final JSON-report run (`2026-09-06T04:44:20.570Z`) | 2 passed, 0 failed/skipped/flaky; 10.2s. Audits recorded 18 served requests, all to the three synthetic localhost hosts; 68 background requests refused, none forwarded. |
| Deliberately absent browser via `PLAYWRIGHT_BROWSERS_PATH=/private/tmp/intentlock-deliberately-missing-chromium-20260906 npm run test:browser` | Exit 1; both fixtures reported `Test Chromium is missing` with the install command. No skip. |
| Final `npm test` | 244 passed, 0 failed, 0 skipped. |
| `npm test` with `node_modules` temporarily moved away | 244 passed, 0 failed, 0 skipped; dependency directory restored afterward. |
| Final `npm run verify:static` | 73 passed, 0 failed, 0 skipped. |
| `npm run validate:version -- v1.6.0` | Passed against manifest 1.6.0. |
| `npm run package` and ZIP listing | Passed; 41 explicitly allowlisted runtime assets. No tests, dependencies, lockfile, Playwright config/results, plans, or docs. |
| `git diff --check` | Passed. |

Node 26 emitted Playwright loader deprecation and terminal color-environment
warnings. These were not extension exceptions. No Node 18/20/22 executions are
claimed here. Task 2's manual acceptance and pilot documents are outside this
change.

Packaging already enumerates runtime assets in `scripts/package-release.mjs`;
no packaging expansion was needed. Development dependencies and test outputs are
ignored and never enter that allowlist.

### Quality-review follow-up — 2026-09-06

Review of `02a182f` identified an introduced precedence regression: with intent
`Draft quarterly report`, an explicit `customBlockDomains: ['docs.google.com']`
was bypassed by automatic productivity alignment. A new focused Node regression
failed before the fix. It now verifies an immediate 0.95 lock for both an ordinary
Docs URL and a URL containing matching quarterly/report keywords.

Alignment now checks explicit session-related corrections first, then honors a
resolved custom block before considering automatic category/keyword matches.
Existing custom-allow precedence is retained. A user who reflects and marks a
custom-blocked site related can still override it for the session, even when the
URL also matches an automatic category or keyword. Ordinary, non-custom-blocked
Docs remains aligned. Both drift evaluation and the alignment helper use this
same precedence.

Verification after the fix: `npm test` **246 passed**, zero failures/skips;
`npm run test:browser` **2 passed in 9.6s**, using real Chromium **148.0.7778.96**
on macOS arm64. The existing browser journey retained its explicit-related
override, reload, and new-session relock assertions. Node tests additionally
cover related corrections on Docs (with/without keyword overlap) and the
synthetic blocked host. Public-host checks remain data-only Node assertions.
