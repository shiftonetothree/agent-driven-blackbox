/**
 * Minimal Chrome DevTools Protocol client.
 *
 * Built on Node's built-in `fetch` and global `WebSocket` so the harness needs no
 * npm dependencies - which matters because dependency installation is exactly the
 * step that fails first on a constrained host.
 *
 * Two independent CDP endpoints are used:
 *   - the Electron renderer endpoint (`--remote-debugging-port`), one page target
 *     per BrowserWindow / webview;
 *   - the Node inspector endpoint (`--inspect`), which exposes the Electron main
 *     process so probes can call `require('electron')` without patching the app.
 */

/** GET a CDP HTTP endpoint with a bounded timeout. */
export async function cdpHttpGet(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function listTargets(port, timeoutMs = 5000) {
  return await cdpHttpGet(`http://127.0.0.1:${port}/json/list`, timeoutMs);
}

export async function browserVersion(port, timeoutMs = 5000) {
  return await cdpHttpGet(`http://127.0.0.1:${port}/json/version`, timeoutMs);
}

/**
 * Poll `<port>/json/list` until `predicate` accepts the target list.
 * Resolves `null` on timeout rather than throwing, so callers can record it.
 */
export async function waitForTargets(port, { timeoutMs = 30000, intervalMs = 250, predicate = (t) => t.length > 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    try {
      last = await listTargets(port, 2000);
      if (predicate(last)) return last;
    } catch {
      // endpoint not up yet
    }
    await sleep(intervalMs);
  }
  return null;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** One WebSocket connection to a single CDP target. */
export class CdpConnection {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #closed = false;

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => this.#onMessage(event));
    socket.addEventListener('close', () => this.#onClose());
    socket.addEventListener('error', () => this.#onClose());
  }

  static async connect(webSocketDebuggerUrl, { timeoutMs = 10000 } = {}) {
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`CDP connect timeout: ${webSocketDebuggerUrl}`)), timeoutMs);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolvePromise();
      }, { once: true });
      socket.addEventListener('error', (event) => {
        clearTimeout(timer);
        rejectPromise(new Error(`CDP connect failed: ${event?.message ?? webSocketDebuggerUrl}`));
      }, { once: true });
    });
    return new CdpConnection(socket);
  }

  #onMessage(event) {
    let payload;
    try {
      payload = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (payload.id !== undefined && this.#pending.has(payload.id)) {
      const { resolvePromise, rejectPromise } = this.#pending.get(payload.id);
      this.#pending.delete(payload.id);
      if (payload.error) rejectPromise(new Error(`${payload.error.message} (${payload.error.code})`));
      else resolvePromise(payload.result);
      return;
    }
    if (payload.method) {
      for (const handler of this.#listeners.get(payload.method) ?? []) {
        try {
          handler(payload.params, payload.sessionId);
        } catch {
          // probe handlers must never break the transport
        }
      }
      for (const handler of this.#listeners.get('*') ?? []) {
        try {
          handler(payload, payload.sessionId);
        } catch {}
      }
    }
  }

  #onClose() {
    if (this.#closed) return;
    this.#closed = true;
    for (const { rejectPromise } of this.#pending.values()) {
      rejectPromise(new Error('CDP connection closed'));
    }
    this.#pending.clear();
    for (const handler of this.#listeners.get('__close') ?? []) handler();
  }

  get closed() {
    return this.#closed;
  }

  on(method, handler) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, []);
    this.#listeners.get(method).push(handler);
    return () => {
      const list = this.#listeners.get(method) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  }

  /** Send a CDP command. Rejects if the protocol returns an error. */
  send(method, params = {}, { timeoutMs = 30000, sessionId } = {}) {
    if (this.#closed) return Promise.reject(new Error('CDP connection closed'));
    const id = this.#nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        rejectPromise(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolvePromise: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        rejectPromise: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
      });
      try {
        this.#socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        rejectPromise(error);
      }
    });
  }

  close() {
    try {
      this.#socket.close();
    } catch {}
    this.#onClose();
  }
}

/**
 * High-level handle to one page target: console capture, evaluation and
 * screenshots. Created by `attachPage`.
 */
export class PageSession {
  constructor(connection, target) {
    this.connection = connection;
    this.target = target;
    this.consoleEvents = [];
    this.exceptions = [];
    this.logEntries = [];
    this.failedRequests = [];
    this._disposers = [];
  }

