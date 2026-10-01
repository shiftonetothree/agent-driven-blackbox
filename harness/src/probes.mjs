/**
 * Probes: the actual black-box observations.
 *
 * Every probe is independent, never throws, and returns the same result shape so
 * that base and head runs can be compared mechanically:
 *
 *   { id, title, status, metrics, findings[], artifacts[] }
 *
 * `status` is one of pass | warn | fail | error | skip.
 *
 * Probes talk to the uniform page interface from `driver.mjs`, so they behave the
 * same whether Playwright or the built-in CDP driver launched the app. Where
 * Playwright offers something the fallback cannot (real user input, auto-waiting),
 * probes use it and record which driver produced the result.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { sleep } from './driver.mjs';
import { ensureDir, log, writeJson, writeText } from './util.mjs';

const sha1 = (buffer) => createHash('sha1').update(buffer).digest('hex');

function result(id, title, status = 'pass') {
  return { id, title, status, metrics: {}, findings: [], artifacts: [] };
}

function finding(severity, message, evidence = undefined) {
  return evidence === undefined ? { severity, message } : { severity, message, evidence };
}

/** Console output that always indicates a defect, as opposed to incidental noise. */
const SEVERE_CONSOLE = /uncaught|unhandled|is not a function|cannot read|undefined is not|failed to fetch|net::ERR|Module not found|Minified React error/i;

const appPages = (launch) => (launch.pages ?? []).filter((page) => page.target.type === 'page' && !isDevtoolsPage(page));

function isDevtoolsPage(page) {
  const url = page.target?.url ?? '';
  const title = page.target?.title ?? '';
  return url.startsWith('devtools://') || url.startsWith('chrome-extension://') || title === 'DevTools';
}

// ---------------------------------------------------------------------------
// probes
// ---------------------------------------------------------------------------

const probeWindows = {
  id: 'windows',
  title: 'Window / target inventory',
  async run(ctx) {
    const out = result(this.id, this.title);
    // Windows may open after the first one; refresh before counting.
    if (typeof ctx.launch.refreshPages === 'function') {
      await ctx.launch.refreshPages().catch(() => {});
    }
    const pages = ctx.launch.pages ?? [];
    const real = appPages(ctx.launch);

    out.metrics.driver = ctx.launch.driver ?? 'unknown';
    out.metrics.windowCount = pages.length;
    out.metrics.appWindowCount = real.length;
    out.metrics.targets = pages.map((page) => ({
      title: page.target.title,
      url: page.target.url,
      type: page.target.type,
    }));
    out.metrics.titles = pages.map((p) => p.target.title);
    out.metrics.urls = pages.map((p) => p.target.url);

    if (pages.length === 0) {
      out.status = 'fail';
      out.findings.push(finding('blocker', 'The application produced no renderer target: no window was ever created.'));
    } else if (real.length === 0) {
      out.status = 'warn';
      out.findings.push(finding('major', 'Only DevTools/auxiliary targets were exposed; no application window was observed.'));
    }
    return out;
  },
};

