# Task 6 Report — Visual tokens, motion leftovers, copy

**Status:** Complete  
**Branch:** `sdd/task-6`  
**Commit:** `42b797f` — `fix: auto theme, shortcut copy, and leftover motion timing`  
**Date:** 2026-08-30

## What shipped

| Path | Action |
|------|--------|
| `fonts/*.woff2` + OFL texts | Bundled IBM Plex Mono Regular, Source Serif 4 Regular/Italic (OFL) |
| `newtab.css` | `@font-face`; overlay opacity class enter/exit; button `transform` in transition; 1px left rails; removed unused preset/plan/api-notice CSS |
| `newtab.js` | Auto theme via `matchMedia`; shortcuts sentence case + Mac `⌘`; `is-open` + 180ms overlay fallback |
| `options.js` | Auto theme adds `theme-dark` when OS dark; status `160ms ease-out`; no page opacity dim |
| `history.js` / `diagnostics.js` / `popup.js` / `analytics.js` | Same auto-theme `matchMedia` behavior |
| `onboarding.js` | Renamed `showStep3` → `showStep2` |
| `README.md` | First-run copy uses `Declare your intent.` |
| `scripts/package-release.mjs` + `tests/manifest-runtime.test.mjs` | Fonts allowlisted in `RUNTIME_FILES` / expected list |
| `tests/static-smoke.test.mjs` | TDD coverage for theme, shortcuts, README, motion, rails, fonts |

Version remains **1.6.0**. Lock (`body.intervention` / overlay) stays inverted.

## TDD

1. Added failing static-smoke tests for auto theme, shortcuts copy, README, overlay motion, status timing, rails, fonts, `showStep2`.
2. Implemented; `npm test` — **226 pass / 0 fail**.
3. `npm run package` — zip includes `fonts/*.woff2` and OFL texts.

## Concerns

- Content-script overlay still names VV families with system fallbacks; bundled `@font-face` applies to extension pages (newtab.css). WAR not added for in-page overlay font loading.
- Unused `@keyframes fadeIn` remains in `newtab.css` after overlays switched to class opacity.
- Auto theme does not listen for live `prefers-color-scheme` changes after first paint (applies on load / chip select).
