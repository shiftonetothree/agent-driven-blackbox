/**
 * Driver layer: launches the app and exposes a uniform page interface.
 *
 * Two drivers implement the same surface:
 *
 *   playwright  The primary driver. `_electron.launch()` gives real user input
 *               (locators, auto-waiting, actionability checks), main-process
 *               evaluation, tracing and video - without patching the app.
 *   cdp         The fallback. Hand-rolled DevTools Protocol over Node's built-in
 *               WebSocket, used when playwright-core is unavailable (the harness
 *               must still run before `npm install` has ever succeeded) and for
 *               adapters Playwright cannot launch, such as a dev-server script.
 *
 * Probes are written against the uniform surface, so they behave identically on
 * both. Capability differences are exposed explicitly (`page.hasLocators`) rather
 * than silently degrading.
 */
import { join } from 'node:path';
import { attachPage, browserVersion, CdpConnection, listTargets, sleep } from './cdp.mjs';
import { buildEnv, buildSpawn, ensureDir } from './util.mjs';

/** Shared DOM fingerprint: a structural view of the rendered page. */
export const DOM_FINGERPRINT_EXPRESSION = `(() => {
  const text = (document.body?.innerText ?? '').replace(/\\s+/g, ' ').trim();
  const counts = {};
  for (const el of document.querySelectorAll('*')) {
    const tag = el.tagName.toLowerCase();
    counts[tag] = (counts[tag] ?? 0) + 1;
  }
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    textLength: text.length,
    textSample: text.slice(0, 400),
    textHash: [...text].reduce((h, c) => ((h * 31 + c.charCodeAt(0)) >>> 0), 7).toString(16),
    elementCount: document.querySelectorAll('*').length,
    tagCounts: counts,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    visibleErrors: [...document.querySelectorAll('[class*=error],[class*=Error]')].slice(0, 5).map(e => (e.textContent ?? '').trim().slice(0, 200)),
    hasAppRoot: Boolean(document.querySelector('#root,#app,#__next,[data-reactroot]')),
  };
})()`;

export function isDevtoolsUrl(url = '') {
  return url.startsWith('devtools://') || url.startsWith('chrome-extension://') || url === 'about:blank';
}

// ---------------------------------------------------------------------------
// stray asynchronous failures
// ---------------------------------------------------------------------------

/**
 * Playwright's launcher tears down its own connection when it gives up, and the
 * resulting rejection is not always the promise the caller awaited. Without this
 * guard a 60-second failed launch attempt surfaces as an unhandled rejection and
 * kills the whole test run before the fallback drivers ever get a chance.
 *
 * Only failures that are recognisably Playwright's are swallowed, and they are
 * recorded so a run can report that a driver attempt was abandoned rather than
 * silently pretending nothing happened.
 */
export const strayAsyncFailures = [];

function looksLikePlaywrightFailure(value) {
  const text = `${value?.stack ?? ''}${value?.message ?? ''}${String(value)}`;
  return /playwright|_ProgressController|DispatcherConnection|electronApplication/i.test(text);
}

let guardInstalled = false;
export function installStrayRejectionGuard() {
  if (guardInstalled) return;
  guardInstalled = true;
  process.on('unhandledRejection', (reason) => {
    if (!looksLikePlaywrightFailure(reason)) return;
    strayAsyncFailures.push(reason?.message ?? String(reason));
  });
}

// ---------------------------------------------------------------------------
// Playwright driver
// ---------------------------------------------------------------------------

class PlaywrightPage {
  constructor(page, index) {
    this.raw = page;
    this.index = index;
    this.driver = 'playwright';
    this.hasLocators = true;
    this.consoleEvents = [];
    this._errors = [];
    this.failedRequests = [];
    this.attached = false;
  }

  /** Uncaught page errors, in the same shape the CDP driver reports. */
  get errors() {
    return this._errors;
  }

  /** Subscribe to console / error / network events. */
  attachRecorders() {
    if (this.attached) return;
    this.attached = true;
    this.raw.on('console', (message) => {
      this.consoleEvents.push({
        type: message.type(),
        text: message.text(),
        location: message.location(),
      });
    });
    this.raw.on('pageerror', (error) => {
      this._errors.push({ text: error.message, stack: error.stack ?? '', name: error.name });
    });
    this.raw.on('requestfailed', (request) => {
      this.failedRequests.push({
        url: request.url(),
        method: request.method(),
        errorText: request.failure()?.errorText ?? 'unknown',
        resourceType: request.resourceType(),
        canceled: (request.failure()?.errorText ?? '').includes('ERR_ABORTED'),
      });
    });
  }