const probeConsole = {
  id: 'console',
  title: 'Console, exceptions and log entries',
  async run(ctx) {
    const out = result(this.id, this.title);

    // Give late async errors a moment to surface before sampling.
    await sleep(1500);

    const pages = ctx.launch.pages ?? [];
    const consoleAll = pages.flatMap((p) => p.consoleEvents ?? []);
    const exceptions = pages.flatMap((p) => p.errors ?? []);
    const failedRequests = pages.flatMap((p) => p.failedRequests ?? []);

    const errors = consoleAll.filter((e) => e.type === 'error');
    const warnings = consoleAll.filter((e) => e.type === 'warning');
    const severe = errors.filter((e) => SEVERE_CONSOLE.test(e.text ?? ''));

    out.metrics.consoleTotal = consoleAll.length;
    out.metrics.consoleErrors = errors.length;
    out.metrics.consoleWarnings = warnings.length;
    out.metrics.exceptions = exceptions.length;
    out.metrics.severeErrors = severe.length;
    out.metrics.errorSample = errors.slice(0, 10).map((e) => String(e.text ?? '').slice(0, 300));
    out.metrics.exceptionSample = exceptions.slice(0, 10).map((e) => `${String(e.text ?? '').slice(0, 200)}${e.url ? ` @ ${e.url}:${e.line ?? '?'}` : ''}`);

    const artifact = join(ctx.artifactsDir, 'console.json');
    await writeJson(artifact, { errors, warnings, exceptions, failedRequests });
    out.artifacts.push(artifact);

    if (exceptions.length > 0) {
      out.status = 'fail';
      out.findings.push(finding('major', `${exceptions.length} uncaught exception(s) in the renderer.`, out.metrics.exceptionSample.slice(0, 3)));
    }
    if (severe.length > 0) {
      out.status = 'fail';
      out.findings.push(finding('major', `${severe.length} severe console error(s).`, out.metrics.errorSample.slice(0, 3)));
    }
    if (out.status === 'pass' && errors.length > 0) {
      out.status = 'warn';
      out.findings.push(finding('minor', `${errors.length} console error(s) that do not match a known-severe pattern.`, out.metrics.errorSample.slice(0, 3)));
    }
    return out;
  },
};

const probeVisual = {
  id: 'visual',
  title: 'Rendered surface (screenshot + DOM fingerprint)',
  async run(ctx) {
    const out = result(this.id, this.title);
    const shots = [];
    const fingerprints = [];

    for (const [index, page] of (ctx.launch.pages ?? []).entries()) {
      if (isDevtoolsPage(page)) continue;
      const entry = { index, title: page.target.title, url: page.target.url };

      try {
        const fingerprint = await page.domFingerprint();
        fingerprints.push(fingerprint);
        entry.fingerprint = fingerprint;
      } catch (error) {
        entry.fingerprintError = error.message;
      }

      try {
        const png = await page.screenshot();
        const name = `window-${index}.png`;
        const file = join(ctx.artifactsDir, name);
        await writeText(file, png);
        entry.screenshot = name;
        entry.bytes = png.length;
        entry.sha1 = sha1(png);
        out.artifacts.push(file);
      } catch (error) {
        entry.screenshotError = error.message;
      }
      shots.push(entry);
    }

    out.metrics.windows = shots;
    out.metrics.fingerprints = fingerprints;
    out.metrics.screenshotShas = shots.map((s) => s.sha1 ?? null);
    out.metrics.totalTextLength = fingerprints.reduce((sum, f) => sum + (f.textLength ?? 0), 0);
    out.metrics.totalElements = fingerprints.reduce((sum, f) => sum + (f.elementCount ?? 0), 0);
    out.metrics.readyStates = fingerprints.map((f) => f.readyState);
    out.metrics.hasAppRoot = fingerprints.map((f) => f.hasAppRoot ?? null);

    const blank = shots.filter((s) => s.bytes !== undefined && s.bytes < 6000);
    if (blank.length > 0 && out.metrics.totalTextLength === 0) {
      out.status = 'fail';
      out.findings.push(finding('blocker', `${blank.length} window(s) rendered an apparently empty surface (tiny screenshot and no text).`, blank.map((b) => `${b.title}: ${b.bytes} bytes`)));
    } else if (out.metrics.totalTextLength === 0) {
      out.status = 'warn';
      out.findings.push(finding('major', 'No text content was found in any window; the app may not have finished loading.'));
    }

    for (const [i, fingerprint] of fingerprints.entries()) {
      if ((fingerprint.visibleErrors ?? []).length > 0) {
        out.status = out.status === 'fail' ? 'fail' : 'warn';
        out.findings.push(finding('minor', `window ${i} shows error-styled content.`, fingerprint.visibleErrors));
      }
      if (fingerprint.readyState && fingerprint.readyState !== 'complete') {
        out.status = out.status === 'fail' ? 'fail' : 'warn';
        out.findings.push(finding('minor', `window ${i} had not finished loading (readyState=${fingerprint.readyState}).`));
      }
    }
    return out;
  },
};