  /** Turn on the domains probes read from, and start recording events. */
  async instrument() {
    const record = (sink, shapec) => (params) => sink.push(shapec(params));

    this._disposers.push(this.connection.on('Runtime.consoleAPICalled', record(this.consoleEvents, (p) => ({
      type: p.type,
      text: (p.args ?? []).map(describeRemoteObject).join(' '),
      args: (p.args ?? []).map(describeRemoteObject),
      timestamp: p.timestamp,
      stack: p.stackTrace?.callFrames?.slice(0, 4).map((f) => `${f.functionName || '<anonymous>'} @ ${f.url}:${f.lineNumber + 1}`) ?? [],
    }))));

    this._disposers.push(this.connection.on('Runtime.exceptionThrown', record(this.exceptions, (p) => ({
      text: p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? 'unknown exception',
      url: p.exceptionDetails?.url,
      line: (p.exceptionDetails?.lineNumber ?? -1) + 1,
      column: (p.exceptionDetails?.columnNumber ?? -1) + 1,
      stack: p.exceptionDetails?.stackTrace?.callFrames?.slice(0, 8).map((f) => `${f.functionName || '<anonymous>'} @ ${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}`) ?? [],
    }))));

    this._disposers.push(this.connection.on('Log.entryAdded', record(this.logEntries, (p) => ({
      level: p.entry?.level,
      source: p.entry?.source,
      text: p.entry?.text,
      url: p.entry?.url,
      line: p.entry?.lineNumber,
    }))));

    this._disposers.push(this.connection.on('Network.loadingFailed', record(this.failedRequests, (p) => ({
      requestId: p.requestId,
      errorText: p.errorText,
      type: p.type,
      canceled: p.canceled ?? false,
    }))));

    await Promise.allSettled([
      this.connection.send('Runtime.enable'),
      this.connection.send('Log.enable'),
      this.connection.send('Page.enable'),
      this.connection.send('Network.enable'),
    ]);
  }

  /** Evaluate an expression in the page, returning a JSON value. */
  async evaluate(expression, { awaitPromise = true, timeoutMs = 15000, returnByValue = true } = {}) {
    const result = await this.connection.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue,
      userGesture: true,
    }, { timeoutMs });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation failed');
    }
    return result.result?.value;
  }

  /** Capture a PNG screenshot; returns a Buffer. */
  async screenshot({ format = 'png', fullPage = false } = {}) {
    const result = await this.connection.send('Page.captureScreenshot', {
      format,
      captureBeyondViewport: fullPage,
    }, { timeoutMs: 30000 });
    return Buffer.from(result.data, 'base64');
  }

  async title() {
    return await this.evaluate('document.title').catch(() => '');
  }

  /**
   * A compact fingerprint of the rendered page: used to compare base vs head
   * without depending on pixel-exact screenshots.
   */
  async domFingerprint() {
    return await this.evaluate(`(() => {
      const text = (document.body?.innerText ?? '').replace(/\\s+/g, ' ').trim();
      const counts = {};
      for (const el of document.querySelectorAll('*')) {
        const tag = el.tagName.toLowerCase();
        counts[tag] = (counts[tag] ?? 0) + 1;
      }
      return {
        url: location.href,
        title: document.title,
        textLength: text.length,
        textSample: text.slice(0, 400),
        textHash: [...text].reduce((h, c) => ((h * 31 + c.charCodeAt(0)) >>> 0), 7).toString(16),
        elementCount: document.querySelectorAll('*').length,
        tagCounts: counts,
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        visibleErrors: [...document.querySelectorAll('[class*=error],[class*=Error]')].slice(0, 5).map(e => (e.textContent ?? '').trim().slice(0, 200)),
      };
    })()`);
  }

  dispose() {
    for (const dispose of this._disposers) {
      try {
        dispose();
      } catch {}
    }
    this._disposers = [];
    this.connection.close();
  }
}

/** Reduce a CDP RemoteObject to a printable / serialisable string. */
export function describeRemoteObject(object) {
  if (object === undefined || object === null) return String(object);
  if ('value' in object) {
    const value = object.value;
    if (typeof value === 'object' && value !== null) {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  }
  if (object.unserializableValue !== undefined) return String(object.unserializableValue);
  if (object.description !== undefined) return String(object.description);
  if (object.className !== undefined) return `${object.className}#${object.objectId ?? ''}`;
  return `<${object.type ?? 'unknown'}>`;
}

/** Connect to a page target and instrument it. Never throws; returns null on failure. */
export async function attachPage(target, { timeoutMs = 15000 } = {}) {
  if (!target?.webSocketDebuggerUrl) return null;
  try {
    const connection = await CdpConnection.connect(target.webSocketDebuggerUrl, { timeoutMs });
    const session = new PageSession(connection, target);
    await session.instrument();
    return session;
  } catch {
    return null;
  }
}
