# IntentLock v1.5.1 manual acceptance

Run these checks in a clean Chrome profile with the unpacked extension loaded from the repository. Record pass/fail and the Chrome version used.

## Session and intervention flow

1. Open a new tab, declare a short intent, and start a session. Confirm the active-session state appears without a console error.
2. Browse to a clearly unrelated HTTP(S) page, then use Settings → Test intervention. Confirm the in-page lock appears on the page and the page cannot be clicked, scrolled, or dismissed through Escape.
3. On the in-page lock, tab through the controls. Focus stays inside the lock, the reason is announced, and reduced-motion mode removes entrance/pulse animation when the OS prefers reduced motion.
4. Submit an empty reflection. Confirm the transition does not happen and the input receives focus. Submit a reflection with “This site is related…” checked; confirm the page continues only after the background transition succeeds.
5. Reload the locked page and restart the service worker if possible. Confirm the nonce-bound lock rehydrates and stale or copied transition messages are rejected.
6. Choose Close tab. Confirm the tab closes only after the background transition succeeds. Simulate/inspect a `tabs.remove` failure and confirm the lock remains actionable with an error.
7. Force fallback mode by denying content-script delivery or using an unsupported page. Confirm `intervention.html` has a modal role, labelled heading/reason, keyboard focus trap, and the same reflection/override/end-session behavior.
8. Open two tabs during one session and trigger locks independently. Confirm each tab has its own lock state and nonce; acting in one tab does not unlock the other.
9. Double-click each lock action and submit the reflection twice quickly. Confirm only one transition is sent and controls expose a busy/disabled state until it resolves.
10. Resize the viewport to a narrow/mobile width and zoom to 200%. Confirm the in-page panel scrolls and every action remains reachable.

## Tracking, privacy, and deletion

1. Turn tracking off while a session and lock are active. Confirm tracking stops, the lock disappears, idle metadata and intervention state are removed, and no provider request is made.
2. Turn tracking back on with the same active session. Confirm tracking resumes without requiring a new session.
3. Configure a cloud provider and verify that only the provider request receives the declared intent and origin-only context; query strings, paths, fragments, and credentials are absent from prompts and diagnostics.
4. Add an old history entry and an old diagnostic entry, open the history/report/diagnostics views, and confirm expired entries are pruned from storage as well as from the UI. Confirm the newest history entries are retained when the cap is exceeded.
5. Use Delete all data and confirm the service worker owns the clear operation: local and session storage are empty afterward, provider defaults are not recreated, active locks close, and subsequent queued writes do not restore deleted sessions or diagnostics.
6. Export history and diagnostics. Confirm session events and full URLs are absent, override records contain hostnames only, secret-shaped values are redacted, and report metrics such as aligned/alignedMs remain available.
7. Simulate a storage write failure while changing the tracking toggle. Confirm the toggle rolls back and an accessible error is announced.

## Regression checks

- Run `npm test`.
- Run `npm run verify:static`.
- Run `npm run validate:version -- v1.5.1`.
- Run `npm run package` twice and confirm the ZIP hashes match and contain only the runtime allowlist.
- Confirm fallback end-session close failure leaves a clear session-ended state with a usable manual-close path.
