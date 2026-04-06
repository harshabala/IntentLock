# AGENTS.md — IntentLock

## 1. Project Overview

IntentLock is a browser extension that enforces user-declared intent during browsing sessions.

Core principle:
Users explicitly declare what they intend to do before opening a tab.
The system monitors behavior and intervenes if the user deviates.

This is a behavioral enforcement product, not just a productivity tool.

---

## 2. Core User Flow

1. User opens a new tab
2. System intercepts and blocks default browsing
3. User must:
   - Enter intent (free text)
   - Set optional time budget (minutes)

4. System performs:
   - Intent interpretation via LLM
   - Optional retrieval from user knowledge sources (notes, docs)

5. Session begins:
   - Track browsing behavior (URLs, time, activity)

6. Intervention triggers:
   - Time budget exceeded
   - Behavioral drift detected

7. Intervention UI:
   - Full-page takeover
   - Ask: “You are deviating from your intent. Why?”

8. User must:
   - Reflect OR override explicitly

---

## 3. Key Concepts

- Intent: user-declared goal for the session
- Session: bounded browsing period
- Drift: mismatch between intent and behavior
- Lock: enforced interruption requiring user acknowledgement

---

## 4. System Architecture

### Frontend (Extension)
- New Tab Override
- Content Script (page monitoring)
- Background Service Worker

### Backend (Optional)
- LLM orchestration
- Embeddings / retrieval (user knowledge)
- Session storage

### Core Modules

1. Intent Engine
   - Parses user input
   - Classifies task type
   - Generates plan / expectations

2. Drift Detection Engine
   Inputs:
   - URL patterns
   - Time spent
   - Interaction signals

   Output:
   - Drift score (0–1)

3. Intervention Engine
   - Triggers lock state
   - Generates reflection prompt

---

## 5. Drift Detection Logic (V1)

Heuristic + LLM hybrid

### Heuristics:
- URL mismatch vs intent keywords
- Time spent on unrelated domains
- Tab switching frequency

### LLM Check:
Input:
- Intent
- Current URL
- Browsing history (last N actions)

Output:
- Is user aligned? (yes/no)
- Confidence score

---

## 6. Intervention Rules

Trigger intervention when ANY:

- Time > budget
- Drift score > threshold (e.g., 0.7)
- Explicit user idle + context switch

Intervention must:
- Block UI completely
- Require user input before continuing

---

## 7. LLM Usage

### Use cases:
1. Intent parsing
2. Plan generation (optional)
3. Drift classification
4. Reflection prompt generation

### Constraints:
- Responses must be concise
- No motivational fluff
- Tone: firm, reflective

---

## 8. UX Rules

- No passive notifications
- Only decisive interruptions
- Force intentionality

Language examples:
- “What are you trying to achieve?”
- “You are drifting from your intent.”
- “Continue anyway?”

---

## 9. Data Model

### Session
- id
- intent
- start_time
- time_budget
- events[]

### Event
- timestamp
- url
- action_type

---

## 10. Privacy Constraints

- Do NOT store browsing data permanently by default
- All tracking must be transparent
- User must be able to:
  - disable tracking
  - delete session data

---

## 11. Non-Goals (V1)

- No social features
- No gamification
- No rewards system
- No complex analytics dashboard

Focus ONLY on behavior correction

---

## 12. Engineering Constraints

- Must work as Chrome extension (MV3)
- Minimal latency (<200ms for checks)
- LLM calls must be async + cached

---

## 13. Success Criteria

- User reduces time spent on non-intended browsing
- User completes declared tasks more frequently
- Low override rate over time

---

## 14. Failure Modes to Avoid

- Over-triggering interventions → user churn
- Under-triggering → no value
- Vague intent parsing → poor drift detection
- Slow UI → user bypass

---

## 15. Future Extensions (NOT V1)

- Knowledge graph integration
- Habit tracking
- Multi-session analytics
- Cross-device sync
