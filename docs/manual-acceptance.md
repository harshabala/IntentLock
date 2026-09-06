# IntentLock 1.6.0 manual acceptance

Status: **NOT RUN** for this checklist revision. Use a fresh disposable Chrome
profile with this worktree loaded unpacked. Use synthetic documents/intents only;
no participant data, public-site accounts, real credentials, exported personal
logs, or recordings. These are QA procedures, not pilot participant tasks.

The [browser suite](browser-journeys.md#automated-coverage) documents actual
automated assertions and its [manual gaps](browser-journeys.md#manual--not-established-by-this-suite).
Its [historical execution record](browser-journeys.md#execution-record--2026-09-06)
is Task 1 evidence, not a pass for this manual checklist. Do not overwrite it.
See [development commands](development.md#running-tests) and the separately gated
[pilot protocol](pilot/README.md).

## Run record

Copy this checklist for each run. For every row record **PASS / FAIL / NOT RUN**,
actual observation, and a synthetic-only issue reference. PASS requires execution
and the stated expectation; code inspection or an automated analogue alone does
not qualify. A blocked check is NOT RUN with its reason.

| Metadata | Value |
| --- | --- |
| Date/time/timezone; QA operator code | |
| Branch, full commit, clean/dirty state; manifest version | |
| OS/version; browser/version; unpacked folder; fresh profile | |
| Viewport/zoom; input method; screen reader/version; reduced-motion setting | |
| Policy category/strictness, custom rules; tracking; provider state | |
| Local fixture/fake-provider configuration and fault-injection method | |
| Overall status | NOT RUN |

Use an isolated localhost fixture serving editable synthetic work and distraction
pages. The suite's fixture server is test-owned, not a standalone manual server;
record the manual server setup actually used. Fault injection must be confined
to a disposable QA profile or local fake provider, with the exact method recorded
and restored afterward. If a failure cannot safely be induced, mark NOT RUN.
Do not browse public services to simulate failures.

## Current UI and ordinary mechanics

| ID | Procedure and expected result | Status | Observation / issue |
| --- | --- | --- | --- |
| M01 | First run: “Declare your intent.” → Continue → “How hard should the lock be?”; choose work category/strictness → Save and continue → “This is the lock.” Rehearsal Continue anyway is disabled; Got it opens the form. No key/provider configuration is required. | NOT RUN | |
| M02 | Form: Intent, Minutes (optional), Lock in. Blank intent is rejected. A synthetic intent and blank minutes start an active session without a budget. Verify a numeric budget separately. Active view offers End session and Try the lock. | NOT RUN | |
| M03 | Navigate to an aligned editable local work page; editing and saving remain possible. Add a local distraction host under Settings → Always block (one domain per line) → Save site policies and navigate there. A real navigation-triggered overlay blocks underlying clicks/scrolling. Try the lock and Test intervention on current tab are separate smoke checks, not drift evidence. | NOT RUN | |
| M04 | On the real lock, blank Why? cannot continue. A synthetic reason and This site is related to my intent → Continue anyway releases it after success. Reload and later expiry checks preserve that session's correction. Close this tab closes only the intended tab. | NOT RUN | |
| M05 | End session → confirmation End session opens Session report; Cancel keeps the session. Inspect On-intent, Top domains and Reflections with synthetic content. Start new session clears related-site corrections: revisiting the blocked host must lock again immediately. Report viewing does not prove task completion. | NOT RUN | |
| M06 | Reload an outstanding lock; it remains actionable and corresponds to the same persisted lock. Rapid double submission creates one transition/override. Stale/copied nonce transitions are rejected; record the synthetic injection method. | NOT RUN | |

M01–M06 overlap only partly with the automated suite. Real timing, all close/error
paths and visual/accessibility behavior still need manual execution.

## Lifecycle, windows and accessibility

| ID | Procedure and expected result | Status | Observation / issue |
| --- | --- | --- | --- |
| M07 | Suspend/stop the service worker through browser developer controls with an active session and lock, close its inspector so it can suspend, then interact/reload to wake it. Repeat with a reflected related-host correction. Session, lock ownership and correction recover without duplicate overrides. Record whether suspension actually occurred. | NOT RUN | |
| M08 | Quit and restart the browser with an active locked tab; restore tabs. Separately reload the extension, then affected tabs. Record each case: no silent session/lock loss, stale locks, or duplicated transitions. A page reload alone does not pass this check. | NOT RUN | |
| M09 | Open the same blocked synthetic URL in two tabs in one window, then in two windows. Confirm distinct tab lock state/nonces; continuing or closing one leaves the other locked/actionable. Repeat after worker restart. Automated different-domain tabs do not establish this. | NOT RUN | |
| M10 | Keyboard only: onboarding, form, Settings, report, real overlay and fallback. Tab/Shift+Tab maintain logical visible focus; lock focus stays inside; Escape cannot bypass it; errors are announced/focused and actions remain reachable. Verify the actual configured start/end keyboard shortcut. | NOT RUN | |
| M11 | With an actual screen reader, check dialog name/reason, Why? label, related checkbox, busy/disabled controls, error announcements, and focus after release. Record reader/browser versions; DOM roles alone do not pass. | NOT RUN | |
| M12 | At 200% zoom and narrow viewport, all lock/form/settings actions remain reachable without clipped content; scroll long synthetic reflection content. Enable OS reduced motion and verify overlay/rehearsal/fallback motion is reduced. Record settings and visual observation. | NOT RUN | |
| M13 | Use a harmless restricted browser page or deny content-script delivery in QA to exercise actual fallback intervention.html. Check reflection, related correction, end-session and keyboard/screen-reader behavior. Induce tabs.remove failure locally: show actionable error or an ended-session/manual-close path; no false successful close. | NOT RUN | |

## Real time, privacy and failure paths

All checks below are required before pilot readiness can be declared. Unsupported
or unexecuted injection/timing checks remain NOT RUN and readiness stays uncertain.
This is not a claim that current runtime already satisfies these expectations.

| ID | Procedure and expected result | Status | Observation / issue |
| --- | --- | --- | --- |
| M14 | Set a one-minute budget, stay on synthetic work and let real wall time expire. Record start, expected deadline and actual alarm/lock time, including browser scheduling delay. Blank-budget session must not expire. Repeat through worker restart and OS idle/wake; record deviations rather than inventing an exact timing tolerance. | NOT RUN | |
| M15 | With a warn/unrelated synthetic page and recorded policy, remain actively browsing for at least 120 seconds of real dwell. Record observed 60-second/120-second behavior and lock timing; compare an aligned work page. No seeded dwell or clock jumps. If idle, restart active dwell measurement. | NOT RUN | |
| M16 | Override without marking related: confirm domain cooldown before five real minutes and fresh evaluation/lock after expiry. Separately mark related and wait beyond five minutes: it remains usable in the same session; a new session clears the correction and can lock immediately. Record timestamps and post-expiry navigation, not just a reload inside cooldown. | NOT RUN | |
| M17 | Turn off Enable behavior & time tracking while an overlay is active. It disappears; new navigation/activity does not append session events or initiate provider calls. Turn it on and verify resumption. Existing local history is not expected to be erased. | NOT RUN | |
| M18 | Go offline in the disposable profile with AI unconfigured; session UI and heuristic locks on available synthetic pages work without cloud access. In a separate QA run use only a non-forwarding loopback fake provider and synthetic credentials/text to test timeout, malformed JSON, 401/429/500 and recovery. Record errors, fallback behavior and usability; no real provider calls. | NOT RUN | |
| M19 | Inspect requests to that fake provider with synthetic URL path/query/fragment/credential markers. Browsing context should be origin-only, while declared intent is sent; verify fields and error/diagnostic redaction without assuming every field is safe. No production endpoints. Reset to an unconfigured fresh profile before pilot use. | NOT RUN | |
| M20 | Induce storage write failure while saving tracking, policy, starting/ending a session, and completing a lock transition. Each failure should be surfaced, controls recover or roll back, and UI must not claim persisted success. Record each operation and persisted state; retry safely. | NOT RUN | |
| M21 | Delete all data → Confirm delete within five seconds while a session/overlay is active. Confirm local/session state is cleared, overlay removed, and no old session/history/marks/locks/cooldowns/keys return after tabs/worker/browser restart. Record recreated defaults separately; blank storage immediately after deletion is insufficient evidence of durable deletion. | NOT RUN | |
| M22 | In independent disposable runs, race deletion against queued events, end-session/history writes, Settings saves, legacy synthetic key migration, and a delayed local fake-provider response. Release delayed work after deletion; old data must not return or initiate new requests. Repeat deletion during a storage failure and verify honest failure feedback. Record every subcase separately, NOT RUN if not induced. | NOT RUN | |
| M23 | Seed only synthetic expired history/diagnostics and entries beyond caps. Open history/report/diagnostics and compare UI filtering with actual storage pruning (30 days/100 sessions; 14 days/200 diagnostics). Record discrepancies; helpers do not prove all read paths persist pruning. | NOT RUN | |

Do not export participant or personal data. Inspect synthetic storage and local
fake-provider requests in the QA profile only. Current sanitizers retain some free
text and hostnames; “sanitized” is not “anonymous.” Deletion races and cross-context
writes require evidence, not guarantees inherited from 1.5.1 remediation documents.

## Run conclusion

Record passed / failed / not-run check counts and individual subcase results.
Any FAIL needs an issue and disposition; any required NOT RUN leaves acceptance
incomplete. Privacy/data-loss failures block pilot readiness. Manual result:
**NOT RUN**. No manual execution is claimed by this documentation change.
