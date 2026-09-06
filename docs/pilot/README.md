# Seven-day voluntary pilot preparation — 1.6.0

Status: **NOT RUN**. These documents prepare a study; they do not authorize
recruitment, messages, enrollment, telemetry, or data collection. No participants
or findings are represented here. Task 2 implementation is separate from review
approval and the decision to run a pilot.

## Purpose and prerequisites

Proposed audience: 5–8 adults doing ordinary knowledge work, including developers,
writers, researchers, and administrators. This is the default audience pending
an owner decision. Explore whether people can start independently, understand
locks, and find them useful over seven days. This small convenience pilot cannot
establish population effects, productivity gains, or causal behavior change.

Before any enrollment, the owner must explicitly confirm all of the following
in a private study setup record. Blank fields mean enrollment is not ready:

| Prerequisite | Confirmation |
| --- | --- |
| Accountable study owner and participant-facing contact route | Pending |
| Approved voluntary consent process and collection channel, including who can access notes | Pending |
| Exact build/commit, seven-day dates, audience and intended enrollment of 5–8 adults | Pending |
| Study-note retention: proposed 30 days after pilot end; exact deletion date and deletion responsibility | Pending |
| Withdrawal route using participant-held random code, including deletion of submitted notes | Pending |
| Manual acceptance results reviewed; no unresolved privacy/data-loss blockers | Pending |
| Separate authorization to enroll and collect optional feedback | Pending |

The owner has approved the **proposed** 30-day study-note retention for preparation;
confirm its implementation and dates before enrollment. Do not invent a contact
or silently choose email, a form, or a storage service. Keep completed records out
of this repository. No names, contact lists, employer identifiers, or code-to-name
mapping belong in study notes. A participant keeps a random code to request
withdrawal; explain that locating their notes may be impossible if they lose it.

## Data boundaries and participant control

Use a fresh, separate Chrome profile and the approved unpacked build. Optional AI
must remain unconfigured for the entire pilot: do not enter keys, save provider
settings, or connect a local model. There is no dedicated AI-off toggle to assume.
A blank API key alone does not disable a previously configured keyless local
provider; use the fresh profile. This pilot evaluates the default heuristic path.

Chrome grants access to HTTP and HTTPS pages broadly so IntentLock can observe
navigation/activity and place a blocking overlay. The manifest also requests tabs,
storage, idle, tabGroups, and alarms for tab/session handling, local data, idle
signals, grouping, and budgets. It replaces the new-tab page. These are broad
permissions, not access limited to a participant's chosen task.

Local extension data is separate from study notes. IntentLock stores active
session events and lock state locally, which can include URLs, plus intent,
reflections, completed-session history, domain summaries and diagnostics.
History sanitization removes event arrays but retains intent/reflection text and
hostnames. Retention helpers use 30 days/100 completed sessions and 14 days/200
diagnostic entries; these are not a promise of continuous background erasure or
zero local history. Browser-owned history is separate again. The study-note
30-day deadline does not control either kind of local/browser history.

The pilot adds no telemetry. All counts are optional participant-maintained local
notes, and any sharing is voluntary after consent. Do not collect names, raw
intent, URLs/domains, screenshots, recordings, exported history/diagnostics,
session logs, clipboard content, or sensitive work content. Do not copy reflection
text from the extension. Use generic workflow descriptions stripped of identifying
details, such as “a reference video was relevant to my task.” Sanitized text is
not guaranteed anonymous; participants may omit anything. No observation or
screen sharing is required, including during setup.

Participants may skip any question/day, withdraw without explanation or penalty,
or stop immediately. Uncheck **Enable behavior & time tracking** in Settings to
stop tracking; this does not erase existing history. They can also disable or
remove IntentLock at `chrome://extensions`. **Delete all data**, then **Confirm
delete** within five seconds, requests deletion of extension data. It does not
delete study notes or Chrome history. Ask the confirmed owner contact separately
to delete shared notes using the random code. The owner removes those notes and
recomputes affected summaries; do not promise removal from material already
irreversibly anonymized or shared. Do not publish participant material in this
pilot. On a suspected privacy/data-loss issue, stop use and pause the pilot;
describe the problem generically, without sending logs or the affected content.

## Seven-day procedure

1. **Day 1: unassisted setup and first session.** After confirmed consent, provide
   the approved build location and loading instructions: `chrome://extensions`
   → Developer mode → Load unpacked → select the approved folder. Let the
   participant use onboarding and attempt a first ordinary session without
   coaching. They choose an intent locally and an optional budget. Do not assign
   sensitive tasks or require triggering a lock. Afterwards ask whether installation
   and the first session succeeded independently, needed help, failed, or were
   not attempted. Help is allowed if requested; record assistance honestly.
2. **Days 2–6: ordinary work.** Participants choose when and whether to use the
   extension. No daily usage quota or forced distraction. Optionally make a short
   local entry with the [feedback template](feedback-template.md). A no-use day
   and an unanswered day are different. Do not send reminders under this preparation
   authorization. Optional counts should take roughly a minute, not create work.
3. **Day 7: reflection.** Offer the same template's closing questions through the
   confirmed channel only after collection is authorized. Participants decide what
   sanitized notes to share. Record desire to continue, usefulness, unexpected
   locks, missed drift, help needed, and disabling/withdrawal where voluntarily
   explained. Lack of a response is unknown, never a successful completion.

