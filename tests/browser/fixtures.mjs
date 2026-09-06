import { test as base, expect, chromium } from '@playwright/test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionPath = fileURLToPath(new URL('../../', import.meta.url));
const hosts = new Set(['work.localhost', 'distraction.localhost', 'other.localhost']);

export const test = base.extend({
  journey: async ({}, use, testInfo) => {
    try {
      await access(chromium.executablePath());
    } catch {
      throw new Error('Test Chromium is missing. Run npm ci, then npx playwright install chromium. '
        + 'Use normal environment approval for installation. Browser journeys never silently skip.');
    }

    // A loopback-only synthetic HTTP server also acts as a deny-by-default proxy.
    // Nothing is forwarded. CONNECT is refused, including requests from the worker.
    const requests = [];
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (!hosts.has(url.hostname)) {
        requests.push({ blocked: true, host: url.hostname });
        res.writeHead(403).end('Only synthetic localhost fixtures are available.');
        return;
      }
      requests.push({ host: url.hostname, path: url.pathname });
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><html lang="en"><meta charset="utf-8">'
        + '<title>Synthetic browser journey</title><body><main>'
        + '<h1>Local test document</h1><label>Document <textarea id="document"></textarea></label>'
        + '<button id="work-action">Save local draft</button></main></body></html>');
    });
    server.on('connect', (req, socket) => {
      socket.on('error', () => {}); // Chromium can abandon a refused tunnel.
      requests.push({ blocked: true, host: req.url });
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    });
    const profile = await mkdtemp(join(tmpdir(), 'intentlock-browser-'));
    let context;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const port = server.address().port;
      context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium', headless: true, chromiumSandbox: true,
        timeout: 20_000, viewport: { width: 1280, height: 900 },
        reducedMotion: 'reduce',
        args: [
          `--disable-extensions-except=${extensionPath}`,
          `--load-extension=${extensionPath}`,
          `--proxy-server=http://127.0.0.1:${port}`,
          '--proxy-bypass-list=<-loopback>',
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
          '--disable-background-networking', '--disable-quic',
        ],
      });
      context.setDefaultTimeout(10_000);
      context.setDefaultNavigationTimeout(15_000);
      const worker = context.serviceWorkers()[0]
        || await context.waitForEvent('serviceworker', { timeout: 15_000 });
      const extensionId = new URL(worker.url()).host;
      expect(worker.url()).toBe(`chrome-extension://${extensionId}/background.js`);
      console.log(`Browser evidence: Chromium ${context.browser().version()}, ${process.platform}/${process.arch}, unpacked MV3 worker`);
      const errors = [];
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
      await use({
        context, worker, errors,
        extensionUrl: path => `chrome-extension://${extensionId}/${path}`,
        fixtureUrl: (host, path = '/') => `http://${host}:${port}${path}`,
        storage: () => worker.evaluate(() => chrome.storage.local.get(null)),
      });
      expect(errors, 'Uncaught extension/page JavaScript errors').toEqual([]);
      expect(requests.some(request => !request.blocked), 'A real local fixture was loaded').toBe(true);
    } finally {
      try {
        await testInfo.attach('local-network-audit', {
          body: JSON.stringify(requests, null, 2), contentType: 'application/json',
        });
        if (context && testInfo.status !== testInfo.expectedStatus) {
          for (const [index, page] of context.pages().entries()) {
            if (!page.isClosed()) {
              const screenshot = await page.screenshot({ timeout: 2000 }).catch(() => null);
              if (screenshot) await testInfo.attach(`failure-page-${index}`, {
                body: screenshot, contentType: 'image/png',
              });
            }
          }
        }
      } finally {
        try {
          await context?.close();
        } finally {
          server.closeAllConnections();
          await new Promise(resolve => server.close(resolve));
          await rm(profile, { recursive: true, force: true });
        }
      }
    }
  },
});
export { expect };

// The production overlay intentionally uses a CLOSED shadow root. CDP inspects
// that real DOM without replacing attachShadow or injecting a different overlay.
// Interaction uses browser mouse/keyboard events at the actual element bounds.
export async function closedOverlay(page) {
  const cdp = await page.context().newCDPSession(page);
  async function node(selector) {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    function find(current) {
      const attrs = current.attributes || [];
      const properties = Object.fromEntries(Array.from({ length: attrs.length / 2 },
        (_, i) => [attrs[i * 2], attrs[i * 2 + 1]]));
      if (selector.startsWith('#') ? properties.id === selector.slice(1)
        : (properties.class || '').split(' ').includes(selector.slice(1))) return current;
      for (const child of [...(current.children || []), ...(current.shadowRoots || [])]) {
        const match = find(child);
        if (match) return match;
      }
    }
    return find(root);
  }
  async function read(selector, expression) {
    const found = await node(selector);
    if (!found) return null;
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: found.backendNodeId });
    try {
      const { result } = await cdp.send('Runtime.callFunctionOn', {
        objectId: object.objectId, functionDeclaration: `function() { return ${expression}; }`,
        returnByValue: true,
      });
      return result.value;
    } finally {
      await cdp.send('Runtime.releaseObject', { objectId: object.objectId });
    }
  }
  return {
    read,
    async click(selector) {
      await expect.poll(async () => Boolean(await node(selector))).toBe(true);
      const found = await node(selector);
      const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: found.backendNodeId });
      const q = model.content;
      await page.mouse.click((q[0] + q[4]) / 2, (q[1] + q[5]) / 2);
    },
    close: () => cdp.detach(),
  };
}
