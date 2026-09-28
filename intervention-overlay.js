// intervention-overlay.js — In-page shadow-DOM intervention UI
// The host contract is INTERVENTION_TRANSITION; content.js supplies the nonce-bound sender.

(function exposeInterventionOverlay(root) {
  const DRIFT_COPY = 'You are drifting from your intent.';
  const TIME_BUDGET_COPY = 'Time budget exceeded.';
  const CONTINUE_HINT_ID = 'intentlock-continue-hint';

  // What each way out actually does, so the choice is informed.
  const DRIFT_EXPLANATION = 'Continue anyway allows this site for 5 minutes. '
    + 'Tick "related" to allow it for the rest of this session. Your time budget runs separately.';
  const BUDGET_EXPLANATION = 'Your time budget has run out. Continuing does not add time; '
    + 'end the session when you are done.';

  function lockExplanation(reason) {
    return reason === TIME_BUDGET_COPY ? BUDGET_EXPLANATION : DRIFT_EXPLANATION;
  }

  function lockHeading(reason) {
    return reason === TIME_BUDGET_COPY ? TIME_BUDGET_COPY : DRIFT_COPY;
  }

  function buildOverlayStyles() {
    const monoRegular = chrome.runtime.getURL('fonts/IBMPlexMono-Regular.woff2');
    const serifRegular = chrome.runtime.getURL('fonts/SourceSerif4-Regular.woff2');
    const serifItalic = chrome.runtime.getURL('fonts/SourceSerif4-Italic.woff2');
    return `
    @font-face {
      font-family: "IBM Plex Mono";
      src: url("${monoRegular}") format("woff2");
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: "Source Serif 4";
      src: url("${serifRegular}") format("woff2");
      font-weight: 400;
      font-style: normal;
      font-display: swap;
    }
    @font-face {
      font-family: "Source Serif 4";
      src: url("${serifItalic}") format("woff2");
      font-weight: 400;
      font-style: italic;
      font-display: swap;
    }
    :host {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      font-family: "IBM Plex Mono", ui-monospace, "SF Mono", monospace;
      --bg-white: #ffffff;
      --fg-black: #000000;
      --muted-black: #1a1a1a;
      --line-width: 1px;
      --corner-radius: 2px;
      --bg: #000000;
      --fg: #ffffff;
      --muted: #e6e6e6;
      --line: #ffffff;
      --surface: #000000;
      --error: #ffffff;
      --success: #ffffff;
      -webkit-font-smoothing: antialiased;
    }
    .backdrop {
      position: absolute;
      inset: 0;
      background: var(--bg);
    }
    .panel {
      position: relative;
      z-index: 1;
      max-width: 480px;
      max-height: 80vh;
      overflow-y: auto;
      margin: 10vh auto 0;
      padding: 48px 32px;
      background-color: var(--bg);
      color: var(--fg);
      text-align: left;
      border: var(--line-width) solid var(--line);
      border-radius: var(--corner-radius);
      opacity: 0;
      transform: scale(0.98);
      transition: opacity 160ms ease-out, transform 160ms ease-out;
    }
    .panel.is-in {
      opacity: 1;
      transform: scale(1);
    }
    .vv-hatch {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='12'%3E%3Cpath d='M0 12L20 0' stroke='rgba(255,255,255,0.06)' stroke-width='1' fill='none'/%3E%3C/svg%3E");
      background-size: 20px 12px;
    }
    @keyframes overlayEnter {
      from { opacity: 0; transform: scale(0.98); }
      to { opacity: 1; transform: scale(1); }
    }
    h1 {
      font-family: "Source Serif 4", "Iowan Old Style", Palatino, Georgia, serif;
      font-size: 18px;
      font-weight: 400;
      line-height: 1.35;
      margin: 0 0 12px;
      color: var(--fg);
    }
    .reason, .hint {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.6;
      margin: 0 0 16px;
    }
    .intent-quote {
      font-family: "Source Serif 4", "Iowan Old Style", Palatino, Georgia, serif;
      font-size: 16px;
      font-weight: 400;
      line-height: 1.35;
      margin: 0 0 16px;
      color: var(--fg);
    }
    label {
      display: block;
      text-align: left;
      font-size: 12px;
      margin-bottom: 8px;
      color: var(--muted);
    }
    textarea {
      width: 100%;
      min-height: 96px;
      background: var(--bg);
      color: var(--fg);
      border: var(--line-width) solid var(--line);
      border-radius: var(--corner-radius);
      padding: 12px;
      font: inherit;
      resize: vertical;
      box-sizing: border-box;
      margin-bottom: 16px;
    }
    textarea:focus {
      outline: 2px solid var(--fg);
      outline-offset: 2px;
    }
    button:focus-visible, textarea:focus-visible, input:focus-visible {
      outline: 2px solid var(--fg);
      outline-offset: 3px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
    }
    button {
      flex: 1 1 calc(50% - 6px);
      width: auto;
      max-width: 100%;
      min-height: 44px;
      border-radius: var(--corner-radius);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: color 160ms ease-out, background-color 160ms ease-out, border-color 160ms ease-out, transform 160ms ease-out;
    }
    button:hover {
      background-color: var(--bg);
      color: var(--fg);
      border-color: var(--fg);
    }
    button:active {
      transform: translateY(1px);
    }
    .btn--primary,
    .close-tab-btn {
      background: var(--fg);
      color: var(--bg);
      border: var(--line-width) solid var(--fg);
    }
    .btn--primary:hover,
    .close-tab-btn:hover {
      background: var(--bg);
      color: var(--fg);
    }
    .btn--ghost,
    .override-btn {
      background: transparent;
      color: var(--fg);
      border: var(--line-width) solid var(--line);
    }
    .btn--ghost:hover,
    .override-btn:hover {
      background: var(--fg);
      color: var(--bg);
      border-color: var(--fg);
    }
    .end-session-btn {
      flex: 1 1 100%;
      background: transparent;
      border: none;
      color: var(--fg);
      text-decoration: underline;
      text-underline-offset: 0.2em;
      padding: 8px 16px;
      cursor: pointer;
      font-size: 12px;
      min-height: 44px;
    }
    .end-session-btn:hover {
      background: transparent;
      color: var(--fg);
    }
    button:disabled,
    button[aria-disabled="true"] {
      opacity: 0.4;
      cursor: not-allowed;
      transform: none;
    }
    .related-row {
      display: flex;
      align-items: center;
      gap: 8px;
      text-align: left;
      color: var(--muted);
      font-size: 12px;
      min-height: 44px;
      margin-bottom: 16px;
    }
    .related-row input {
      width: 18px;
      height: 18px;
      margin: 0;
    }
    .error {
      min-height: 1.4em;
      color: var(--fg);
      font-size: 12px;
      margin: 8px 0;
    }
    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        animation: none !important;
        transition: none !important;
      }
      .panel,
      .panel.is-in {
        opacity: 1;
        transform: none;
      }
    }
    `;
  }

  function createInterventionOverlay({ onOverride, onEndSession, onCloseTab } = {}) {
    let host = null;
    let shadow = null;
    let panelEl = null;
    let reflectionInput = null;
    let markRelatedInput = null;
    let errorText = null;
    let overrideBtn = null;
    let dismissBtn = null;
    let endBtn = null;
    let currentState = null;
    let hostObserver = null;
    let lockedVisible = false;
    let currentReason = DRIFT_COPY;
    let currentIntent = '';
    let repairing = false;
    let previousFocus = null;
    let inertNodes = [];
    let previousOverflow = '';
    let transitionInFlight = false;
    let rootVisibilitySnapshot = null;
    let hideFinishTimer = null;
    let hideEndHandler = null;

    function enforceDocumentRootVisibility() {
      const rootElement = document.documentElement;
      if (!lockedVisible || !rootElement) return;
      if (!rootVisibilitySnapshot) {
        rootVisibilitySnapshot = {
          styles: ['display', 'visibility', 'opacity', 'pointer-events'].map((property) => ({
            property,
            value: rootElement.style.getPropertyValue(property),
            priority: rootElement.style.getPropertyPriority(property),
          })),
          hidden: rootElement.hidden,
          ariaHidden: rootElement.getAttribute('aria-hidden'),
        };
      }
      rootElement.style.setProperty('display', 'block', 'important');
      rootElement.style.setProperty('visibility', 'visible', 'important');
      rootElement.style.setProperty('opacity', '1', 'important');
      rootElement.style.setProperty('pointer-events', 'auto', 'important');
      rootElement.hidden = false;
      rootElement.removeAttribute('aria-hidden');
    }

    function restoreDocumentRootVisibility() {
      const rootElement = document.documentElement;
      if (!rootElement || !rootVisibilitySnapshot) return;
      rootVisibilitySnapshot.styles.forEach(({ property, value, priority }) => {
        if (value) rootElement.style.setProperty(property, value, priority);
        else rootElement.style.removeProperty(property);
      });
      rootElement.hidden = rootVisibilitySnapshot.hidden;
      if (rootVisibilitySnapshot.ariaHidden === null) rootElement.removeAttribute('aria-hidden');
      else rootElement.setAttribute('aria-hidden', rootVisibilitySnapshot.ariaHidden);
      rootVisibilitySnapshot = null;
    }

    function prefersReducedMotion() {
      try {
        return Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
      } catch {
        return false;
      }
    }

    function syncContinueEnabled() {
      const hasWhy = Boolean(reflectionInput?.value.trim());
      if (overrideBtn) {
        overrideBtn.disabled = transitionInFlight;
        overrideBtn.setAttribute('aria-busy', String(transitionInFlight));
        if (!hasWhy) {
          overrideBtn.setAttribute('aria-describedby', CONTINUE_HINT_ID);
          overrideBtn.setAttribute('aria-disabled', 'true');
        } else {
          overrideBtn.removeAttribute('aria-describedby');
          overrideBtn.removeAttribute('aria-disabled');
        }
      }
    }

    function setHeading(reason) {
      const title = shadow?.querySelector('#intentlock-intervention-title');
      if (title) title.textContent = lockHeading(reason);
    }

    function setReasonDisplay(reason) {
      const reasonEl = shadow?.querySelector('[data-role="reason"]');
      if (!reasonEl) return;
      const heading = lockHeading(reason);
      const text = reason && reason !== heading ? reason : '';
      reasonEl.textContent = text;
      reasonEl.hidden = !text;
      const explainEl = shadow?.querySelector('[data-role="explanation"]');
      if (explainEl) explainEl.textContent = lockExplanation(reason);
    }

    function setTransitionBusy(busy) {
      transitionInFlight = busy;
      [dismissBtn, endBtn].forEach((button) => {
        if (!button) return;
        button.disabled = busy;
        button.setAttribute('aria-busy', String(busy));
      });
      if (reflectionInput) reflectionInput.disabled = busy;
      if (markRelatedInput) markRelatedInput.disabled = busy;
      syncContinueEnabled();
    }

    function focusableElements() {
      return Array.from(shadow?.querySelectorAll('button, textarea, input, [tabindex]:not([tabindex="-1"])') || [])
        .filter((element) => !element.disabled && element.offsetParent !== null);
    }

    function onKeyDown(event) {
      if (event.key !== 'Tab') return;
      const elements = focusableElements();
      if (elements.length === 0) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      const active = shadow.activeElement || document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    function setPageInteractionBlocked(blocked) {
      if (!document.body) return;
      if (blocked) {
        if (!lockedVisible) {
          inertNodes = Array.from(document.body.children).filter((node) => node !== host);
          inertNodes.forEach((node) => { node.inert = true; });
          previousOverflow = document.documentElement.style.overflow;
        }
        document.documentElement.style.overflow = 'hidden';
      } else {
        inertNodes.forEach((node) => { node.inert = false; });
        inertNodes = [];
        document.documentElement.style.overflow = previousOverflow;
      }
    }

    function enforceHostVisibility() {
      if (!host || !lockedVisible) return;
      if (host.style.getPropertyValue('display') !== 'block') {
        host.style.setProperty('display', 'block', 'important');
      }
      if (host.style.getPropertyValue('visibility') !== 'visible') {
        host.style.setProperty('visibility', 'visible', 'important');
      }
      if (host.style.getPropertyValue('opacity') !== '1') {
        host.style.setProperty('opacity', '1', 'important');
      }
      if (host.style.getPropertyValue('pointer-events') !== 'auto') {
        host.style.setProperty('pointer-events', 'auto', 'important');
      }
      host.hidden = false;
      host.removeAttribute('aria-hidden');
    }

    function repairHost() {
      if (!lockedVisible || repairing || !host) return;
      repairing = true;
      try {
        if (!host.isConnected || host.parentNode !== document.documentElement) {
          document.documentElement.appendChild(host);
        }
        enforceDocumentRootVisibility();
        enforceHostVisibility();
        setHeading(currentReason);
        setReasonDisplay(currentReason);
        const intentEl = shadow?.querySelector('[data-role="intent"]');
        if (intentEl) intentEl.textContent = currentIntent || 'No active session intent.';
      } finally {
        repairing = false;
      }
    }

    function ensureHost() {
      if (host) return;
      host = document.createElement('div');
      host.id = 'intentlock-intervention-host';
      // Keep page scripts from clearing or replacing the lock contents.
      shadow = host.attachShadow({ mode: 'closed' });

      const style = document.createElement('style');
      style.textContent = buildOverlayStyles();
      shadow.appendChild(style);

      const backdrop = document.createElement('div');
      backdrop.className = 'backdrop';

      panelEl = document.createElement('div');
      panelEl.className = 'panel vv-hatch';
      panelEl.setAttribute('role', 'dialog');
      panelEl.setAttribute('aria-modal', 'true');
      panelEl.setAttribute('aria-labelledby', 'intentlock-intervention-title');
      panelEl.setAttribute('aria-describedby', 'intentlock-intervention-reason intentlock-intervention-explanation');
      panelEl.innerHTML = `
      <h1>You are drifting from your intent.</h1>
      <p class="reason" id="intentlock-intervention-reason" data-role="reason"></p>
      <p class="intent-quote" data-role="intent"></p>
      <p class="hint" id="intentlock-intervention-explanation" data-role="explanation"></p>
      <label for="intentlock-reflection">Why?</label>
      `;
      panelEl.querySelector('h1')?.setAttribute('id', 'intentlock-intervention-title');

      reflectionInput = document.createElement('textarea');
      reflectionInput.id = 'intentlock-reflection';
      reflectionInput.placeholder = 'Enter why this page, given your intent.';
      reflectionInput.maxLength = 2000;
      reflectionInput.setAttribute('autofocus', '');
      reflectionInput.addEventListener('input', () => {
        if (errorText?.textContent) errorText.textContent = '';
        if (reflectionInput.value.trim()) {
          reflectionInput.setAttribute('aria-invalid', 'false');
        }
        syncContinueEnabled();
      });

      const relatedRow = document.createElement('label');
      relatedRow.className = 'related-row';
      relatedRow.htmlFor = 'intentlock-mark-related';
      markRelatedInput = document.createElement('input');
      markRelatedInput.type = 'checkbox';
      markRelatedInput.id = 'intentlock-mark-related';
      const relatedText = document.createElement('span');
      relatedText.textContent = 'This site is related to my intent';
      relatedRow.append(markRelatedInput, relatedText);

      errorText = document.createElement('p');
      errorText.id = 'transition-error';
      errorText.className = 'error';
      errorText.setAttribute('role', 'alert');
      errorText.setAttribute('aria-live', 'polite');

      const continueHint = document.createElement('p');
      continueHint.id = CONTINUE_HINT_ID;
      continueHint.className = 'hint';
      continueHint.textContent = 'Write why to continue.';

      const actions = document.createElement('div');
      actions.className = 'actions';

      dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'close-tab-btn btn--primary';
      dismissBtn.textContent = 'Close this tab';
      overrideBtn = document.createElement('button');
      overrideBtn.type = 'button';
      overrideBtn.className = 'override-btn btn--ghost';
      overrideBtn.textContent = 'Continue anyway';
      overrideBtn.setAttribute('aria-describedby', CONTINUE_HINT_ID);
      overrideBtn.setAttribute('aria-disabled', 'true');
      overrideBtn.addEventListener('click', () => {
        if (transitionInFlight) return;
        const reflection = reflectionInput.value.trim();
        if (!reflection) {
          reflectionInput.setAttribute('aria-invalid', 'true');
          setError('Write why, or close this tab.');
          reflectionInput.focus();
          return;
        }
        if (typeof onOverride === 'function') {
          setTransitionBusy(true);
          Promise.resolve(onOverride({
              reflection,
              markRelated: Boolean(markRelatedInput?.checked),
              state: currentState,
            }))
            .catch((error) => setError(error.message || 'Unable to continue.'))
            .finally(() => setTransitionBusy(false));
        }
      });

      actions.append(dismissBtn, overrideBtn);

      if (typeof onEndSession === 'function') {
        endBtn = document.createElement('button');
        endBtn.type = 'button';
        endBtn.className = 'end-session-btn';
        endBtn.textContent = 'End session';
        endBtn.addEventListener('click', () => {
          if (transitionInFlight) return;
          setTransitionBusy(true);
          Promise.resolve(onEndSession(currentState))
            .catch((error) => setError(error.message || 'Unable to end the session.'))
            .finally(() => setTransitionBusy(false));
        });
        actions.appendChild(endBtn);
      }

      dismissBtn.addEventListener('click', () => {
        if (transitionInFlight) return;
        setTransitionBusy(true);
        Promise.resolve(typeof onCloseTab === 'function' ? onCloseTab(currentState) : null)
          .catch((error) => setError(error.message || 'Unable to close this lock.'))
          .finally(() => setTransitionBusy(false));
      });

      panelEl.append(reflectionInput, relatedRow, errorText, continueHint, actions);
      shadow.append(backdrop, panelEl);
      shadow.addEventListener('keydown', onKeyDown);
      document.documentElement.appendChild(host);
      if (typeof MutationObserver === 'function') {
        hostObserver = new MutationObserver(() => {
          repairHost();
        });
        hostObserver.observe(document.documentElement, {
          childList: true,
          attributes: true,
          attributeFilter: ['style', 'hidden', 'class', 'aria-hidden'],
        });
        hostObserver.observe(host, {
          attributes: true,
          attributeFilter: ['style', 'hidden', 'class', 'aria-hidden'],
        });
      }
    }

    function cancelHideAnimation() {
      if (hideFinishTimer) {
        clearTimeout(hideFinishTimer);
        hideFinishTimer = null;
      }
      if (hideEndHandler && panelEl) {
        panelEl.removeEventListener('transitionend', hideEndHandler);
        panelEl.removeEventListener('animationend', hideEndHandler);
        hideEndHandler = null;
      }
    }

    function finishHide() {
      cancelHideAnimation();
      if (host && !lockedVisible) host.style.setProperty('display', 'none', 'important');
      restoreDocumentRootVisibility();
      if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus();
      previousFocus = null;
    }

    function show({ reason = DRIFT_COPY, intent = '', state = null } = {}) {
      ensureHost();
      cancelHideAnimation();
      currentState = state;
      currentReason = reason;
      currentIntent = intent;
      previousFocus = document.activeElement;
      setHeading(reason);
      setReasonDisplay(reason);
      const intentEl = shadow.querySelector('[data-role="intent"]');
      if (intentEl) intentEl.textContent = intent || 'No active session intent.';
      reflectionInput.value = '';
      reflectionInput.removeAttribute('aria-invalid');
      if (markRelatedInput) markRelatedInput.checked = false;
      if (errorText) errorText.textContent = '';
      setTransitionBusy(false);
      setPageInteractionBlocked(true);
      lockedVisible = true;
      enforceDocumentRootVisibility();
      enforceHostVisibility();
      panelEl?.classList.remove('is-in');
      const enter = () => {
        if (!lockedVisible) return;
        panelEl?.classList.add('is-in');
      };
      if (prefersReducedMotion()) {
        enter();
      } else if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(enter);
      } else {
        enter();
      }
      reflectionInput.focus();
    }

    function hide() {
      lockedVisible = false;
      setTransitionBusy(false);
      setPageInteractionBlocked(false);
      panelEl?.classList.remove('is-in');
      if (!host) {
        restoreDocumentRootVisibility();
        previousFocus = null;
        return;
      }
      if (prefersReducedMotion() || !panelEl) {
        finishHide();
        return;
      }
      hideEndHandler = (event) => {
        if (event.target !== panelEl) return;
        finishHide();
      };
      panelEl.addEventListener('transitionend', hideEndHandler);
      panelEl.addEventListener('animationend', hideEndHandler);
      hideFinishTimer = setTimeout(finishHide, 180);
    }

    function isVisible() {
      return Boolean(host && lockedVisible && host.style.display !== 'none');
    }

    function setError(message) {
      ensureHost();
      if (errorText) errorText.textContent = message || 'Unable to update the lock.';
      if (isVisible()) reflectionInput?.focus();
    }

    return { show, hide, isVisible, setError };
  }

  function getNamespace() {
    if (!('IntentLock' in root)) {
      if (!Object.isExtensible(root)) {
        throw new Error('global object must be extensible to create IntentLock');
      }
      Object.defineProperty(root, 'IntentLock', {
        configurable: true,
        enumerable: true,
        value: {},
        writable: true,
      });
    }

    if (root.IntentLock === null || typeof root.IntentLock !== 'object' || Array.isArray(root.IntentLock)) {
      throw new Error('IntentLock global must be an object');
    }
    return root.IntentLock;
  }

  function exposeApi(property, api) {
    const namespace = getNamespace();
    if (property in namespace) {
      throw new Error(`IntentLock.${property} is already defined`);
    }
    if (!Object.isExtensible(namespace)) {
      throw new Error('IntentLock global must be extensible');
    }
    Object.defineProperty(namespace, property, {
      configurable: false,
      enumerable: true,
      value: api,
      writable: false,
    });
  }

  exposeApi('interventionOverlay', {
    buildOverlayStyles,
    createInterventionOverlay,
  });
}(globalThis));