const probeNetwork = {
  id: 'network',
  title: 'Failed network requests',
  async run(ctx) {
    const out = result(this.id, this.title);
    const failures = (ctx.launch.pages ?? []).flatMap((p) => p.failedRequests ?? []);
    const meaningful = failures.filter((f) => !f.canceled);
    out.metrics.failedRequests = failures.length;
    out.metrics.nonCanceledFailures = meaningful.length;
    out.metrics.sample = meaningful.slice(0, 10).map((f) => `${f.resourceType ?? f.type ?? '?'} ${f.errorText} ${String(f.url ?? '').slice(0, 120)}`);
    if (meaningful.length > 0) {
      out.status = 'warn';
      out.findings.push(finding('minor', `${meaningful.length} network request(s) failed.`, out.metrics.sample));
    }
    return out;
  },
};

const probeMainProcess = {
  id: 'main-process',
  title: 'Main process state and window security configuration',
  async run(ctx) {
    const out = result(this.id, this.title);

    // Playwright hands the electron module to the evaluated function; the CDP
    // driver shims `require('electron')`. Both accept the same function shape.
    const inspect = ({ app, BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows().map((window) => {
        const prefs = {};
        try {
          const web = window.webContents.getLastWebPreferences?.() ?? {};
          prefs.nodeIntegration = web.nodeIntegration ?? null;
          prefs.contextIsolation = web.contextIsolation ?? null;
          prefs.sandbox = web.sandbox ?? null;
          prefs.webSecurity = web.webSecurity ?? null;
          prefs.preload = web.preload ? String(web.preload).split(/[\\/]/).pop() : null;
        } catch (error) {
          prefs.error = String(error && error.message);
        }
        let bounds = null;
        try {
          bounds = window.getBounds();
        } catch {}
        return {
          title: (() => { try { return window.getTitle(); } catch { return null; } })(),
          url: (() => { try { return window.webContents.getURL(); } catch { return null; } })(),
          visible: (() => { try { return window.isVisible(); } catch { return null; } })(),
          destroyed: (() => { try { return window.isDestroyed(); } catch { return null; } })(),
          bounds,
          prefs,
        };
      });
      return {
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        v8: process.versions.v8,
        appName: app.getName(),
        appVersion: app.getVersion(),
        locale: app.getLocale(),
        isPackaged: app.isPackaged,
        userData: app.getPath('userData'),
        logs: (() => { try { return app.getPath('logs'); } catch { return null; } })(),
        argv: process.argv.slice(1, 8),
        windowCount: windows.length,
        windows,
      };
    };

    try {
      const info = await ctx.launch.mainEvaluate(inspect);
      out.metrics = { ...info, driver: ctx.launch.driver };

      const insecure = (info.windows ?? []).filter(
        (w) => w.prefs?.nodeIntegration === true || w.prefs?.contextIsolation === false || w.prefs?.webSecurity === false,
      );
      out.metrics.insecureWindows = insecure.length;
      if (insecure.length > 0) {
        out.status = 'warn';
        out.findings.push(finding('major', `${insecure.length} window(s) run without the recommended security isolation.`, insecure.map((w) => ({ title: w.title, prefs: w.prefs }))));
      }

      const artifact = join(ctx.artifactsDir, 'main-process.json');
      await writeJson(artifact, info);
      out.artifacts.push(artifact);
    } catch (error) {
      out.status = 'skip';
      out.findings.push(finding('info', `main-process inspection unavailable: ${error.message}`));
    }
    return out;
  },
};

const probeStability = {
  id: 'stability',
  title: 'Reload stability',
  async run(ctx) {
    const out = result(this.id, this.title);
    const rounds = ctx.config.probeReloadRounds ?? 2;
    const page = appPages(ctx.launch)[0];
    if (!page) {
      out.status = 'skip';
      out.findings.push(finding('info', 'No application window was available to reload.'));
      return out;
    }

    const before = (page.errors ?? []).length;
    const failures = [];
    for (let i = 0; i < rounds; i++) {
      try {
        await page.reload();
        await sleep(1500);
      } catch (error) {
        failures.push(`round ${i}: ${error.message}`);
      }
    }
    const after = (page.errors ?? []).length;

    out.metrics.rounds = rounds;
    out.metrics.newExceptions = after - before;
    out.metrics.failures = failures;

    if (failures.length > 0) {
      out.status = 'warn';
      out.findings.push(finding('minor', `${failures.length} reload round(s) did not complete.`, failures));
    } else if (after > before) {
      out.status = 'fail';
      out.findings.push(finding('major', `Reloading produced ${after - before} new uncaught exception(s).`, (page.errors ?? []).slice(before).map((e) => String(e.text ?? '').slice(0, 200))));
    }
    return out;
  },
};

const probeScenario = {
  id: 'scenario',
  title: 'Declarative interaction scenario',
  async run(ctx) {
    const out = result(this.id, this.title);
    const steps = ctx.scenario?.steps ?? [];
    if (steps.length === 0) {
      out.status = 'skip';
      out.findings.push(finding('info', 'No scenario steps were supplied for this run.'));
      return out;
    }
    const page = appPages(ctx.launch)[0] ?? (ctx.launch.pages ?? [])[0];
    if (!page) {
      out.status = 'fail';
      out.findings.push(finding('blocker', 'No window was available to run the scenario against.'));
      return out;
    }

    out.metrics.driver = page.driver;
    out.metrics.usedRealInput = page.hasLocators === true;

    const executed = [];
    for (const [index, step] of steps.entries()) {
      const label = `${index + 1}. ${step.action} ${step.selector ?? step.name ?? (step.expression ? String(step.expression).slice(0, 60) : '')}`.trim();
      try {
        const value = await runStep(page, step, ctx);
        executed.push({ label, ok: true, value: value === undefined ? null : value });
      } catch (error) {
        executed.push({ label, ok: false, error: error.message });
        out.status = 'fail';
        out.findings.push(finding(step.severity ?? 'major', `scenario step failed: ${label}`, error.message));
        if (step.optional !== true) break;
      }
    }

    out.metrics.steps = executed;
    out.metrics.failed = executed.filter((s) => !s.ok).length;
    out.metrics.executed = executed.length;

    const artifact = join(ctx.artifactsDir, 'scenario.json');
    await writeJson(artifact, executed);
    out.artifacts.push(artifact);
    return out;
  },
};

/**
 * Execute one scenario step.
 *
 * Uses real user input through Playwright when available (with actionability
 * checks and auto-waiting), and falls back to in-page DOM dispatch otherwise.
 */
async function runStep(page, step, ctx) {
  const selector = step.selector;
  const timeout = step.timeout ?? 15000;

  switch (step.action) {
    case 'wait':
      await sleep(step.ms ?? 500);
      return null;

    case 'waitForSelector':
      await page.waitForSelector(selector, { timeout });
      return true;

    case 'click':
      await page.click(selector, { timeout });
      return true;

    case 'type':
    case 'fill':
      await page.fill(selector, step.text ?? '', { timeout });
      return true;

    case 'press':
      await page.press(step.selector ?? null, step.key ?? 'Enter', { timeout });
      return true;

    case 'eval':
      return await page.evaluate(step.expression ?? 'null');

    case 'assertEval': {
      // Assertion form of `eval`: lets a scenario assert on a value read from the
      // page - for example that a newly added bridge method exists. This is what
      // turns "the feature is present" into a pass/fail the differential can see.
      const value = await page.evaluate(step.expression ?? 'null');
      const actual = typeof value === 'string' ? value : JSON.stringify(value);
      if (step.equals !== undefined && String(value) !== String(step.equals)) {
        throw new Error(`expected ${JSON.stringify(step.equals)} but got ${JSON.stringify(actual)}`);
      }
      if (step.notEquals !== undefined && String(value) === String(step.notEquals)) {
        throw new Error(`expected anything but ${JSON.stringify(step.notEquals)}`);
      }
      if (step.contains !== undefined && !String(actual).includes(step.contains)) {
        throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(step.contains)}`);
      }
      if (step.matches !== undefined && !new RegExp(step.matches).test(String(actual))) {
        throw new Error(`expected ${JSON.stringify(actual)} to match /${step.matches}/`);
      }
      return value;
    }

    case 'assertText': {
      const text = await page.textContent(selector);
      if (step.contains !== undefined && !String(text).includes(step.contains)) {
        throw new Error(`expected text to contain ${JSON.stringify(step.contains)} but got ${JSON.stringify(String(text).slice(0, 300))}`);
      }
      if (step.matches !== undefined && !new RegExp(step.matches).test(String(text))) {
        throw new Error(`expected text to match /${step.matches}/ but got ${JSON.stringify(String(text).slice(0, 300))}`);
      }
      return String(text).slice(0, 500);
    }

    case 'assertSelector':
      await page.waitForSelector(selector, { timeout, state: 'attached' });
      return true;

    case 'assertVisible':
      await page.waitForSelector(selector, { timeout, state: 'visible' });
      return true;

    case 'assertNoConsoleErrors': {
      const errors = (page.consoleEvents ?? []).filter((e) => e.type === 'error');
      if (errors.length > 0) {
        throw new Error(`${errors.length} console error(s): ${errors.slice(0, 3).map((e) => String(e.text ?? '').slice(0, 120)).join(' | ')}`);
      }
      return true;
    }

    case 'assertNoPageErrors': {
      const errors = page.errors ?? [];
      if (errors.length > 0) {
        throw new Error(`${errors.length} uncaught error(s): ${errors.slice(0, 3).map((e) => String(e.text ?? '').slice(0, 120)).join(' | ')}`);
      }
      return true;
    }

    case 'screenshot': {
      const png = await page.screenshot();
      const file = join(ctx.artifactsDir, `step-${step.name ?? 'shot'}.png`);
      await writeText(file, png);
      ctx.artifacts.push(file);
      return file;
    }

    default:
      throw new Error(`unknown scenario action: ${step.action}`);
  }
}

export const PROBES = [probeWindows, probeConsole, probeVisual, probeNetwork, probeMainProcess, probeStability, probeScenario];

/** Reject if `promise` has not settled within `ms`. The underlying work is not cancellable, but the run must not stall on it. */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_resolve, rejectPromise) => {
      timer = setTimeout(() => rejectPromise(new Error(`probe "${label}" exceeded its ${ms} ms budget`)), ms);
    }),
  ]);
}

/**
 * Run every probe, isolating failures so one probe cannot hide the rest.
 *
 * Each probe is logged and bounded. A probe that hangs (a reload that never
 * settles, a screenshot of a window that never paints) is reported as a timeout
 * finding instead of silently stalling the whole run — which is exactly what
 * happened before the budget was introduced.
 */
export async function runProbes(ctx) {
  const artifactsDir = await ensureDir(ctx.artifactsDir);
  const artifacts = [];
  const results = [];
  const budgetMs = ctx.config.timeouts?.probe ?? 120000;
  // `only` lets a caller run a focused subset (used by `ebb play`, which is about
  // the caller's script rather than about the app in general).
  const selected = ctx.only ? PROBES.filter((probe) => ctx.only.includes(probe.id)) : PROBES;

  for (const probe of selected) {
    const started = Date.now();
    log.info(`probe ${probe.id} …`);
    try {
      const probeResult = await withTimeout(probe.run({ ...ctx, artifactsDir, artifacts }), budgetMs, probe.id);
      probeResult.durationMs = Date.now() - started;
      results.push(probeResult);
      const summary = probeResult.findings.length > 0 ? ` — ${probeResult.findings.length} finding(s)` : '';
      log.info(`probe ${probe.id}: ${probeResult.status} in ${probeResult.durationMs} ms${summary}`);
    } catch (error) {
      const failed = result(probe.id, probe.title, 'error');
      failed.durationMs = Date.now() - started;
      const timedOut = /exceeded its/.test(error.message);
      failed.findings.push(finding(timedOut ? 'major' : 'info', `${timedOut ? 'probe timed out' : 'probe crashed'}: ${error.message}`));
      results.push(failed);
      log.warn(`probe ${probe.id}: ${failed.status} in ${failed.durationMs} ms — ${error.message}`);
    }
  }
  return results;
}

/** Re-export for tests. */
export { SEVERE_CONSOLE, isDevtoolsPage };
