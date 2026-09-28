import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadClassicScript } from './helpers/load-classic-script.mjs';
import { createOverlayDocument } from './helpers/overlay-dom.mjs';

const chrome = {
  runtime: {
    getURL: (path) => `chrome-extension://mock/${path}`,
  },
};

const overlayRuntime = await loadClassicScript(new URL('../intervention-overlay.js', import.meta.url), {
  chrome,
});
const { buildOverlayStyles, createInterventionOverlay } = overlayRuntime.IntentLock.interventionOverlay;

test('buildOverlayStyles includes core intervention layout rules', () => {
  const css = buildOverlayStyles();
  assert.match(css, /\.panel|\.override-btn/);
  assert.match(css, /z-index:\s*2147483647/);
  assert.match(css, /flex:\s*1 1 calc\(50% - 6px\)/);
  assert.match(css, /\.end-session-btn[\s\S]*flex:\s*1 1 100%/);
});

test('buildOverlayStyles loads packaged fonts via chrome.runtime.getURL', () => {
  const css = buildOverlayStyles();
  assert.match(css, /@font-face/);
  assert.match(css, /chrome-extension:\/\/mock\/fonts\/IBMPlexMono-Regular\.woff2/);
  assert.match(css, /chrome-extension:\/\/mock\/fonts\/SourceSerif4-Regular\.woff2/);
  assert.match(css, /chrome-extension:\/\/mock\/fonts\/SourceSerif4-Italic\.woff2/);
  assert.match(css, /font-family:\s*"IBM Plex Mono"/);
  assert.match(css, /font-family:\s*"Source Serif 4"/);
});

test('overlay styles include overlayEnter 160ms and no infinite animation', () => {
  const css = buildOverlayStyles();
  assert.match(css, /overlayEnter/);
  assert.match(css, /160ms/);
  assert.match(css, /scale\(0\.98\)/);
  assert.equal(/\binfinite\b/.test(css), false);
  const isIn = css.match(/\.panel\.is-in\s*\{([^}]+)\}/);
  assert.ok(isIn, '.panel.is-in block required');
  assert.doesNotMatch(isIn[1], /animation:\s*overlayEnter/);
});

test('classic overlay script exposes its factory through the narrow global API', () => {
  assert.equal(typeof createInterventionOverlay, 'function');
});

test('createInterventionOverlay accepts onEndSession callback', () => {
  let called = false;
  // The factory function signature should accept onEndSession without throwing
  assert.doesNotThrow(() => {
    createInterventionOverlay({ onEndSession: () => { called = true; } });
  });
});

test('creating overlay does not throw', () => {
  assert.doesNotThrow(() => createInterventionOverlay({
    onOverride() {},
    onCloseTab() {},
    onEndSession() {},
  }));
});

