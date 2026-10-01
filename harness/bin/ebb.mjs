#!/usr/bin/env node
/**
 * `ebb` - Electron Black-Box harness command line.
 *
 * Commands are designed to be driven by an agent: each one is non-interactive,
 * prints what it is doing, and leaves a durable artifact (JSON + Markdown) behind.
 */
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadConfig, ROOT, RUNS_DIR, HARNESS_DIR, log } from '../src/util.mjs';

// ---------------------------------------------------------------------------
// argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const aliases = { r: 'repo', p: 'pr', a: 'adapter', o: 'only', s: 'scenario', h: 'help' };
  const booleans = new Set(['json', 'smoke', 'frozen', 'skip-install', 'force-clone', 'no-adapt', 'help', 'keep-going', 'list', 'quiet', 'global', 'serial', 'parallel-exercise']);
  const repeatable = new Set(['launch-arg', 'env']);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('-')) {
      positional.push(token);
      continue;
    }
    const withoutDashes = token.replace(/^--?/, '');
    const [rawKey, inlineValue] = withoutDashes.split('=');
    const key = aliases[rawKey] ?? rawKey;

    if (booleans.has(key)) {
      flags[key] = true;
      continue;
    }
    const value = inlineValue ?? argv[++i];
    if (value === undefined) throw new Error(`missing value for --${rawKey}`);
    if (repeatable.has(key)) {
      flags[key] = [...(flags[key] ?? []), value];
    } else {
      flags[key] = value;
    }
  }
  return { flags, positional };
}

/**
 * `--env KEY=VALUE` (repeatable) -> `{ KEY: 'VALUE' }`.
 *
 * Passed to the launched application's environment. This is how a test points a
 * file-based feature at a sandbox instead of the tester's real profile: an app that
 * reads `~/.workbuddy/models.json` or writes `$DSH_HOME/settings.yaml` can be given
 * `--env USERPROFILE=<sandbox> --env DSH_HOME=<sandbox>/.dsh`, so the test exercises
 * the real read/backup/write code without touching the user's own configuration.
 */