Calibration prompts are optional hypothetical discussions, not browsing tasks:
“Could a React tutorial on YouTube be relevant while learning React hooks?” and
“When might writing or research legitimately include documents, videos, forums,
or administrative pages?” Current heuristics can classify the React intent as
coding and block a useful video. Productivity-category alignment does not prove
that every document or writing/research detour is relevant. Ask what distinction
would matter; do not coach someone to rate a lock helpful or visit sensitive sites.

## Measures and decision rules

Definitions apply only to optionally reported observations. Count each distinct
lock episode once; reloading the same outstanding lock is not a new episode.

| Measure | Definition and denominator |
| --- | --- |
| Helpful lock (H) | Participant judged the interruption appropriate and useful for their intended work at that moment. A later override does not automatically make it wrong. |
| Wrong lock (W) | Participant judged the interruption inappropriate, such as blocking legitimate work or an unsuitable budget interruption. |
| Unjudged lock (U) | A noticed lock without a helpful/wrong judgment, including uncertainty or a correctly triggered but unhelpful lock the participant does not judge wrong. Note the latter separately as a subset of U, without double counting. |
| Judged-lock precision (participant-judged proxy) | H / (H + W). This is a participant-judged usefulness proxy, not classifier ground-truth precision. Exclude U; if H + W = 0, report unknown. Always show H, W, U, total reported locks H + W + U, judged denominator H + W, and judgment coverage (H + W) / (H + W + U). |
| Missed lock (M) | Participant noticed an episode of unwanted drift for which they expected an interruption but none occurred. Report separately; absence of a report does not mean zero misses. |
| Drift opportunities (O), optional | Separately counted distinct episodes judged by the participant to warrant interruption, with interrupted episodes (I) and missed episodes (M) on the same observation basis. Only if O = I + M is explicitly reported may I/O be described as self-reported opportunity coverage; do not label judged-lock precision as recall or infer O from H/W. |
| Task completion | Participant self-report: completed / partly completed / not completed / unknown. Completed sessions divided by sessions with an explicit completion response; report each other category and unanswered sessions separately. |
| Report viewing | Optional count of reports opened, separately reported. `reportViewed`, End session, and the “On-intent” heuristic score do not establish task completion. |
| Independent start | Participants who installed and started the first session without coaching / participants who attempted setup. Also report attempts / enrolled and all assistance, failures, unknowns. |
| Continuation | Explicit yes / all enrolled; show no, unsure and no response separately. No response is not “no,” but is not a “yes.” |

Do not treat skipped counts as zero or infer that all sessions/locks were observed.
Aggregate only disjoint daily entries; never add a week summary to its daily
counts. Show per-participant coverage alongside pooled precision so one heavy
user cannot conceal sparse evidence. No raw identifiers beyond random codes.
Pool a lock-count entry only when H, W and U are all explicitly supplied on the
same observation basis. Report excluded incomplete entries and their missing
fields separately; never fill them with zero. Approximate or selected-session
counts must stay labelled and separate from complete counts. If these omissions
could change the decision, mark it UNCERTAIN even when the numerical target passes.
For completion, show completed, partly completed, not completed and unknown counts;
the explicit-response denominator is the sum of the first three categories.

Provisional targets below are **not validated** and must be fixed before collection:

- Zero unresolved privacy or data-loss blockers, and all required manual acceptance
  checks passed. Unexecuted required checks mean the safety gate is unknown.
- All setup attempters can install and start their first session unassisted;
  disclose enrollment coverage and any non-attempts. Assistance/failure misses
  this target, even if the person later succeeds.
- At least 80% of judged locks helpful on this participant-judged proxy, not a
  classifier-accuracy claim. Report H/(H+W), H, W, U, total reported locks and
  judgment coverage together, plus unhelpful-but-not-wrong notes/counts within U.
  Do not selectively omit unjudged episodes to present the threshold as success.
- At least 60% of enrolled participants explicitly want to continue: 3/5, 4/6,
  5/7, or 5/8. Report the actual cohort denominator, never just respondents.

Minimum usable coverage, also provisional: at least five participants contribute
day-1 setup outcomes, day-7 responses, and at least three day-2–6 entries explicitly
stating use/no use. At least three participants contribute judged locks, at least
20 judged locks in total, and at least 70% of reported locks are judged. These
minimums support a limited next-step decision, not statistical validation. Fewer
locks may be a good experience but leave the precision decision uncertain.

**GO** means only consider another bounded pilot if every gate/target and coverage
minimum is met. **NO-GO** means pause for any unresolved privacy/data-loss blocker,
or revise and retest when sufficient evidence misses a target. **UNCERTAIN** means
missing required checks, inadequate coverage, or unresolved contradictory evidence;
do not silently extend collection. Report dropouts, disabled/uninstalled counts,
optional reasons, missing days and responses, and any changes to the protocol.

## Reusable records and evidence

- [Consent template](consent-template.md): confirm before any enrollment.
- [Feedback template](feedback-template.md): optional local notes and day-7 reflection.
- [Results template](results-template.md): starts NOT RUN; never prefill findings.
- [Manual acceptance](../manual-acceptance.md): separate synthetic QA and run records.
- [Browser journeys](../browser-journeys.md): actual automated assertions, limitations
  and historical Task 1 evidence. Browser mechanics are not participant evidence.

Before sharing, participants review their own text for identifying content. The
owner should retain only consented sanitized notes via the confirmed channel,
restrict access to the confirmed reviewers, and delete notes and derived records
by the confirmed 30-day deadline, including channel copies/backups as agreed.
If the channel cannot support that commitment, resolve it before enrollment.
