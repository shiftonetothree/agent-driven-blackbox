/**
 * Shared utilities for the EBB harness: paths, logging, process execution,
 * filesystem helpers and the environment bootstrap.
 *
 * The environment bootstrap encodes machine-specific facts that were established
 * empirically on the reference host (see process/knowledge/environment.md). Every
 * value is overridable through `harness/ebb.config.json` or `EBB_*` env vars, so the
 * harness stays portable to a normal development machine.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const HARNESS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Repository root that holds the process docs, harness, runs and work dirs. */
export const ROOT = resolve(HARNESS_DIR, '..');
export const RUNS_DIR = join(ROOT, 'runs');
export const WORK_DIR = join(ROOT, 'work');
export const CACHE_DIR = join(ROOT, '.cache');

/**
 * Where per-project test scripts live.
 *
 * Two kinds of scenario exist and they must not be mixed:
 *
 *   harness/scenarios/   Generic. Reusable against any Electron app, owned by the
 *                        process itself. Kept deliberately tiny.
 *   projects/<slug>/     Written on the spot for one repository - it knows that
 *                        app's routes, selectors, dialogs and IPC channels, and is
 *                        meaningless anywhere else.
 *
 * Project scripts are kept (they are the reusable evidence for future changes to the
 * same app) but never inside the framework, so the framework stays project-agnostic.
 */
export const PROJECTS_DIR = join(ROOT, 'projects');

/** Stable folder name for a repository. */
export function projectSlug(owner, name) {
  return `${String(owner).replace(/[^\w.-]/g, '_')}__${String(name).replace(/[^\w.-]/g, '_')}`;
}

/** Directory holding one repository's authored scenarios. */
export function projectScriptsDir(owner, name) {
  return join(PROJECTS_DIR, projectSlug(owner, name), 'scenarios');
}

const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);

export const log = {
  step: (msg) => console.log(`${paint(36, '::')} ${msg}`),
  info: (msg) => console.log(`   ${msg}`),
  ok: (msg) => console.log(`${paint(32, 'ok')} ${msg}`),
  warn: (msg) => console.log(`${paint(33, '!!')} ${msg}`),
  fail: (msg) => console.log(`${paint(31, 'xx')} ${msg}`),
  raw: (msg) => console.log(msg),
};

// ---------------------------------------------------------------------------
// small fs helpers
// ---------------------------------------------------------------------------

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
  return path;
}

