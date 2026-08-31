# Chrome Web Store Assets Plan for IntentLock

Canonical listing copy lives in `store/LISTING.md`. This document retains the broader visual promotional plan for the IntentLock Chrome Web Store listing; prefer `store/LISTING.md` for paste-ready CWS fields.

## 1. Listing Metadata & Copy

### Single-Sentence Summary (Max 160 characters)
*Length: 110 characters — matches `store/LISTING.md` short description*
> Declare your intent. IntentLock watches your tabs and locks the page when you drift. Local lock works with no API key.

### Detailed Description
IntentLock enforces the browsing intent you declare before you start a session. Open a new tab, declare what you intend to do (optional time budget), and IntentLock watches your tabs. Local lock runs with no API key. If you drift, the page locks — reflect in writing to continue, or close the tab / end the session.

Local-only by default: session data stays on this device. No accounts, sync, telemetry, or habit dashboard. Optional AI is a second opinion only — configure a provider later in Settings if you want one.

**Key Features:**
- **Vow-only declare:** Intent plus optional minutes on new tab; no preset upsell on Lock in.
- **Local heuristics first:** Drift checks work with no API key.
- **Full-page lock:** Reflect to continue, or close the tab / end the session.
- **Timer and alarms:** Optional time budget with background alarms.
- **Week glance:** Compact popup summary plus dedicated analytics page.
- **Local history:** Bounded on-device session history; optional JSON export.
- **Optional AI:** Second-opinion LLM only when configured in Settings.

---

## 2. Promotional Tiles & Screenshots Plan

All screenshot assets are designed for **1280x800 px** dimensions, matching the VV dark-mode design with clean white monospace typography, bold green accents, and sharp geometric double-borders.

### Screenshot 1: Intent Declaration Form (New Tab Welcome)
- **Visual Description:** Shows the full-page welcome screen loaded on a fresh tab. A clean, retro-cyber terminal style input dominates the center: `"I intend to..."`.
- **Key Callouts:** "Set your target. Start your clock."
- **Layout details:** 
  - Centered box with double-border.
  - Large monospace text input.
  - Optional time budget input set to 25 minutes.

### Screenshot 2: Active Session Interface (Session Hub)
- **Visual Description:** Displays the active session control panel. Includes a prominent countdown timer, a log of visited URLs, and real-time session statistics.
- **Key Callouts:** "Live alignment statistics. Total page loads, tab switches, and drift events tracked completely offline."
- **Layout details:**
  - Timer box top left showing `14:52`.
  - Statistics table: "Page Loads: 8 | Tab Switches: 3 | Drift Events: 0".
  - Sidebar showing a list of recently visited paths.

### Screenshot 3: Full-Page Intervention Screen
- **Visual Description:** Illustrates the stark override block screen triggered when the user drifts onto a distraction site (e.g., social media). A prominent text terminal prompts the user to either reflect and return to their task, or provide a justification to override.
- **Key Callouts:** "Immediate cognitive friction. Justify drift to override or return to your declared task."
- **Layout details:**
  - Full-screen warning overlay with bold red border.
  - Left panel: "Current Intent: Writing code docs".
  - Right panel: Monospace textbox with justification prompt and "Return to task" vs "Submit Override (5-min cooldown)" buttons.

### Screenshot 4: Options & Settings
- **Visual Description:** Displays the extension options page with custom inputs for distraction domain lists, API key settings, and theme toggling.
- **Key Callouts:** "Complete control. Customize distraction domains, configure API endpoints, and export/delete logs locally."
- **Layout details:**
  - Left side: Input field for Distraction Domains (e.g., `reddit.com, twitter.com`).
  - Right side: OpenAI API Key input (explaining secure session storage), theme toggle button, and "Delete all local data" confirmation button.
