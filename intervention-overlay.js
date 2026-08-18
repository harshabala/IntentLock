// intervention-overlay.js — In-page shadow-DOM intervention UI
// The host contract is INTERVENTION_TRANSITION; content.js supplies the nonce-bound sender.

(function exposeInterventionOverlay(root) {
  function buildOverlayStyles() {
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
      max-height: 80vh;
      overflow-y: auto;
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
    button:focus-visible, textarea:focus-visible, input:focus-visible {
      outline: 2px solid #ffffff;
      outline-offset: 3px;
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
    .close-tab-btn {
      background: transparent;
      color: #888888;
      border: 1px solid #222222;
    }
    .override-btn {
      background: #ffffff;
      color: #000000;
      border: 1px solid #ffffff;
    }
    .end-session-btn {
      background: transparent;
      border: 1px solid #444;
      color: #888;
      padding: 8px 16px;
      cursor: pointer;
      font-size: 0.75rem;
      letter-spacing: 0.05em;
      margin-top: 4px;
    }
    .close-tab-btn:hover, .end-session-btn:hover {
      border-color: #666;
      color: #aaa;
    }
    .related-row {
      display: flex;
      align-items: center;
      gap: 8px;
      text-align: left;
      color: #888888;
      font-size: 0.7rem;
      margin-bottom: 16px;
    }
    .related-row input {
      width: 16px;
      height: 16px;
      margin: 0;
    }
    .error {
      min-height: 1.4em;
      color: #ff8f8f;
      font-size: 0.75rem;
      margin: 8px 0;
    }
    `;
  }

  function createInterventionOverlay({ onOverride, onEndSession, onCloseTab } = {}) {
    let host = null;
    let shadow = null;
    let reflectionInput = null;
    let markRelatedInput = null;
    let errorText = null;
    let currentState = null;
    let hostObserver = null;
    let lockedVisible = false;
    let currentReason = 'You are deviating from your intent.';
    let currentIntent = '';
    let repairing = false;
    let previousFocus = null;
    let inertNodes = [];
    let previousOverflow = '';
    let transitionInFlight = false;
    let transitionButtons = [];
    let rootVisibilitySnapshot = null;

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

    function setTransitionBusy(busy) {
      transitionInFlight = busy;
      transitionButtons.forEach((button) => {
        button.disabled = busy;
        button.setAttribute('aria-busy', String(busy));
      });
      if (reflectionInput) reflectionInput.disabled = busy;
      if (markRelatedInput) markRelatedInput.disabled = busy;
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
        const reasonEl = shadow?.querySelector('[data-role="reason"]');
        const intentEl = shadow?.querySelector('[data-role="intent"]');
        if (reasonEl) reasonEl.textContent = currentReason;
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

      const panel = document.createElement('div');
      panel.className = 'panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-labelledby', 'intentlock-intervention-title');
      panel.setAttribute('aria-describedby', 'intentlock-intervention-reason');
      panel.innerHTML = `
      <h1>Drift detected</h1>
      <p class="reason" id="intentlock-intervention-reason" data-role="reason"></p>
      <div class="intent-box">
        <p class="intent-label">Session intent</p>
        <p class="intent-text" data-role="intent"></p>
      </div>
      <label for="intentlock-reflection">Why are you deviating?</label>
      `;
      panel.querySelector('h1')?.setAttribute('id', 'intentlock-intervention-title');

      reflectionInput = document.createElement('textarea');
      reflectionInput.id = 'intentlock-reflection';
      reflectionInput.placeholder = 'I need a break, or this is actually relevant...';
      reflectionInput.setAttribute('autofocus', '');

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
      errorText.className = 'error';
      errorText.setAttribute('role', 'alert');

      const actions = document.createElement('div');
      actions.className = 'actions';

      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'close-tab-btn';
      dismissBtn.textContent = 'Close tab';
      const overrideBtn = document.createElement('button');
      overrideBtn.type = 'button';
      overrideBtn.className = 'override-btn';
      overrideBtn.textContent = 'Override & continue';
      overrideBtn.addEventListener('click', () => {
        if (transitionInFlight) return;
        const reflection = reflectionInput.value.trim();
        if (!reflection) {
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
        const endBtn = document.createElement('button');
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
        transitionButtons = [dismissBtn, overrideBtn, endBtn];
      } else {
        transitionButtons = [dismissBtn, overrideBtn];
      }

      dismissBtn.addEventListener('click', () => {
        if (transitionInFlight) return;
        setTransitionBusy(true);
        Promise.resolve(typeof onCloseTab === 'function' ? onCloseTab(currentState) : null)
          .catch((error) => setError(error.message || 'Unable to close this lock.'))
          .finally(() => setTransitionBusy(false));
      });

      panel.append(reflectionInput, relatedRow, errorText, actions);
      shadow.append(backdrop, panel);
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

    function show({ reason = 'You are deviating from your intent.', intent = '', state = null } = {}) {
      ensureHost();
      currentState = state;
      currentReason = reason;
      currentIntent = intent;
      previousFocus = document.activeElement;
      const reasonEl = shadow.querySelector('[data-role="reason"]');
      const intentEl = shadow.querySelector('[data-role="intent"]');
      if (reasonEl) reasonEl.textContent = reason;
      if (intentEl) intentEl.textContent = intent || 'No active session intent.';
      reflectionInput.value = '';
      if (markRelatedInput) markRelatedInput.checked = false;
      if (errorText) errorText.textContent = '';
      setTransitionBusy(false);
      setPageInteractionBlocked(true);
      lockedVisible = true;
      enforceDocumentRootVisibility();
      enforceHostVisibility();
      reflectionInput.focus();
    }

    function hide() {
      lockedVisible = false;
      setTransitionBusy(false);
      setPageInteractionBlocked(false);
      if (host) host.style.setProperty('display', 'none', 'important');
      restoreDocumentRootVisibility();
      if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus();
      previousFocus = null;
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