export async function readJson(path, fallback = undefined) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (fallback !== undefined && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function writeJson(path, value) {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeText(path, text) {
  await ensureDir(dirname(path));
  await writeFile(path, text, 'utf8');
}

export async function readText(path, fallback = '') {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function removePath(path) {
  await rm(path, { recursive: true, force: true, maxRetries: 5 });
}

export async function listDir(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export { copyFile };

/** Short, filesystem-safe, deterministic id derived from its inputs. */
export function shortHash(...parts) {
  return createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 10);
}

/** `2026-10-01T06-30-00Z` - sortable and safe as a directory name. */
export function timestampId(date = new Date()) {
  return date.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

export function resolveFrom(base, target) {
  return isAbsolute(target) ? target : resolve(base, target);
}

// ---------------------------------------------------------------------------
// process execution
// ---------------------------------------------------------------------------

/**
 * Quote one argument for a Windows command line.
 *
 * Standard CreateProcess escaping: backslashes are only special immediately before
 * a quote, and a trailing run of backslashes must be doubled so it does not escape
 * the closing quote.
 */
export function quoteWinArg(value) {
  const text = String(value);
  if (text !== '' && !/[\s"]/.test(text)) return text;
  let out = '"';
  let backslashes = 0;
  for (const character of text) {
    if (character === '\\') {
      backslashes += 1;
      out += character;
      continue;
    }
    if (character === '"') {
      out += `${'\\'.repeat(backslashes)}\\"`;
      backslashes = 0;
      continue;
    }
    backslashes = 0;
    out += character;
  }
  return `${out}${'\\'.repeat(backslashes)}"`;
}

/**
 * Turn a logical command into something `spawn` can actually execute.
 *
 * On Windows, package-manager commands (`npm`, `npx`, `pnpm`, `yarn`) are `.cmd`
 * shims that CreateProcess cannot start directly - `spawn('npm', ...)` fails with
 * ENOENT. Rather than enabling a shell (which concatenates unescaped arguments and
 * invites injection from a repository-controlled script name), the command line is
 * built here with explicit quoting and handed over verbatim.
 */
export function buildSpawn(command, args = []) {
  if (process.platform !== 'win32' || /\.(exe|com)$/i.test(command)) {
    return { command, args, verbatim: false };
  }
  const shell = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  const line = [command, ...args].map(quoteWinArg).join(' ');
  return { command: shell, args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

/**
 * Run a command, capturing stdout/stderr into `logFile` when given.
 *
 * Never uses a shell implicitly, so arguments with spaces and quotes stay intact.
 * Resolves (does not reject) with
 * `{ code, signal, stdout, stderr, durationMs, timedOut }` so callers can record
 * failures as evidence instead of exceptions.
 */
export function run(command, args = [], options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = 20 * 60 * 1000,
    logFile,
    echo = false,
    echoPrefix = '   | ',
  } = options;

  const spec = buildSpawn(command, args);

  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(spec.command, spec.args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: spec.verbatim,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {}
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (echo) process.stdout.write(text.split('\n').filter(Boolean).map((l) => echoPrefix + l).join('\n') + '\n');
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (echo) process.stderr.write(text.split('\n').filter(Boolean).map((l) => echoPrefix + l).join('\n') + '\n');
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        code: -1,
        signal: null,
        stdout,
        stderr: `${stderr}\nspawn error: ${error.message}`,
        durationMs: Date.now() - started,
        timedOut: false,
        command,
        args,
        spawnError: error.message,
      });
    });

    child.on('close', async (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { code, signal, stdout, stderr, durationMs: Date.now() - started, timedOut, command, args };
      if (logFile) {
        const body = [
          `$ ${command} ${args.join(' ')}`,
          `# cwd=${cwd ?? process.cwd()} exit=${code} signal=${signal} durationMs=${result.durationMs} timedOut=${timedOut}`,
          '',
          '--- stdout ---',
          stdout,
          '--- stderr ---',
          stderr,
          '',
        ].join('\n');
        await writeText(logFile, body).catch(() => {});
      }
      resolvePromise(result);
    });
  });
}

/** Like `run`, but resolves the trimmed stdout or throws with captured output. */
export async function runCapture(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 2000);
    const error = new Error(`\`${command} ${args.join(' ')}\` exited ${result.code}${result.timedOut ? ' (timeout)' : ''}\n${detail}`);
    error.result = result;
    throw error;
  }
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// environment bootstrap
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  /** HTTP(S) proxy used for git/npm/Electron downloads; null disables it. */
  proxy: 'http://127.0.0.1:10808',
  /** SOCKS proxy exported as ALL_PROXY/all_proxy. */
  socksProxy: 'socks5://127.0.0.1:10808',
  /** npm registry; the China mirror is far faster on the reference host. */
  npmRegistry: 'https://registry.npmmirror.com',
  /** Electron binary mirror; combined with ELECTRON_GET_USE_PROXY this works here. */
  electronMirror: 'https://npmmirror.com/mirrors/electron/',
  /**
   * TLS backend for git. Windows schannel fails on the reference host with
   * SEC_E_NO_CREDENTIALS, so OpenSSL is used instead.
   */
  gitSslBackend: 'openssl',
  /**
   * Launch flags. `--user-data-dir` is injected per run by the launcher; these are
   * the extra flags tried in order until the app reaches `ready`.
   */
  launchArgSets: [
    { args: [], label: 'default' },
    { args: ['--no-sandbox'], label: 'no-sandbox' },
    { args: ['--no-sandbox', '--disable-gpu'], label: 'no-sandbox+disable-gpu' },
  ],
  /**
   * When true, a Playwright launch that fails on every flag set is retried with the
   * built-in DevTools Protocol driver. Set false to keep runs strictly Playwright.
   */
  cdpFallback: true,
  /**
   * Per-attempt timeout for Playwright's `_electron.launch`, in milliseconds.
   * Deliberately shorter than the general launch timeout: if the app's build
   * disables the main-process Node inspector, this call can never succeed and the
   * driver ladder must move on quickly.
   */
  playwrightLaunchTimeoutMs: 25000,
  /**
   * Apply declared packaging-configuration adaptations inside the disposable
   * worktree so the app can be observed (see `src/adapt.mjs`). Never touches the
   * cached clone or the user's repository, and every run that uses one reports it.
   */
  adaptBuild: true,
  /**
   * Reuse a packaged build when the same revision, adapter, platform and adaptation
   * set has already been built. Packaging dominates a run's wall-clock time and
   * depends on nothing else.
   */
  buildCache: true,
  /**
   * Build both revisions at once. Installing and packaging dominate a cold run's
   * wall clock, and they need no window or display, so this is safe and worth it.
   */
  parallelPrepare: true,
  /**
   * Launch and probe both revisions at once. Off by default, deliberately:
   *
   *  - two Electron instances on screen at the same time have identical window
   *    titles, so a human cannot tell which is base and which is head;
   *  - each instance repeats the app's real startup work (network calls, update
   *    checks), so resource use doubles;
   *  - any app that takes a single-instance lock would have its second instance
   *    quit immediately, and the run would test one revision twice.
   *
   * Only the GUI phase has these problems, and it is not where the time goes.
   */
  parallelExercise: false,
  /**
   * How long to wait for an app to honour a graceful quit before force-killing its
   * process tree. Electron apps with a tray icon or background services can refuse
   * to exit, and waiting on them forever stalls a run before it writes its report.
   */
  appCloseTimeoutMs: 8000,
  /**
   * Hard ceiling for a whole `run`. A watchdog exits with a diagnostic rather than
   * letting an unattended CI job hang indefinitely.
   */
  runTimeoutMs: 45 * 60 * 1000,
  /** How long to let a window finish its first render before probing it. */
  settleTimeoutMs: 30000,
  /** Ports used for CDP (renderer) and the Node inspector (main process). */
  ports: { cdp: 9222, inspect: 9229 },
  /** Per-phase timeouts in milliseconds. */
  timeouts: { install: 1800000, build: 1800000, launch: 60000, probe: 120000 },
};