  get target() {
    return { title: this._title ?? '', url: this._url ?? '', type: 'page' };
  }

  async refreshTarget() {
    this._title = await this.raw.title().catch(() => '');
    this._url = this.raw.url();
    return this.target;
  }

  async title() {
    return await this.raw.title();
  }

  async url() {
    return this.raw.url();
  }

  async evaluate(expression, arg) {
    if (typeof expression === 'function') return await this.raw.evaluate(expression, arg);
    return await this.raw.evaluate(new Function(`return (${expression})`));
  }

  async evaluateString(expression) {
    return await this.raw.evaluate(expression);
  }

  async screenshot(options = {}) {
    return await this.raw.screenshot({ type: 'png', fullPage: options.fullPage === true });
  }

  async domFingerprint() {
    return await this.raw.evaluate(DOM_FINGERPRINT_EXPRESSION);
  }

  async waitForSelector(selector, { timeout = 15000, state = 'visible' } = {}) {
    await this.raw.locator(selector).first().waitFor({ state, timeout });
    return true;
  }

  async click(selector, { timeout = 15000 } = {}) {
    await this.raw.locator(selector).first().click({ timeout });
    return true;
  }

  async fill(selector, text, { timeout = 15000 } = {}) {
    await this.raw.locator(selector).first().fill(text ?? '', { timeout });
    return true;
  }

  async press(selector, key, { timeout = 15000 } = {}) {
    const locator = selector ? this.raw.locator(selector).first() : this.raw.locator(':root');
    await locator.press(key, { timeout });
    return true;
  }

  async textContent(selector) {
    return await this.raw.locator(selector).first().innerText();
  }

  async reload() {
    await this.raw.reload({ waitUntil: 'load', timeout: 30000 });
    return true;
  }

  /**
   * Wait for the window to finish its first render.
   *
   * Load state alone is not enough for a single-page app: `load` fires before the
   * framework paints. Text content is a good proxy for "there is something to look
   * at", but it is not required - a canvas or image-only UI legitimately has none.
   */
  async waitForSettled({ timeoutMs = 30000 } = {}) {
    const started = Date.now();
    await this.raw.waitForLoadState('load', { timeout: timeoutMs }).catch(() => {});
    try {
      await this.raw.waitForFunction(
        () => document.readyState === 'complete' && (document.body?.innerText ?? '').trim().length > 0,
        undefined,
        { timeout: Math.max(1500, timeoutMs - (Date.now() - started)) },
      );
    } catch {
      // Empty text is not an error here; the visual probe reports on it separately.
    }
    return Date.now() - started;
  }

  async content() {
    return await this.raw.content();
  }
}

// ---------------------------------------------------------------------------
// CDP driver page (fallback)
// ---------------------------------------------------------------------------

class CdpPage {
  constructor(session, index) {
    this.session = session;
    this.index = index;
    this.driver = 'cdp';
    this.hasLocators = false;
    this.consoleEvents = session.consoleEvents;
    this.failedRequests = session.failedRequests;
  }

  /** Uncaught exceptions, read live from the underlying session. */
  get errors() {
    return this.session.exceptions.map((e) => ({
      text: e.text,
      stack: Array.isArray(e.stack) ? e.stack.join('\n') : String(e.stack ?? ''),
      name: 'UncaughtError',
      url: e.url,
      line: e.line,
    }));
  }

  /** Kept for interface parity with the Playwright page. */
  syncErrors() {}

  get target() {
    return this.session.target;
  }

  async refreshTarget() {
    return this.target;
  }

  async title() {
    return await this.session.evaluate('document.title').catch(() => '');
  }

  async url() {
    return this.session.target.url;
  }

  async evaluate(expression, arg) {
    if (typeof expression === 'function') {
      const source = expression.toString();
      return await this.session.evaluate(`(${source})(${JSON.stringify(arg ?? null)})`);
    }
    return await this.session.evaluate(expression);
  }

  async evaluateString(expression) {
    return await this.session.evaluate(expression);
  }

