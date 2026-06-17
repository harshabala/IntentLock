# Chrome Web Store Assets Plan for IntentLock

This document details the metadata copy and visual promotional plan for the IntentLock listing on the Chrome Web Store.

## 1. Listing Metadata & Copy

### Single-Sentence Summary (Max 160 characters)
*Length: 139 characters*
> Keep your browsing aligned with your goals. Declare your intent, set a time budget, and get real-time local and LLM drift interventions.

### Detailed Description
IntentLock is a minimalist, privacy-first tool designed to combat passive browsing and distraction loops. By prompting you to declare a specific task before opening a new tab, IntentLock acts as a cognitive speed bump to keep you focused.

**Key Features:**
- **Stark VV Styling:** A high-contrast, distraction-free aesthetic with monospace typography and sharp geometric borders.
- **Timer and Alarms:** Explicit session time limits with automatic background alarms to keep you on schedule.
- **Tab Grouping:** Automatic consolidation of session-related tabs to organize workspace and prevent visual clutter.
- **Local Heuristics & LLM Check:** Hybrid analysis that runs lightning-fast local keyword checks alongside direct LLM evaluation when a drift occurs.
- **Local History Export:** Save your session history locally, and export all intent data as structured JSON files.
- **Secure Session Memory:** All keys are kept in secure session storage (`chrome.storage.session`) and cleared automatically when you close the browser.

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