export async function loadConfig(overrides = {}) {
  const fileConfig = await readJson(join(HARNESS_DIR, 'ebb.config.json'), {});
  const envConfig = {};
  if (process.env.EBB_PROXY) envConfig.proxy = process.env.EBB_PROXY;
  if (process.env.EBB_NO_PROXY === '1') envConfig.proxy = null;
  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...envConfig,
    ...overrides,
    ports: { ...DEFAULT_CONFIG.ports, ...fileConfig.ports, ...overrides.ports },
    timeouts: { ...DEFAULT_CONFIG.timeouts, ...fileConfig.timeouts, ...overrides.timeouts },
  };
}

/**
 * Build the environment for child processes.
 *
 * Sets proxy variables, redirects every package-manager and Electron cache into
 * the workspace (so nothing depends on a writable user profile), and selects the
 * git TLS backend that works on the reference host.
 */
export function buildEnv(config, extra = {}) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;

  if (config.proxy) {
    env.HTTP_PROXY = config.proxy;
    env.HTTPS_PROXY = config.proxy;
    env.http_proxy = config.proxy;
    env.https_proxy = config.proxy;
    env.ELECTRON_GET_USE_PROXY = 'true';
    env.GLOBAL_AGENT_HTTP_PROXY = config.proxy;
    env.GLOBAL_AGENT_HTTPS_PROXY = config.proxy;
  }
  if (config.socksProxy) {
    env.ALL_PROXY = config.socksProxy;
    env.all_proxy = config.socksProxy;
  }

  env.npm_config_cache = join(CACHE_DIR, 'npm');
  env.NPM_CONFIG_CACHE = env.npm_config_cache;
  if (config.npmRegistry) env.npm_config_registry = config.npmRegistry;
  env.ELECTRON_CACHE = join(CACHE_DIR, 'electron');
  env.electron_config_cache = env.ELECTRON_CACHE;
  if (config.electronMirror) env.ELECTRON_MIRROR = config.electronMirror;

  // Keep git away from schannel when configured; harmless when unset.
  if (config.gitSslBackend) {
    env.GIT_SSL_BACKEND = config.gitSslBackend;
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.sslBackend';
    env.GIT_CONFIG_VALUE_0 = config.gitSslBackend;
  }

  env.ELECTRON_ENABLE_LOGGING = env.ELECTRON_ENABLE_LOGGING ?? '1';
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = '1';
  // Deterministic, locale-independent output from app and tools.
  env.LANG = env.LANG ?? 'en_US.UTF-8';

  return { ...env, ...extra };
}

/** `git` argv prefix that forces the configured TLS backend. */
export function gitArgs(config, args) {
  return config.gitSslBackend ? ['-c', `http.sslBackend=${config.gitSslBackend}`, ...args] : args;
}

export const IS_WINDOWS = isWindows;
export const ELECTRON_EXE = isWindows ? 'electron.exe' : 'electron';
export { existsSync };