function extractNamedFunction(src, name) {
  const start = src.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} must exist`);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`could not extract ${name}`);
}

test('overlay continue empty path does not set aria-invalid until empty Continue click', async () => {
  const src = await readFile(new URL('../intervention-overlay.js', import.meta.url), 'utf8');
  const sync = extractNamedFunction(src, 'syncContinueEnabled');
  assert.doesNotMatch(sync, /aria-invalid/);
  assert.match(src, /if\s*\(!reflection\)\s*\{[\s\S]*?setAttribute\(['"]aria-invalid['"],\s*['"]true['"]\)/);
  const inputHandler = src.match(/addEventListener\(['"]input['"],\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*\)/);
  assert.ok(inputHandler, 'reflection input handler required');
  assert.match(
    inputHandler[0],
    /setAttribute\(['"]aria-invalid['"],\s*['"]false['"]\)|removeAttribute\(['"]aria-invalid['"]\)/,
  );
});

test('empty Continue click on overlay DOM sets aria-invalid and does not override', async () => {
  const { document, MutationObserver, matchMedia } = createOverlayDocument();
  const runtime = await loadClassicScript(new URL('../intervention-overlay.js', import.meta.url), {
    chrome,
    document,
    MutationObserver,
    matchMedia,
  });
  const { createInterventionOverlay: createOverlay } = runtime.IntentLock.interventionOverlay;
  let overrideCalls = 0;
  const overlay = createOverlay({
    onOverride() {
      overrideCalls += 1;
    },
    onCloseTab() {},
    onEndSession() {},
  });
  overlay.show({ reason: 'You are drifting from your intent.', intent: 'Write the tests' });

  const host = document.getElementById('intentlock-intervention-host');
  assert.ok(host, 'show() must attach the overlay host');
  const shadow = host.__shadow;
  assert.ok(shadow, 'overlay host must expose a testable shadow root');
  const textarea = shadow.querySelector('#intentlock-reflection');
  const overrideBtn = shadow.querySelector('.override-btn');
  const errorText = shadow.querySelector('#transition-error');
  assert.ok(textarea && overrideBtn && errorText);

  assert.notEqual(textarea.getAttribute('aria-invalid'), 'true');
  assert.equal(overrideBtn.disabled, false, 'Continue must stay clickable when why is empty');
  overrideBtn.click();

  assert.equal(textarea.getAttribute('aria-invalid'), 'true');
  assert.equal(errorText.textContent, 'Write why, or close this tab.');
  assert.equal(overrideCalls, 0);
  assert.equal(document.activeElement, textarea);
});

test('overlay hide timeout is 180ms and host uses page tokens', async () => {
  const css = buildOverlayStyles();
  const src = await readFile(new URL('../intervention-overlay.js', import.meta.url), 'utf8');
  assert.match(css, /--bg-white:\s*#ffffff/);
  assert.match(css, /--fg-black:\s*#000000/);
  assert.match(css, /-webkit-font-smoothing:\s*antialiased/);
  assert.match(css, /vv-hatch/);
  assert.match(css, /text-underline-offset:\s*0\.2em/);
  assert.match(css, /\.related-row input[\s\S]*width:\s*18px/);
  const buttonBlock = css.match(/\n\s*button\s*\{([^}]+)\}/);
  assert.ok(buttonBlock, 'overlay button styles required');
  assert.match(buttonBlock[1], /transform/);
  assert.match(css, /button:hover|button:active/);
  assert.match(src, /setTimeout\(finishHide,\s*180\)/);
  assert.match(src, /Time budget exceeded\./);
  assert.match(src, /Write why to continue\./);
  assert.match(src, /maxLength\s*=\s*2000|setAttribute\(['"]maxlength['"],\s*['"]2000['"]\)/i);
});

test('classic overlay refuses a pre-existing global API property', async () => {
  await assert.rejects(
    loadClassicScript(new URL('../intervention-overlay.js', import.meta.url), {
      IntentLock: { interventionOverlay: { occupied: true } },
    }),
    /IntentLock\.interventionOverlay is already defined/,
  );
});

test('the lock explains what each way out does, including budget expiry', async () => {
  const { document, MutationObserver, matchMedia } = createOverlayDocument();
  const runtime = await loadClassicScript(new URL('../intervention-overlay.js', import.meta.url), {
    chrome, document, MutationObserver, matchMedia,
  });
  const overlay = runtime.IntentLock.interventionOverlay.createInterventionOverlay({
    onOverride() {}, onCloseTab() {}, onEndSession() {},
  });
  overlay.show({ reason: "You've spent a long time on an unrelated site.", intent: 'Write the tests' });
  const shadow = document.getElementById('intentlock-intervention-host').__shadow;
  const explanation = shadow.querySelector('[data-role="explanation"]');
  assert.match(explanation.textContent, /5 minutes/);
  assert.match(explanation.textContent, /rest of this session/);
  assert.match(explanation.textContent, /time budget runs separately/);
  overlay.show({ reason: 'Time budget exceeded.', intent: 'Write the tests' });
  assert.match(explanation.textContent, /budget has run out/);
});
