/**
 * Build and launch control.
 *
 * Launching tries Playwright first (`_electron.launch`), which gives real user
 * input, auto-waiting and main-process evaluation. It falls back to the hand-rolled
 * DevTools Protocol driver when playwright-core is unavailable, and is *required*
 * for dev-server adapters, where the app is started by an npm script that Playwright
 * cannot own.
 *
 * Two hard-won behaviours live here:
 *
 * 1. `--user-data-dir` is always injected, pointing inside the run directory.
 *    Besides being correct test hygiene, it is *required* on the reference host:
 *    resolving the default profile path crashes the browser process with an access
 *    violation before `ready`.
 *
 * 2. Launch flags are tried in order until the app reaches a usable state, and the
 *    winning set is cached in `work/capabilities.json`, so a host that needs
 *    `--no-sandbox` pays the retry cost once.
 */
import { constants as fsConstants } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { classifyExit, launchWithCdp, launchWithPlaywright, loadPlaywrightBundle } from './driver.mjs';
import { buildEnv, ensureDir, IS_WINDOWS, log, readJson, writeJson } from './util.mjs';

/** Locate the executable produced by a packaging step. */
export async function findPackagedBinary(outputDir, productName, { depth = 6 } = {}) {
  const candidates = [];

  async function walk(dir, level) {
    if (level > depth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip payload directories: the launcher sits at the top of the bundle.
        if (['resources', 'locales', 'swiftshader', 'resources.pak'].includes(entry.name)) continue;
        await walk(full, level + 1);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        const isBinary = IS_WINDOWS
          ? lower.endsWith('.exe') && !lower.startsWith('unins') && lower !== 'squirrel.exe' && lower !== 'update.exe'
          : !lower.includes('.') || lower.endsWith('.bin');
        if (isBinary) candidates.push(full);
      }
    }
  }

  await walk(outputDir, 0);
  if (candidates.length === 0) return null;

  const wantName = String(productName).toLowerCase();
  candidates.sort((a, b) => {
    const aMatch = basename(a).toLowerCase().startsWith(wantName) ? 0 : 1;
    const bMatch = basename(b).toLowerCase().startsWith(wantName) ? 0 : 1;
    if (aMatch !== bMatch) return aMatch - bMatch;
    return a.length - b.length;
  });
  return candidates[0];
}

/** Install dependencies for a checkout. */
export async function installDependencies({ projectDir, project, config, logFile, frozen = false }) {
  const { run } = await import('./util.mjs');
  const pm = project.packageManager;
  const args = packageArgsFor(pm, frozen);
  log.step(`installing dependencies (${pm}) in ${projectDir}`);
  const result = await run(args[0], args.slice(1), {
    cwd: projectDir,
    env: buildEnv(config),
    timeoutMs: config.timeouts.install,
    logFile,
  });
  if (result.code !== 0 && frozen) {
    log.warn('frozen install failed; retrying with a plain install');
    const retryArgs = packageArgsFor(pm, false);
    const retry = await run(retryArgs[0], retryArgs.slice(1), {
      cwd: projectDir,
      env: buildEnv(config),
      timeoutMs: config.timeouts.install,
      logFile,
    });
    return { ok: retry.code === 0, result: retry, command: retryArgs.join(' ') };
  }
  return { ok: result.code === 0, result, command: args.join(' ') };
}

function packageArgsFor(pm, frozen) {
  switch (pm) {
    case 'pnpm': return frozen ? ['pnpm', 'install', '--frozen-lockfile'] : ['pnpm', 'install'];
    case 'yarn': return frozen ? ['yarn', 'install', '--frozen-lockfile'] : ['yarn', 'install'];
    case 'bun': return frozen ? ['bun', 'install', '--frozen-lockfile'] : ['bun', 'install'];
    default: return frozen ? ['npm', 'ci', '--no-audit', '--no-fund'] : ['npm', 'install', '--no-audit', '--no-fund'];
  }
}