  async screenshot(options = {}) {
    return await this.session.screenshot({ fullPage: options.fullPage === true });
  }

  async domFingerprint() {
    return await this.session.evaluate(DOM_FINGERPRINT_EXPRESSION);
  }

  /** No auto-waiting available: poll in-page, like the locator would. */
  async waitForSelector(selector, { timeout = 15000 } = {}) {
    return await this.session.evaluate(`(async () => {
      const deadline = Date.now() + ${timeout};
      while (Date.now() < deadline) {
        if (document.querySelector(${JSON.stringify(selector)})) return true;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('timeout waiting for ' + ${JSON.stringify(selector)});
    })()`, { timeoutMs: timeout + 5000 });
  }

  async click(selector) {
    return await this.session.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('no element matches ' + ${JSON.stringify(selector)});
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`);
  }

  /** Set the value through the native setter so React/Vue see the change. */
  async fill(selector, text) {
    return await this.session.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('no element matches ' + ${JSON.stringify(selector)});
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value')?.set;
      if (setter) setter.call(el, ${JSON.stringify(text ?? '')});
      else el.value = ${JSON.stringify(text ?? '')};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  }

  async press(selector, key) {
    return await this.session.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)}) ?? document.activeElement ?? document.body;
      const init = { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', init));
      el.dispatchEvent(new KeyboardEvent('keyup', init));
      return true;
    })()`);
  }

  async textContent(selector) {
    return await this.session.evaluate(`(document.querySelector(${JSON.stringify(selector)}) ?? document.body).innerText`);
  }

  async reload() {
    await this.session.connection.send('Page.reload', { ignoreCache: false }, { timeoutMs: 30000 });
    await sleep(2500);
    this.syncErrors();
    return true;
  }

  /** Poll in-page until the document is complete and has rendered text. */
  async waitForSettled({ timeoutMs = 30000 } = {}) {
    const started = Date.now();
    try {
      await this.session.evaluate(`(async () => {
        const deadline = Date.now() + ${timeoutMs};
        while (Date.now() < deadline) {
          if (document.readyState === 'complete' && (document.body?.innerText ?? '').trim().length > 0) return 'complete-with-text';
          await new Promise(r => setTimeout(r, 150));
        }
        return document.readyState;
      })()`, { timeoutMs: timeoutMs + 5000 });
    } catch {
      // Same reasoning as the Playwright driver: empty text is reported by the probe.
    }
    return Date.now() - started;
  }

  async content() {
    return await this.session.evaluate('document.documentElement.outerHTML');
  }
}

// ---------------------------------------------------------------------------
// launcher
// ---------------------------------------------------------------------------

/** Import playwright-core's Electron driver, or return null when unavailable. */
export async function loadPlaywright() {
  const bundle = await loadPlaywrightBundle();
  return bundle.electron;
}

/**
 * Import both Playwright entry points the harness needs.
 *
 * `electron` drives the app directly and requires the main-process Node inspector.
 * `chromium` connects to an already-running app over CDP, which is the only option
 * for packaged builds whose fuses disable that inspector.
 */
export async function loadPlaywrightBundle() {
  try {
    const module = await import('playwright-core');
    return { electron: module._electron ?? null, chromium: module.chromium ?? null };
  } catch {
    return { electron: null, chromium: null };
  }
}

/**
 * Launch via Playwright, trying each flag set until the app is usable.
 *
 * `appTarget` is what Playwright should run: the project directory for a source
 * checkout, or nothing for an already-packaged executable.
 */