function parseEnvFlags(list) {
  const env = {};
  for (const entry of list ?? []) {
    const at = String(entry).indexOf('=');
    if (at <= 0) throw new Error(`--env expects KEY=VALUE, got "${entry}"`);
    env[String(entry).slice(0, at)] = String(entry).slice(at + 1);
  }
  return env;
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

const HELP = `
ebb - Electron black-box testing harness

USAGE
  ebb <command> [options]

COMMANDS
  doctor                     Check that this host can clone, build and launch Electron.
                             Run this first. Use --smoke to actually launch a smoke app.
  acquire                    Resolve a pull request or commit range and print the change set.
  run                        Test a change: acquire, build, launch, probe, compare, report.
  explore [runId]            Launch a revision a previous run already built and map what it
                             exposes: real selectors, forms, dialogs, routes, IPC channels,
                             application menu. This is how you write a targeted script.
  scenario [runId]           Scaffold a scenario aimed at THAT change's risk areas.
  play [runId]               Run one scenario against one revision, in seconds, reusing the
                             build. The authoring loop: edit -> play -> read failure -> fix.
  runs                       List previous runs.
  report <runId>             Re-render a report from a stored run.
  triage <runId>             Print the risk triage for a stored run.
  selfcheck                  Validate the harness itself (offline).

TESTING A SPECIFIC CHANGE
  The generic probes only prove the app still starts. To test what a PR actually does,
  write a scenario for it:
     ebb run ... --pr 85                       # builds both revisions and reports
     ebb scenario <runId>                      # scaffold targets from the diff
     ebb explore <runId>                       # map real selectors / IPC channels
     ebb play <runId> --scenario <file>        # iterate in seconds
     ebb run ... --pr 85 --scenario <file>     # final differential run, scripted

RUN OPTIONS
  --repo <url>               Repository URL or owner/name (required unless --repo-dir).
  --pr <number>              Test a pull request against its base branch.
  --range <A..B>             Test an explicit commit range (use A...B for merge-base).
  --repo-dir <path>          Test a repository already on disk instead of cloning a URL.
                             With --range (or --pr) it snapshots the repo locally and
                             runs the full differential test; with neither it tests the
                             working tree as-is (single-sided, includes uncommitted work).
  --adapter <id>             Force a launch adapter (see project.json adapters).
  --only <both|base|head>    Run one side only (default: both).
  --scenario <file>          Extra interaction scenario (JSON with a "steps" array).
  --launch-arg <flag>        Extra Electron flag; repeatable.
  --env <KEY=VALUE>          Environment variable for the launched app; repeatable.
                             Use it to sandbox a file-based feature: point HOME /
                             USERPROFILE / DSH_HOME at a fixtures directory instead of
                             your real profile, so the test can exercise reads, backups
                             and writes without touching your own configuration.
  --frozen                   Prefer a lockfile-frozen dependency install.
  --skip-install             Do not install dependencies (assume the tree is ready).
  --force-clone              Delete and re-clone the repository.
  --no-adapt                 Do not adapt the packaging configuration (see below).
  --serial                   Build the revisions one after another (slowest, least load).
  --parallel-exercise        Launch and probe both revisions at once. Off by default:
                             two app instances would be on screen simultaneously with
                             identical window titles. See process/PROCESS.md.
  --json                     Machine-readable output where supported.

BUILD ADAPTATIONS
  To observe a packaged Electron app, the harness may rewrite a *fuse* in the
  project's packaging configuration inside the run's disposable worktree - notably
  Electron Forge's EnableNodeCliInspectArguments, which otherwise removes the Node
  inspector that Playwright attaches to. Application source is never modified, the
  cached clone and your repository are never touched, and every run that applies one
  records it in adaptations-<side>.diff and states it prominently in the report.
  Pass --no-adapt to compare against the repository's shipped configuration instead.

EXAMPLES
  node ./bin/ebb.mjs doctor --smoke
  node ./bin/ebb.mjs run --repo https://github.com/owner/name --pr 85
  node ./bin/ebb.mjs explore <runId> --side head
  node ./bin/ebb.mjs scenario <runId> --out harness/scenarios/pr85.json
  node ./bin/ebb.mjs play <runId> --scenario harness/scenarios/pr85.json
  node ./bin/ebb.mjs run --repo owner/name --range v1.2.0..v1.3.0
  node ./bin/ebb.mjs run --repo-dir ../some-app --range v1.2.0..v1.3.0
  node ./bin/ebb.mjs run --repo-dir ../some-app
`;

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function commandDoctor(flags) {
  const { doctor } = await import('../src/doctor.mjs');
  const report = await doctor({
    electronBinary: flags.electron ?? null,
    smoke: flags.smoke === true,
    json: flags.json === true,
  });
  process.exitCode = report.ok ? 0 : 1;
}

async function commandSelfcheck(flags) {
  const { selfcheck } = await import('../src/selfcheck.mjs');
  const report = await selfcheck({ json: flags.json === true });
  process.exitCode = report.failed === 0 ? 0 : 1;
}

async function commandRun(flags) {
  const { runPipeline } = await import('../src/run.mjs');
  const { loadConfig } = await import('../src/util.mjs');

  if (!flags.repo && !flags['repo-dir']) {
    throw new Error('--repo <url> is required (or --repo-dir <path>)');
  }
  if (flags.pr === undefined && flags.range === undefined && !flags['repo-dir']) {
    throw new Error('specify what to test: --pr <number> or --range <A..B>');
  }
  if (flags.pr !== undefined && flags.range !== undefined) {
    throw new Error('--pr and --range are mutually exclusive');
  }

  // Watchdog. Everything else in the pipeline is individually bounded, but a
  // regression that reintroduces an unbounded wait should fail loudly instead of
  // hanging an unattended CI job. `unref` keeps it from delaying a normal exit.
  const config = await loadConfig({});
  const budgetMs = config.runTimeoutMs ?? 45 * 60 * 1000;
  const watchdog = setTimeout(() => {
    console.error('');
    console.error(`ebb: the run exceeded its ${Math.round(budgetMs / 60000)} minute budget and was terminated.`);
    console.error('     Partial evidence is in the run directory. Check the host with `ebb doctor --smoke`,');
    console.error('     and see process/knowledge/failure-modes.md before retrying.');
    process.exit(2);
  }, budgetMs);
  watchdog.unref?.();

  try {
    const result = await runPipeline({
      repoUrl: flags.repo ?? null,
      repoDir: flags['repo-dir'] ? resolve(flags['repo-dir']) : null,
      pr: flags.pr !== undefined ? Number(flags.pr) : null,
      range: flags.range ?? null,
      adapterId: flags.adapter ?? null,
      only: flags.only ?? 'both',
      scenarioPath: flags.scenario ? resolve(flags.scenario) : null,
      extraArgs: flags['launch-arg'] ?? [],
      extraEnv: parseEnvFlags(flags.env),
      frozen: flags.frozen === true,
      skipInstall: flags['skip-install'] === true,
      forceClone: flags['force-clone'] === true,
      configOverrides: {
        ...(flags['no-adapt'] === true ? { adaptBuild: false } : {}),
        ...(flags.serial === true ? { parallelPrepare: false, parallelExercise: false } : {}),
        ...(flags['parallel-exercise'] === true ? { parallelExercise: true } : {}),
      },
    });

    process.exitCode = result.verdict === 'REGRESSION' || result.verdict === 'FAIL' ? 1 : 0;
  } finally {
    clearTimeout(watchdog);
  }
}

async function commandAcquire(flags) {
  const { acquire } = await import('../src/acquire.mjs');
  const { triageChangeset } = await import('../src/analyze.mjs');
  const config = await loadConfig({});
  const { WORK_DIR, ensureDir, timestampId, shortHash, writeText } = await import('../src/util.mjs');

  if (!flags.repo && !flags['repo-dir']) {
    throw new Error('--repo <url> is required (or --repo-dir <path>)');
  }

  const runId = `acquire-${timestampId()}-${shortHash(flags.repo ?? flags['repo-dir'] ?? '', String(flags.pr ?? flags.range ?? ''))}`;
  const runDir = await ensureDir(join(RUNS_DIR, runId));

  const acquired = await acquire({
    repoUrl: flags.repo ?? null,
    localRepo: flags['repo-dir'] ? resolve(flags['repo-dir']) : null,
    pr: flags.pr !== undefined ? Number(flags.pr) : null,
    range: flags.range ?? null,
    workDir: await ensureDir(WORK_DIR),
    runDir,
    config,
    force: flags['force-clone'] === true,
  });

  const triage = triageChangeset(acquired.changeset);
  await writeText(join(runDir, 'triage.json'), `${JSON.stringify(triage, null, 2)}\n`);

  if (flags.json) {
    console.log(JSON.stringify({ ...acquired.changeset, triage }, null, 2));
    return;
  }

  const c = acquired.changeset;
  log.raw('');
  log.step(`change set`);
  log.info(`kind       ${c.kind}`);
  log.info(`base       ${c.base.ref} @ ${c.base.sha.slice(0, 12)}`);
  log.info(`head       ${c.head.ref} @ ${c.head.sha.slice(0, 12)}`);
  log.info(`merge base ${c.mergeBase.slice(0, 12)}`);
  log.info(`size       ${c.totals.files} files, +${c.totals.additions}/-${c.totals.deletions}, ${c.totals.commits} commits`);
  log.raw('');
  log.step('risk triage');
  for (const area of triage.areas) {
    log.info(`${area.area.padEnd(18)} ${String(area.files.length).padStart(3)} file(s)  probes: ${area.probes.join(', ') || '-'}`);
  }
  log.raw('');
  log.info(`run directory: ${runDir}`);
}

async function listRunsOrFail() {
  const { listRuns } = await import('../src/run.mjs');
  return await listRuns();
}

async function resolveRunDir(runIdOrPath) {
  if (!runIdOrPath) {
    const runs = await listRunsOrFail();
    if (runs.length === 0) throw new Error('no runs yet; start one with `ebb run --repo <url> --pr <n>`');
    return { runId: runs[0].runId, runDir: join(RUNS_DIR, runs[0].runId) };
  }
  const direct = resolve(runIdOrPath);
  if (existsSync(join(direct, 'report.json'))) return { runId: direct.split(/[\\/]/).pop(), runDir: direct };
  const byId = join(RUNS_DIR, runIdOrPath);
  if (existsSync(byId)) return { runId: runIdOrPath, runDir: byId };
  throw new Error(`run not found: ${runIdOrPath}`);
}

async function commandRuns(flags) {
  const runs = await listRunsOrFail();
  if (flags.json) {
    console.log(JSON.stringify(runs, null, 2));
    return;
  }
  if (runs.length === 0) {
    log.info('no runs yet.');
    return;
  }
  log.raw('');
  log.step('previous runs');
  for (const run of runs) {
    log.info(`${run.runId}  ${String(run.verdict).padEnd(16)} ${String(run.subject).padEnd(22)} ${run.startedAt ?? ''}`);
  }
  log.raw('');
}

async function commandReport(flags, positional) {
  const { runDir, runId } = await resolveRunDir(positional[0] ?? flags.run);
  const { writeReports } = await import('../src/report.mjs');
  const { readJson } = await import('../src/util.mjs');

  const report = await readJson(join(runDir, 'report.json'), null);
  if (!report) throw new Error(`no report.json found in ${runDir}`);

  const run = {
    meta: report.meta,
    changeset: report.changeset,
    triage: report.triage,
    comparison: report.comparison,
    summary: report.summary,
    base: report.probeResults?.base ? { ...report.probeResults.base, probes: report.probeResults.base.probes ?? [] } : null,
    head: report.probeResults?.head ? { ...report.probeResults.head, probes: report.probeResults.head.probes ?? [] } : null,
  };
  const paths = await writeReports(run);
  log.ok(`re-rendered ${runId}`);
  log.info(paths.markdownPath);
}

async function commandTriage(flags, positional) {
  const { runDir } = await resolveRunDir(positional[0] ?? flags.run);
  const { readJson } = await import('../src/util.mjs');
  // `acquire` writes triage.json directly; a completed `run` carries it inside
  // report.json. Accept either so the command works for both.
  const triage = (await readJson(join(runDir, 'triage.json'), null))
    ?? (await readJson(join(runDir, 'report.json'), null))?.triage;
  if (!triage) throw new Error(`no triage information found in ${runDir}`);
  console.log(JSON.stringify(triage, null, 2));
}

async function commandScenario(flags, positional) {
  const { runDir, runId } = await resolveRunDir(positional[0] ?? flags.run);
  const { readJson, writeJson, projectScriptsDir, PROJECTS_DIR, HARNESS_DIR } = await import('../src/util.mjs');
  const { scaffoldScenario } = await import('../src/analyze.mjs');

  const triage = await readJson(join(runDir, 'triage.json'), null)
    ?? (await readJson(join(runDir, 'report.json'), null))?.triage
    ?? null;
  const changeset = await readJson(join(runDir, 'changeset.json'), null);

  // If the agent already explored the app, point the scaffold at the map.
  const exploreDir = join(runDir, 'explore');
  let explored = null;
  try {
    const { readdir } = await import('node:fs/promises');
    const sessions = (await readdir(exploreDir, { withFileTypes: true })).filter((e) => e.isDirectory());
    if (sessions.length > 0) {
      const latest = join(exploreDir, sessions.sort((a, b) => a.name.localeCompare(b.name)).at(-1).name, 'explore.md');
      explored = { path: latest };
    }
  } catch {
    // Exploration is optional; the scaffold works without it.
  }

  const scenario = scaffoldScenario({ changeset, triage, explored });

  // Project-specific scripts go under projects/<slug>/scenarios/, never into the
  // framework. `--global` is for the rare case of a genuinely app-agnostic script.
  let out;
  if (flags.out) {
    out = resolve(flags.out);
  } else if (flags.global) {
    out = join(HARNESS_DIR, 'scenarios', `${runId}.json`);
  } else {
    const repo = changeset?.repo;
    if (!repo?.owner || !repo?.name) {
      throw new Error('cannot tell which repository this run belongs to; pass --out <path> or --global');
    }
    out = join(projectScriptsDir(repo.owner, repo.name), `${runId}.json`);
  }
  await writeJson(out, scenario);

  const relativeOut = out.startsWith(PROJECTS_DIR) ? out.slice(PROJECTS_DIR.length + 1) : out;
  log.ok(`scenario scaffold: ${out}`);
  if (out.includes('harness') && out.includes('scenarios')) {
    log.warn('this was written into the framework (harness/scenarios). Keep app-agnostic scripts there only;');
    log.warn('a project-specific script belongs under projects/<owner>__<repo>/scenarios/.');
  }
  if ((scenario.targets ?? []).length > 0) {
    log.raw('');
    log.step('this change touches');
    for (const target of scenario.targets) {
      log.info(`${target.area} (${target.churn}) — ${target.files.length} file(s)`);
      log.info(`   ${target.hint}`);
    }
  }
  log.raw('');
  log.step('next');
  log.info(`1. node ./bin/ebb.mjs explore ${runId} --side head   # real selectors, IPC channels, menu`);
  log.info(`2. edit ${relativeOut}`);
  log.info(`3. node ./bin/ebb.mjs play ${runId} --scenario "${relativeOut}"   # seconds per attempt`);
  log.info(`4. node ./bin/ebb.mjs run <repo> --pr <n> --scenario "${relativeOut}"`);
  log.raw('');
  log.info('Generic, app-agnostic scripts live in harness/scenarios/. Scripts that know one');
  log.info('app\'s routes and selectors live in projects/<owner>__<repo>/scenarios/. Do not mix them.');
}

async function commandExplore(flags, positional) {
  const { exploreCommand } = await import('../src/session.mjs');
  const result = await exploreCommand({
    runId: positional[0] ?? flags.run ?? null,
    side: flags.side ?? 'head',
    out: flags.out ? resolve(flags.out) : null,
    env: parseEnvFlags(flags.env),
  });
  return result;
}

async function commandPlay(flags, positional) {
  const { playCommand } = await import('../src/session.mjs');
  if (!flags.scenario) throw new Error('--scenario <file> is required; scaffold one with `ebb scenario <runId>`');
  const result = await playCommand({
    runId: positional[0] ?? flags.run ?? null,
    side: flags.side ?? 'head',
    scenarioPath: resolve(flags.scenario),
    env: parseEnvFlags(flags.env),
  });
  process.exitCode = result.verdict === 'PASS' ? 0 : 1;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

// A long test run must survive stray asynchronous failures from third-party
// libraries (Playwright in particular rejects internally when it gives up on a
// launch). Those are recorded and reported by the pipeline; they must not abort the
// whole run with an unhandled rejection.
const strayRejections = [];
process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  strayRejections.push(message);
  console.error(`ebb: ignored stray async failure (${message.split('\n')[0]})`);
});
process.on('uncaughtException', (error) => {
  if (String(error?.message ?? '').includes('Timeout') && /playwright/i.test(String(error?.stack ?? ''))) {
    strayRejections.push(error.message);
    console.error(`ebb: ignored stray Playwright timeout (${error.message.split('\n')[0]})`);
    return;
  }
  console.error('');
  console.error(`ebb: fatal: ${error?.stack ?? error}`);
  process.exitCode = 1;
  process.exit(1);
});

