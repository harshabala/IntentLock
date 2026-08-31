# Final fix — Try-the-lock error and remaining lock jargon

**Status:** Complete  
**Branch:** `feat/first-run-and-polish`  
**Date:** 2026-08-31  
**Version:** 1.6.0 (unchanged)

## What shipped

| Path | Action |
|------|--------|
| `background.js` | `TEST_INTERVENTION` with no trackable http(s) tab returns `{ ok: false, error: 'Open a website first, then try the lock.' }` and does not create `about:blank`. |
| `popup.js` | Backoff notice uses `Local lock still active.` |
| `providers.js` | Quota backoff message uses the same product language. |
| `store/LISTING.md` + `docs/store-assets-plan.md` | Short description: `Local lock works with no API key.` Full description drops “heuristics”. |
| `tests/background.test.mjs` | Harness test: extension newtab only → error, no `about:blank`. |
| `tests/static-smoke.test.mjs` | Copy assertions for popup, providers, listing. |

## TDD

1. Failing tests: `TEST_INTERVENTION` returned `{ ok: true }` and listing/popup still said Heuristics.
2. Implement; `npm test` — **241 pass / 0 fail**.

Not pushed.