export async function launchWithPlaywright({
  playwright,
  executablePath,
  appTarget = null,
  label,
  argSets,
  launchDir,
  config,
  extraArgs = [],
  env = {},
  timeoutMs = 60000,
  onAttempt = () => {},
}) {
  installStrayRejectionGuard();
  const attempts = [];
  for (const [index, argSet] of argSets.entries()) {
    const userDataDir = await ensureDir(join(launchDir, `userdata-${index}`));
    const args = [
      ...(appTarget ? [appTarget] : []),
      ...argSet.args,
      `--user-data-dir=${userDataDir}`,
      '--remote-allow-origins=*',
      ...extraArgs,
    ];

    const started = Date.now();
    let app = null;
    let closed = false;
    let stdout = '';
    let stderr = '';
    // Playwright demands the main-process Node inspector. When a build disables it
    // (Electron Forge's fuses commonly do), `launch` never settles and only gives up
    // at this timeout - so keep it short and let the CDP-based rungs take over.
    const attemptTimeout = config.playwrightLaunchTimeoutMs ?? Math.min(timeoutMs, 25000);
    try {
      app = await playwright.launch({
        executablePath,
        args,
        cwd: appTarget ? undefined : launchDir,
        env: buildEnv(config, env),
        timeout: attemptTimeout,
      });
    } catch (error) {
      attempts.push({
        label: argSet.label ?? (argSet.args.join(' ') || 'default'),
        args: argSet.args,
        reachedReady: false,
        crashKind: `launch-failed: ${firstLine(error.message)}`,
        exitCode: null,
        durationMs: Date.now() - started,
      });
      onAttempt(attempts.at(-1));
      continue;
    }

    const process_ = app.process();
    process_?.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    process_?.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    // Wait for the first real window, not just for the process to exist.
    let firstPage = null;
    try {
      firstPage = await app.firstWindow({ timeout: Math.min(timeoutMs, 45000) });
    } catch {
      firstPage = app.windows()[0] ?? null;
    }

    if (!firstPage) {
      const exitCode = app.process()?.exitCode ?? null;
      const crashed = exitCode !== null && exitCode !== 0;
      attempts.push({
        label: argSet.label ?? (argSet.args.join(' ') || 'default'),
        args: argSet.args,
        reachedReady: false,
        crashKind: crashed ? classifyExit(exitCode) : 'no-window',
        exitCode,
        durationMs: Date.now() - started,
      });
      onAttempt(attempts.at(-1));
      await app.close().catch(() => {});
      continue;
    }

    // Let the window settle enough for a first paint before recording events.
    await firstPage.waitForLoadState('domcontentloaded').catch(() => {});

    const pages = [];
    for (const [pageIndex, raw] of app.windows().entries()) {
      const wrapper = new PlaywrightPage(raw, pageIndex);
      wrapper.attachRecorders();
      await wrapper.refreshTarget();
      pages.push(wrapper);
    }

    const attempt = {
      label: argSet.label ?? (argSet.args.join(' ') || 'default'),
      args: argSet.args,
      reachedReady: true,
      crashKind: null,
      exitCode: null,
      durationMs: Date.now() - started,
    };
    attempts.push(attempt);
    onAttempt(attempt);

    // Capture engine versions from the main process so the report can name them.
    let engine = null;
    try {
      const versions = await app.evaluate(() => ({
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        v8: process.versions.v8,
      }));
      engine = { Browser: `Electron/${versions.electron} Chrome/${versions.chrome}`, ...versions };
    } catch {}

    return {
      ok: true,
      driver: 'playwright',
      app,
      pages,
      attempts,
      argSet,
      stdout,
      stderr,
      version: engine,
      mainEvaluate: async (fn, arg) => await app.evaluate(fn, arg),
      windowCount: async () => app.windows().length,
      refreshPages: async () => {
        const current = app.windows();
        while (pages.length < current.length) {
          const wrapper = new PlaywrightPage(current[pages.length], pages.length);
          wrapper.attachRecorders();
          await wrapper.refreshTarget();
          pages.push(wrapper);
        }
        for (const page of pages) await page.refreshTarget();
        return pages;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        // Capture the process handle before closing: `app.process()` is not valid
        // once the Electron application has been disposed.
        const handle = app.process();
        const pid = handle?.pid;
        // Bound the graceful close. An Electron app with a tray icon, a background
        // service or a `before-quit` handler that cancels can simply never honour
        // `app.quit()`, and Playwright then waits forever for the process to exit -
        // which stalls the whole run before its report is written. Force-kill the
        // tree afterwards regardless of whether the graceful path returned.
        await Promise.race([
          app.close().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, config.appCloseTimeoutMs ?? 8000)),
        ]);
        if (pid) await killTree(pid);
        releaseChild(handle);
      },
    };
  }

  return { ok: false, driver: 'playwright', attempts, pages: [], mainEvaluate: async () => null, close: async () => {} };
}

/**
 * Launch by spawning Electron ourselves and attaching over the DevTools Protocol.
 * Used for dev-server scripts and as the fallback when Playwright is unavailable.
 */