/** Run the adapter's packaging step and return the produced binary path. */
export async function packageApp({ projectDir, project, adapter, config, logFile }) {
  if (!adapter.package) return { ok: true, binary: null, skipped: true };
  const { run } = await import('./util.mjs');

  log.step(`packaging via ${adapter.id} (this can take several minutes)`);
  const result = await run(adapter.package[0], adapter.package.slice(1), {
    cwd: projectDir,
    env: buildEnv(config, { NODE_ENV: 'production' }),
    timeoutMs: adapter.timeouts?.package ?? config.timeouts.build,
    logFile,
  });

  const binary = (await findPackagedBinary(join(projectDir, 'out'), project.productName))
    ?? (await findPackagedBinary(join(projectDir, 'dist'), project.productName));

  if (result.code !== 0) return { ok: false, binary, result, command: adapter.package.join(' ') };
  if (!binary) {
    return {
      ok: false,
      binary: null,
      result,
      command: adapter.package.join(' '),
      error: 'packaging succeeded but no executable was found under out/ or dist/',
    };
  }
  log.ok(`packaged binary: ${binary}`);
  return { ok: true, binary, result, command: adapter.package.join(' ') };
}

/**
 * Decide how the app must be started.
 *
 * `playwright: true` means Playwright owns the Electron process and must be given
 * an executable path. `playwright: false` means an npm script owns it, so the
 * harness must spawn it and attach over CDP instead.
 */
async function resolveLaunchTarget({ projectDir, project, adapter, packagedBinary }) {
  switch (adapter.kind) {
    case 'packaged-binary':
      if (!packagedBinary) throw new Error('no packaged binary available to launch');
      return { playwright: true, executablePath: packagedBinary, appTarget: null, cwd: projectDir };
    case 'direct-electron':
      return { playwright: true, executablePath: adapter.binary, appTarget: projectDir, cwd: projectDir };
    case 'dev-script': {
      const pm = project.packageManager;
      const baseArgs = pm === 'yarn' ? [adapter.script] : ['run', adapter.script, '--'];
      const command = pm === 'yarn' ? 'yarn' : pm;
      return { playwright: false, command, baseArgs, cwd: projectDir };
    }
    default:
      throw new Error(`unsupported adapter kind: ${adapter.kind}`);
  }
}

async function loadCapabilities(workDir) {
  return await readJson(join(workDir, 'capabilities.json'), { launchArgs: null });
}

async function saveCapabilities(workDir, patch) {
  const current = await loadCapabilities(workDir);
  await writeJson(join(workDir, 'capabilities.json'), { ...current, ...patch });
}

function argSetKey(args) {
  return args.length === 0 ? 'default' : args.join(' ');
}

/** Put the cached flag set first so a known-good host skips the retry ladder. */
function orderArgSets(config, capabilities) {
  if (!capabilities?.launchArgs) return config.launchArgSets;
  const cached = { args: capabilities.launchArgs, label: capabilities.launchLabel ?? 'cached' };
  return [cached, ...config.launchArgSets.filter((set) => argSetKey(set.args) !== argSetKey(cached.args))];
}

/**
 * Launch the app. Never throws for a failed launch: the failure is the finding.
 */
