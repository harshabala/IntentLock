# IntentLock Redesign — Remediation Report

## Skills Loaded
- [x] Design system / visual — impeccable + frontend-design (complete)
- [x] UI/UX review — product UX subagent (complete)
- [x] Copy/tone — UX writing subagent (complete)
- [x] Motion — Emil-primary motion audit (complete)
- [x] Accessibility — folded into visual + UX reviews (complete)
- [x] Detector CLI — impeccable detect.mjs (empty: markup is JS-built)

## Heuristic-by-heuristic

| H | Now | Spec + skill fix | Target |
|---|-----|------------------|--------|
| 1 | 3 | Kill “Generating plan…”; timer + lock reason stay | 4 |
| 2 | 2 | Plain English: intent type, how hard, on-intent time | 4 |
| 3 | 3 | Close this tab primary; continue gated on reflection | 4 |
| 4 | 1 | One token set; overlay inverted, pages white | 4 |
| 5 | 2 | Continue disabled until reflection; aria-invalid | 4 |
| 6 | 3 | Quoted intent on lock and active session | 4 |
| 7 | 2 | Declare = intent + optional minutes | 3 |
| 8 | 1 | White/black, no glass/glow/pulse | 4 |
| 9 | 2 | Visible error: “Write why, or close this tab.” | 4 |
| 10 | 2 | Welcome states the lock contract | 3 |

## Conflicts resolved (do not escalate)

1. **White pages vs black overlay.** Spec palette is white/black Visualized Value. Lock surfaces invert (black field, white hairlines, white marks). Pages do not try to look identical to the overlay in fill color.
2. **Declare is not Settings.** Keep declare on new-tab (`newtab.js` / `onboarding.js`). `options.html` stays policy, provider, privacy. Do not turn Options into a task form.
3. **Continue anyway gate.** Enable when the reflection textarea is non-empty. Do not add a 2s wait (fails a11y). Do not add a third “I understand” checkbox.
4. **Single stylesheet.** Keep `newtab.css` for extension pages. Do not add `options.css` / `popup.css`. Lock page uses `newtab.css` + `intervention.css`. Overlay styles live in `intervention-overlay.js` `buildOverlayStyles()`.
5. **Forbidden test word `patterns`.** Static smoke bans that string. Name decorative marks `vv-hatch`, `vv-grid`, `vv-chevron`.
6. **Analytics vs AGENTS.md.** Spec wants hierarchical stats: popup summary + dedicated page. Implement `analytics.html` for the full dashboard moved off the new-tab vow. Do not put week glance on the new-tab active session.

## Ready for Implementation
- [x] Yes, proceed to code
