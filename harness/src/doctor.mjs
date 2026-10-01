/**
 * `ebb doctor` - capability probe.
 *
 * The harness runs on machines it does not control, so it must be able to answer
 * "what can this host actually do?" before blaming the repository under test. The
 * doctor checks the environment, then (when an Electron binary is available)
 * actually launches a smoke app to discover a working set of launch flags.
 */
import { existsSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { launchApp } from './launch.mjs';
import { recentCrashDumps } from './minidump.mjs';
import {
  CACHE_DIR, ELECTRON_EXE, HARNESS_DIR, IS_WINDOWS, WORK_DIR,
  buildEnv, ensureDir, loadConfig, pathExists, readJson, run, shortHash, writeJson,
} from './util.mjs';

const SMOKE_APP = join(HARNESS_DIR, 'fixtures', 'smoke-app');

function check(name, status, detail, remedy = undefined) {
  return { name, status, detail, ...(remedy ? { remedy } : {}) };
}

/** Probe a URL with the in-process fetch (which honours the configured proxy). */
async function probeUrl(url, config, { timeoutMs = 15000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: controller.signal, headers });
    return { ok: response.ok, status: response.status, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, status: null, ms: Date.now() - started, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Locate any usable Electron binary inside the workspace. */
export async function findAnyElectron() {
  const roots = [join(WORK_DIR, 'repos')];
  for (const root of roots) {
    let owners;
    try {
      owners = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const owner of owners) {
      if (!owner.isDirectory()) continue;
      let repos;
      try {
        repos = await readdir(join(root, owner.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const repo of repos) {
        if (!repo.isDirectory()) continue;
        const candidate = join(root, owner.name, repo.name, 'node_modules', 'electron', 'dist', ELECTRON_EXE);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** Run the smoke app against a binary, discovering which flags reach `ready`. */
async function probeLaunchCapability({ electronBinary, config, workDir }) {
  const fixtureDir = await ensureDir(join(workDir, 'doctor', `smoke-${shortHash(electronBinary)}`));
  const handshake = join(SMOKE_APP, 'handshake.json');
  await writeFile(handshake, '{}', 'utf8').catch(() => {});

  const project = {
    dir: SMOKE_APP,
    name: 'ebb-smoke-app',
    productName: 'ebb-smoke-app',
    packageManager: 'npm',
    toolchain: 'plain',
    main: 'main.js',
    scripts: {},
    electron: { binary: electronBinary, installed: null, declared: null },
    adapters: [],
    warnings: [],
  };
  const adapter = { id: 'direct-electron', label: 'smoke app', kind: 'direct-electron', binary: electronBinary };

  const launch = await launchApp({
    projectDir: SMOKE_APP,
    project,
    adapter,
    label: 'doctor',
    runDir: fixtureDir,
    workDir,
    config,
    extraArgs: [],
  });

  let handshakeData = null;
  try {
    handshakeData = JSON.parse(await (await import('node:fs/promises')).readFile(handshake, 'utf8'));
  } catch {}

  if (launch.ok) {
    const page = launch.pages?.[0];
    let domText = null;
    let title = null;
    let screenshotBytes = null;
    if (page) {
      try {
        domText = await page.evaluate("document.getElementById('heading')?.textContent ?? document.body.innerText.slice(0,120)");
        title = await page.title();
        const png = await page.screenshot();
        screenshotBytes = png.length;
        await writeFile(join(fixtureDir, 'smoke.png'), png);
      } catch {}
    }
    await launch.close?.();
    return { ok: true, attempts: launch.attempts, argSet: launch.argSet, domText, title, screenshotBytes, handshake: handshakeData, engine: launch.version?.Browser ?? null, driver: launch.driver };
  }

  const dumps = await recentCrashDumps(IS_WINDOWS ? 'electron' : 'electron', { limit: 3 });
  await launch.close?.();
  return { ok: false, attempts: launch.attempts, crashSummary: launch.crashSummary, handshake: handshakeData, dumps, engine: null, driver: launch.driver };
}

/** Run every environment check. */
export async function doctor({ electronBinary = null, smoke = false, json = false } = {}) {
  const config = await loadConfig({});
  const workDir = await ensureDir(WORK_DIR);
  await ensureDir(CACHE_DIR);

  const checks = [];

  checks.push(check('host', 'ok', `${platform()} ${release()} ${arch()}, node ${process.version}, ${cpus().length} cpu, ${Math.round(totalmem() / 1024 ** 3)} GB RAM`));

  // Workspace writability: the whole run depends on it.
  try {
    const probeFile = join(CACHE_DIR, '.write-probe');
    await writeFile(probeFile, 'ok', 'utf8');
    checks.push(check('workspace-writable', 'ok', `caches under ${CACHE_DIR}`));
  } catch (error) {
    checks.push(check('workspace-writable', 'fail', `cannot write to the workspace: ${error.message}`, 'Fix the directory permissions for the session workspace, or run the session with full access.'));
  }

  checks.push(config.proxy
    ? check('proxy', 'ok', `configured: ${config.proxy}`)
    : check('proxy', 'warn', 'no proxy configured; direct connections will be attempted'));

  const npmRegistry = config.npmRegistry ?? 'https://registry.npmjs.org';
  const npmProbe = await probeUrl(npmRegistry, config);
  checks.push(npmProbe.ok
    ? check('npm-registry', 'ok', `${npmRegistry} responded ${npmProbe.status} in ${npmProbe.ms} ms`)
    : check('npm-registry', 'fail', `${npmRegistry} unreachable: ${npmProbe.error ?? npmProbe.status}`, 'Set a reachable registry with `npm config set registry <url>` or EBB_PROXY.'));

  const ghProbe = await probeUrl('https://api.github.com/rate_limit', config, { headers: { 'User-Agent': 'ebb-doctor' } });
  checks.push(ghProbe.ok
    ? check('github-api', 'ok', `api.github.com responded ${ghProbe.status} in ${ghProbe.ms} ms (needed to resolve pull request base branches)`)
    : check('github-api', 'warn', `api.github.com unreachable: ${ghProbe.error ?? ghProbe.status}`, 'Pull requests will fall back to merge-base against the default branch, which can over-report changes when the PR targets a non-default branch.'));

  // git: plain, then with the configured TLS backend.
  const plainGit = await run('git', ['ls-remote', '--heads', 'https://github.com/electron/electron-quick-start'], { env: buildEnv({ ...config, gitSslBackend: null }), timeoutMs: 60000 });
  if (plainGit.code === 0) {
    checks.push(check('git-remote', 'ok', 'git can reach GitHub with its default TLS backend'));
  } else {
    const opensslGit = await run('git', ['-c', 'http.sslBackend=openssl', 'ls-remote', '--heads', 'https://github.com/electron/electron-quick-start'], { env: buildEnv(config), timeoutMs: 60000 });
    const detail = (plainGit.stderr || '').trim().split('\n').slice(0, 2).join(' | ');
    checks.push(opensslGit.code === 0
      ? check('git-remote', 'ok', `default TLS backend failed (${detail}); the openssl backend works and is configured automatically`)
      : check('git-remote', 'fail', `git cannot reach GitHub: ${detail}`, 'Check the proxy settings; on Windows a schannel credential failure usually needs `git config --global http.sslBackend openssl`.'));
  }

  const dumps = await recentCrashDumps(IS_WINDOWS ? 'electron' : 'electron', { limit: 3 });
  if (dumps.length > 0) {
    checks.push(check('crash-dumps', 'warn', `${dumps.length} recent electron crash dump(s) found; the newest is ${dumps[0].exception ? `${dumps[0].exception.name} in ${String(dumps[0].exception.module).split(/[\\/]/).pop()}+${dumps[0].exception.moduleOffset}` : 'unreadable'}`, 'Crash dumps are captured per run as evidence; see the launch section of a report.'));
  } else {
    checks.push(check('crash-dumps', 'ok', 'no recent electron crash dumps'));
  }

  // Optional: actually launch Electron.
  const binary = electronBinary ?? (await findAnyElectron());
  let launchResult = null;
  if (smoke || electronBinary) {
    if (!binary) {
      checks.push(check('electron-launch', 'fail', 'no Electron binary found to test with', 'Pass one explicitly: ebb doctor --electron <path-to-electron>'));
    } else {
      checks.push(check('electron-launch', 'ok', `probing ${binary}`));
      launchResult = await probeLaunchCapability({ electronBinary: binary, config, workDir });
      if (launchResult.ok) {
        checks.push(check('electron-launch', 'ok', `ready with flags "${(launchResult.argSet?.args ?? []).join(' ') || '(none)'}"; window title "${launchResult.title}"; DOM "${launchResult.domText}"; screenshot ${launchResult.screenshotBytes} bytes; engine ${launchResult.engine}`));
      } else {
        const dumpInfo = launchResult.dumps?.[0]?.exception
          ? `crash: ${launchResult.dumps[0].exception.name} in ${String(launchResult.dumps[0].exception.module).split(/[\\/]/).pop()}+${launchResult.dumps[0].exception.moduleOffset}`
          : 'no crash dump was written';
        checks.push(check('electron-launch', 'fail', `no launch flag set reached a debuggable state (${launchResult.crashSummary}); ${dumpInfo}`, 'This host cannot run Electron; run the harness on a machine with an interactive desktop session, or supply extra flags with `--launch-arg`.'));
      }
    }
  } else {
    checks.push(check('electron-launch', 'skip', binary ? `binary available at ${binary}; run with --smoke to test it` : 'no Electron binary available'));
  }

  // Read the launch-flag decision *after* the smoke probe so a discovery made in
  // this run is reported as the current answer rather than as a missing cache.
  const capabilities = await readJson(join(WORK_DIR, 'capabilities.json'), null);
  if (capabilities?.launchArgs) {
    checks.push(check('launch-flags', 'ok', `in use: "${capabilities.launchArgs.join(' ') || '(none)'}" (discovered via ${capabilities.adapterId ?? 'unknown adapter'}${capabilities.updatedAt ? `, ${capabilities.updatedAt}` : ''})`));
  } else {
    checks.push(check('launch-flags', 'warn', 'no launch flags discovered yet; the first real run will probe them', 'Run `ebb doctor --smoke` with an Electron binary to discover them now.'));
  }

  const report = {
    generatedAt: new Date().toISOString(),
    harnessDir: HARNESS_DIR,
    config,
    checks,
    launchResult,
    ok: !checks.some((c) => c.status === 'fail'),
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('');
    console.log('ebb doctor');
    console.log('==========');
    for (const item of checks) {
      const mark = item.status === 'ok' ? 'ok  ' : item.status === 'warn' ? 'warn' : item.status === 'skip' ? 'skip' : 'FAIL';
      console.log(`[${mark}] ${item.name}: ${item.detail}`);
      if (item.remedy) console.log(`         -> ${item.remedy}`);
    }
    console.log('');
    console.log(report.ok ? 'Environment looks usable.' : 'Environment has blocking problems (see FAIL above).');
  }

  await writeJson(join(WORK_DIR, 'doctor.json'), report);
  return report;
}

export { SMOKE_APP, pathExists, probeLaunchCapability };