export async function launchApp({
  projectDir,
  project,
  adapter,
  label,
  runDir,
  workDir,
  config,
  extraArgs = [],
  env: extraEnv = {},
  packagedBinary = null,
  preferPlaywright = true,
  /**
   * Shift the CDP / inspector port range for this launch. Two sides tested
   * concurrently would otherwise fight over the same ports.
   */
  portOffset = 0,
}) {
  const launchDir = await ensureDir(join(runDir, 'launch', label));
  const target = await resolveLaunchTarget({ projectDir, project, adapter, packagedBinary });
  const capabilities = await loadCapabilities(workDir);
  const argSets = orderArgSets(config, capabilities);

  const playwright = preferPlaywright ? await loadPlaywrightBundle() : { electron: null, chromium: null };
  if (target.playwright && !playwright.electron && !playwright.chromium) {
    log.warn('playwright-core is not installed; falling back to the built-in CDP driver');
    log.info('install it with: (cd harness && npm install)');
  }

  const argSetLabel = (set) => set.label ?? argSetKey(set.args);
  const onAttempt = (attempt) => {
    if (attempt.reachedReady) log.ok(`[${label}] ready via ${attempt.driver} after ${attempt.durationMs} ms (flags: ${argSetKey(attempt.args) || 'none'})`);
    else log.warn(`[${label}] ${attempt.driver} attempt failed: ${attempt.crashKind} (flags: ${argSetKey(attempt.args) || 'none'})`);
  };

  const attempts = [];
  const runners = [];

  /**
   * Record an attempt against the runner that produced it. The driver-level
   * callbacks do not know their own name, so it is stamped on here.
   */
  const recordAttempt = (driverName) => (attempt) => {
    const stamped = { ...attempt, driver: driverName };
    attempts.push(stamped);
    onAttempt(stamped);
  };

  // Rung 1: Playwright owns the Electron process. Richest API, but it needs the
  // main-process Node inspector, which packaged builds routinely disable.
  if (target.playwright && playwright.electron) {
    runners.push({
      driver: 'playwright',
      run: async () => await launchWithPlaywright({
        playwright: playwright.electron,
        executablePath: target.executablePath,
        appTarget: target.appTarget,
        label,
        argSets,
        launchDir,
        config,
        extraArgs,
        env: extraEnv,
        timeoutMs: config.timeouts.launch,
        onAttempt: recordAttempt('playwright'),
      }),
    });
  }

  // Rungs 2 and 3: the harness spawns the app itself, then attaches. Required for
  // dev-server adapters, and the fallback whenever rung 1 cannot attach.
  if (config.cdpFallback !== false) {
    const spawnCommand = target.playwright ? target.executablePath : target.command;
    const spawnBaseArgs = target.playwright ? (target.appTarget ? [target.appTarget] : []) : target.baseArgs;

    if (playwright.chromium) {
      runners.push({
        driver: 'playwright-cdp',
        run: async () => await launchWithCdp({
          command: spawnCommand,
          baseArgs: spawnBaseArgs,
          cwd: target.cwd,
          label,
          argSets,
          launchDir,
          config,
          extraArgs,
          env: extraEnv,
          timeoutMs: config.timeouts.launch,
          playwrightChromium: playwright.chromium,
          cdpPortBase: config.ports.cdp + portOffset,
          inspectPortBase: config.ports.inspect + portOffset,
          onAttempt: recordAttempt('playwright-cdp'),
        }),
      });
    }

    runners.push({
      driver: 'cdp',
      run: async () => await launchWithCdp({
        command: spawnCommand,
        baseArgs: spawnBaseArgs,
        cwd: target.cwd,
        label,
        argSets,
        launchDir,
        config,
        extraArgs,
        env: extraEnv,
        timeoutMs: config.timeouts.launch,
        cdpPortBase: config.ports.cdp + portOffset,
        inspectPortBase: config.ports.inspect + portOffset,
        onAttempt: recordAttempt('cdp'),
      }),
    });
  }

  for (const runner of runners) {
    const session = await runner.run();
    if (session.ok) {
      await saveCapabilities(workDir, {
        launchArgs: session.argSet.args,
        launchLabel: argSetLabel(session.argSet),
        adapterId: adapter.id,
        driver: runner.driver,
        updatedAt: new Date().toISOString(),
      });
      // `reachedReady` is the single flag the rest of the pipeline reads; keep it in
      // step with the drivers' own `ok` so a successful launch can never be
      // mistaken for a failed one (which would silently skip every probe).
      return { ...session, adapter, launchDir, attempts, ok: true, reachedReady: true };
    }
    if (runners.indexOf(runner) < runners.length - 1) {
      log.warn(`[${label}] the ${runner.driver} driver could not start the app; trying the next driver`);
    }
  }

  return {
    ok: false,
    reachedReady: false,
    driver: runners[0]?.driver ?? 'none',
    attempts,
    launchDir,
    pages: [],
    mainEvaluate: async () => null,
    adapter,
    crashSummary: attempts.map((a) => `${a.driver}/${a.label}: ${a.crashKind} exit=${a.exitCode}`).join('; '),
    close: async () => {},
  };
}

/** Best-effort sweep of leftover app processes by image name. */
export async function sweepProcesses(binaryName) {
  if (process.platform !== 'win32') return;
  const { run } = await import('./util.mjs');
  await run('taskkill', ['/IM', binaryName, '/T', '/F'], { timeoutMs: 20000 }).catch(() => {});
}

/** Whether a usable Playwright installation is present. */
export async function playwrightAvailable() {
  const bundle = await loadPlaywrightBundle();
  return bundle.electron !== null || bundle.chromium !== null;
}

export { classifyExit };