/**
 * Flush stdout/stderr, then exit explicitly.
 *
 * The harness spawns Electron and connects to it with Playwright, and both leave
 * handles behind - sockets, an internal driver process, and stdio pipes inherited by
 * the app's own children. Waiting for the event loop to drain therefore hangs after
 * the work is finished and the report is written. A CLI that manages child processes
 * has to decide when it is done, so it does.
 */
async function flushAndExit(code) {
  await new Promise((resolve) => {
    let pending = 2;
    const done = () => {
      if (--pending <= 0) resolve();
    };
    const timer = setTimeout(resolve, 2000);
    try {
      process.stdout.write('', done);
      process.stderr.write('', done);
    } catch {
      resolve();
    }
  });
  process.exit(code);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    console.log(HELP.trim());
    return;
  }

  const command = argv[0];
  const { flags, positional } = parseArgs(argv.slice(1));

  if (flags.help) {
    console.log(HELP.trim());
    return;
  }

  // Apply proxy settings before anything performs network I/O in this process.
  const config = await loadConfig({});
  if (config.proxy) {
    process.env.HTTP_PROXY = config.proxy;
    process.env.HTTPS_PROXY = config.proxy;
    process.env.http_proxy = config.proxy;
    process.env.https_proxy = config.proxy;
    process.env.NODE_USE_ENV_PROXY = '1';
  }

  try {
    switch (command) {
      case 'doctor': await commandDoctor(flags); break;
      case 'selfcheck': await commandSelfcheck(flags); break;
      case 'run': await commandRun(flags); break;
      case 'acquire': await commandAcquire(flags); break;
      case 'explore': await commandExplore(flags, positional); break;
      case 'play': await commandPlay(flags, positional); break;
      case 'runs': await commandRuns(flags); break;
      case 'report': await commandReport(flags, positional); break;
      case 'triage': await commandTriage(flags, positional); break;
      case 'scenario': await commandScenario(flags, positional); break;
      default:
        console.error(`unknown command: ${command}\n`);
        console.log(HELP.trim());
        process.exitCode = 2;
    }
  } catch (error) {
    console.error('');
    console.error(`ebb: ${error.message}`);
    if (process.env.EBB_DEBUG) console.error(error.stack);
    process.exitCode = 1;
  }

  await flushAndExit(process.exitCode ?? 0);
}

await main();
