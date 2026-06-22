// intervention-overlay.js — In-page shadow-DOM intervention UI

export function buildOverlayStyles() {
  return `
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      font-family: "SF Mono", "Fira Code", "JetBrains Mono", ui-monospace, monospace;
    }
    .backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.92);
    }
    .panel {
      position: relative;
      z-index: 1;
      max-width: 480px;
      margin: 10vh auto 0;
      padding: 48px 32px;
      color: #ffffff;
      text-align: center;
    }
    h1 {
      font-size: 1rem;
      font-weight: 600;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      margin: 0 0 16px;
    }
    .reason, .hint {
      color: #888888;
      font-size: 0.8rem;
      line-height: 1.6;
      margin: 0 0 16px;
    }
    .intent-box {
      border: 1px solid #222222;
      padding: 16px;
      margin: 24px 0;
      text-align: left;
    }
    .intent-label {
      font-size: 0.65rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: #9a9a9a;
      margin: 0 0 8px;
    }
    .intent-text {
      font-size: 0.85rem;
      line-height: 1.5;
      margin: 0;
      color: #ffffff;
    }
    label {
      display: block;
      text-align: left;
      font-size: 0.7rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 8px;
      color: #888888;
    }
    textarea {
      width: 100%;
      min-height: 96px;
      background: #111111;
      color: #ffffff;
      border: 1px solid #222222;
      border-radius: 2px;
      padding: 12px;
      font: inherit;
      resize: vertical;
      box-sizing: border-box;
      margin-bottom: 16px;
    }
    textarea:focus {
      outline: none;
      border-color: #ffffff;
    }
    .actions {
      display: flex;
      gap: 12px;
    }
    button {
      flex: 1;
      min-height: 44px;
      border-radius: 2px;
      font: inherit;
      font-size: 0.75rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      cursor: pointer;
    }
    .dismiss-btn {
      background: transparent;
      color: #888888;
      border: 1px solid #222222;
    }
    .override-btn {
      background: #ffffff;
      color: #000000;
      border: 1px solid #ffffff;
    }
  `;
}

export function createInterventionOverlay({ onOverride, onDismiss } = {}) {
  let host = null;
  let shadow = null;
  let reflectionInput = null;

  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'intentlock-intervention-host';
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = buildOverlayStyles();
    shadow.appendChild(style);

    const backdrop = document.createElement('div');
    backdrop.className = 'backdrop';

    const panel = document.createElement('div');
    panel.className = 'panel';
    panel.innerHTML = `
      <h1>Drift detected</h1>
      <p class="reason" data-role="reason"></p>
      <div class="intent-box">
        <p class="intent-label">Session intent</p>
        <p class="intent-text" data-role="intent"></p>
      </div>
      <label for="intentlock-reflection">Why are you deviating?</label>
    `;

    reflectionInput = document.createElement('textarea');
    reflectionInput.id = 'intentlock-reflection';
    reflectionInput.placeholder = 'I need a break, or this is actually relevant...';
    reflectionInput.setAttribute('autofocus', '');

    const actions = document.createElement('div');
    actions.className = 'actions';

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'dismiss-btn';
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', () => {
      hide();
      if (typeof onDismiss === 'function') onDismiss();
    });

    const overrideBtn = document.createElement('button');
    overrideBtn.type = 'button';
    overrideBtn.className = 'override-btn';
    overrideBtn.textContent = 'Override & continue';
    overrideBtn.addEventListener('click', () => {
      const reflection = reflectionInput.value.trim();
      if (!reflection) {
        reflectionInput.focus();
        return;
      }
      hide();
      if (typeof onOverride === 'function') onOverride(reflection);
    });

    actions.append(dismissBtn, overrideBtn);
    panel.append(reflectionInput, actions);
    shadow.append(backdrop, panel);
    document.documentElement.appendChild(host);
  }

  function show({ reason = 'You are deviating from your intent.', intent = '' } = {}) {
    ensureHost();
    const reasonEl = shadow.querySelector('[data-role="reason"]');
    const intentEl = shadow.querySelector('[data-role="intent"]');
    if (reasonEl) reasonEl.textContent = reason;
    if (intentEl) intentEl.textContent = intent || 'No active session intent.';
    reflectionInput.value = '';
    host.style.display = 'block';
    reflectionInput.focus();
  }

  function hide() {
    if (host) host.style.display = 'none';
  }

  function isVisible() {
    return Boolean(host && host.style.display !== 'none');
  }

  return { show, hide, isVisible };
}