export async function launchWithCdp({
  command,
  baseArgs = [],
  cwd,
  label,
  argSets,
  launchDir,
  config,
  extraArgs = [],
  env = {},
  timeoutMs = 60000,
  cdpPortBase = config.ports.cdp,
  inspectPortBase = config.ports.inspect,
  onAttempt = () => {},
  viaScript = false,
  /**
   * When provided, renderer pages are driven through Playwright's
   * `chromium.connectOverCDP` instead of the built-in protocol client. This is the
   * only way to get Playwright's locators on a packaged app whose build disables the
   * Node CLI inspect fuse - Playwright's own `_electron.launch` needs that inspector
   * and will time out forever without it.
   */
  playwrightChromium = null,
}) {
  const { spawn } = await import('node:child_process');
  const attempts = [];

  for (const [index, argSet] of argSets.entries()) {
    const cdpPort = cdpPortBase + index;
    const inspectPort = inspectPortBase + index;
    const userDataDir = await ensureDir(join(launchDir, `userdata-${index}`));
    const args = [
      ...baseArgs,
      ...argSet.args,
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${cdpPort}`,
      `--inspect=${inspectPort}`,
      '--remote-allow-origins=*',
      ...extraArgs,
    ];

    const started = Date.now();
    const spec = buildSpawn(command, args);
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: buildEnv(config, env),
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: spec.verbatim,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let exitCode = null;
    let exited = false;
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
    });
    child.on('error', () => {
      exited = true;
    });

    const deadline = Date.now() + timeoutMs;
    let version = null;
    while (Date.now() < deadline) {
      if (exited) break;
      try {
        version = await browserVersion(cdpPort, 2000);
        break;
      } catch {
        await sleep(250);
      }
    }

    if (!version) {
      await sleep(400);
      await killTree(child.pid);
      releaseChild(child);
      const attempt = {
        label: argSet.label ?? (argSet.args.join(' ') || 'default'),
        args: argSet.args,
        reachedReady: false,
        crashKind: exited ? classifyExit(exitCode) : 'no-cdp-endpoint',
        exitCode: exited ? exitCode : null,
        durationMs: Date.now() - started,
        cdpPort,
      };
      attempts.push(attempt);
      onAttempt(attempt, { stdout, stderr });
      continue;
    }

    const targets = (await waitForTargets(cdpPort, {
      timeoutMs: Math.max(5000, timeoutMs - (Date.now() - started)),
      predicate: (list) => list.some((t) => t.type === 'page'),
    })) ?? [];

    let pages = [];
    let cdpBrowser = null;
    let closed = false;

    // Preferred: drive the pages with Playwright over the DevTools endpoint.
    if (playwrightChromium) {
      try {
        cdpBrowser = await playwrightChromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 30000 });
        const live = cdpBrowser.contexts().flatMap((context) => context.pages());
        for (const raw of live) {
          const wrapper = new PlaywrightPage(raw, pages.length);
          wrapper.attachRecorders();
          await wrapper.refreshTarget();
          pages.push(wrapper);
        }
      } catch (error) {
        log_warn(`connectOverCDP failed (${firstLine(error.message)}); using the built-in protocol client`);
        cdpBrowser = null;
        pages = [];
      }
    }

    if (pages.length === 0) {
      for (const target of targets.filter((t) => t.type === 'page' || t.type === 'webview')) {
        const session = await attachPage(target);
        if (session) pages.push(new CdpPage(session, pages.length));
      }
    }

    const driverName = cdpBrowser ? 'playwright-cdp' : 'cdp';

    let mainSession = null;
    try {
      const inspectorTargets = await listTargets(inspectPort, 3000);
      const nodeTarget = inspectorTargets.find((t) => t.webSocketDebuggerUrl);
      if (nodeTarget) mainSession = await CdpConnection.connect(nodeTarget.webSocketDebuggerUrl);
    } catch {
      // Optional: the renderer probes still run without main-process access. Packaged
      // builds that disable the Node CLI inspect fuse never expose this.
    }

    const attempt = {
      label: argSet.label ?? (argSet.args.join(' ') || 'default'),
      args: argSet.args,
      reachedReady: true,
      crashKind: null,
      exitCode: null,
      durationMs: Date.now() - started,
      cdpPort,
      inspectPort,
    };
    attempts.push(attempt);
    onAttempt(attempt, { stdout, stderr });

    return {
      ok: true,
      driver: driverName,
      child,
      pages,
      attempts,
      argSet,
      stdout,
      stderr,
      cdpPort,
      inspectPort,
      version: version ? { Browser: version.Browser, protocolVersion: version['Protocol-Version'] } : null,
      mainEvaluate: async (fn, arg) => {
        if (!mainSession) throw new Error('main-process inspector is not available for this launch (the build may disable the Node CLI inspect fuse)');
        const source = typeof fn === 'function' ? `(${fn.toString()})(${JSON.stringify(arg ?? null)})` : String(fn);
        const result = await mainSession.send('Runtime.evaluate', {
          expression: `(() => { const electron = require('electron'); return (${source}); })()`,
          awaitPromise: true,
          returnByValue: true,
        });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'main-process evaluation failed');
        return result.result?.value;
      },
      windowCount: async () => mainSession
        ? await mainSession.send('Runtime.evaluate', { expression: "require('electron').BrowserWindow.getAllWindows().length", returnByValue: true }).then((r) => r.result?.value).catch(() => null)
        : (cdpBrowser ? cdpBrowser.contexts().reduce((sum, c) => sum + c.pages().length, 0) : null),
      refreshPages: async () => {
        if (!cdpBrowser) return pages;
        const live = cdpBrowser.contexts().flatMap((context) => context.pages());
        while (pages.length < live.length) {
          const wrapper = new PlaywrightPage(live[pages.length], pages.length);
          wrapper.attachRecorders();
          await wrapper.refreshTarget();
          pages.push(wrapper);
        }
        for (const page of pages) await page.refreshTarget();
        return pages;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        if (cdpBrowser) {
          // `close()` on a connectOverCDP browser also terminates the app, which is
          // what teardown wants - but it can wait forever on an app that refuses to
          // quit, so it is bounded and the explicit kill below is authoritative.
          await Promise.race([
            cdpBrowser.close().catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, config.appCloseTimeoutMs ?? 8000)),
          ]);
        }
        for (const page of pages) {
          try {
            page.session?.dispose();
          } catch {}
        }
        try {
          mainSession?.close();
        } catch {}
        await killTree(child.pid);
        releaseChild(child);
      },
    };
  }

  return { ok: false, driver: playwrightChromium ? 'playwright-cdp' : 'cdp', attempts, pages: [], mainEvaluate: async () => null, close: async () => {} };
}

/**
 * Drop every handle that would otherwise keep the parent's event loop alive.
 *
 * A spawned Electron app keeps its stdout/stderr pipes open, and its own child
 * processes may inherit them, so the test process can finish all of its work and
 * still refuse to exit. Destroying the streams and unreferencing the child lets the
 * CLI terminate cleanly instead of hanging after writing its report.
 */
function releaseChild(child) {
  for (const stream of [child?.stdout, child?.stderr, child?.stdin]) {
    try {
      stream?.destroy();
    } catch {}
  }
  try {
    child?.unref?.();
  } catch {}
}

function log_warn(message) {
  import('./util.mjs').then(({ log }) => log.warn(message)).catch(() => {});
}

async function waitForTargets(port, options) {
  const { waitForTargets: impl } = await import('./cdp.mjs');
  return await impl(port, options);
}

/** Terminate a process tree (and its children). */
export async function killTree(pid) {
  if (!pid) return;
  const { run } = await import('./util.mjs');
  try {
    if (process.platform === 'win32') await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 20000 });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

/** Classify a native exit code into a stable, reportable crash kind. */
export function classifyExit(code) {
  if (code === null || code === undefined) return 'unknown';
  const unsigned = code >>> 0;
  switch (unsigned) {
    case 0xc0000005: return 'ACCESS_VIOLATION';
    case 0x80000003: return 'BREAKPOINT';
    case 0xc000001d: return 'ILLEGAL_INSTRUCTION';
    case 0xc0000135: return 'DLL_NOT_FOUND';
    case 0xc0000142: return 'DLL_INIT_FAILED';
    case 0xc0000409: return 'STACK_BUFFER_OVERRUN';
    case 0xc0000374: return 'HEAP_CORRUPTION';
    default: return `exit_${code}`;
  }
}

function firstLine(text) {
  return String(text).split('\n')[0].slice(0, 200);
}

export { sleep };
