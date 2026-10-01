/**
 * Re-usable single-revision sessions.
 *
 * `ebb run` answers "did this change break anything" and costs a full build. The two
 * commands here answer the question that comes *first* when testing a change: what
 * does this app actually expose, and does my script for it work yet?
 *
 * Both reuse a packaged build a previous run already produced (via the build index
 * in the run's report), so iterating on a test script is seconds per attempt rather
 * than minutes.
 */
import { join } from 'node:path';
import { detectProject } from './detect.mjs';
import { launchApp } from './launch.mjs';
import { exploreRevision, renderExplore } from './explore.mjs';
import { runProbes } from './probes.mjs';
import { RUNS_DIR, WORK_DIR, ensureDir, loadConfig, log, readJson, writeText } from './util.mjs';

/** Locate the recorded build for one side of a previous run. */
export async function resolveRunSide({ runId, side = 'head' }) {
  const candidates = [];
  if (runId) candidates.push(join(RUNS_DIR, runId));
  else {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(RUNS_DIR, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) candidates.push(join(RUNS_DIR, entry.name));
    }
    // Newest first, and skip directories without a report.
    candidates.sort().reverse();
  }

  for (const runDir of candidates) {
    const report = await readJson(join(runDir, 'report.json'), null);
    if (!report) continue;
    const info = report.probeResults?.[side];
    if (!info?.build?.packagedBinary) continue;
    return { runDir, runId: runDir.split(/[\\/]/).pop(), report, build: info.build, launch: info.launch };
  }

  throw new Error(
    runId
      ? `run "${runId}" has no recorded ${side} build; run it first (or pass --binary)`
      : `no completed run with a recorded ${side} build was found; run \`ebb run\` first, or pass --binary`,
  );
}

/**
 * Launch a build recorded by a previous run.
 *
 * The project is re-detected from the worktree because the launcher needs the
 * package manager, product name and adapter, none of which are worth duplicating
 * into the report.
 */
export async function launchRecordedBuild({ runId, side = 'head', label, sessionDir, config, portOffset = 200, env = {} }) {
  const resolved = await resolveRunSide({ runId, side });
  const { build } = resolved;

  const project = await detectProject(build.projectDir, config, { outputPath: join(sessionDir, 'project.json') });
  const adapter = project.adapters.find((a) => a.id === build.adapterId) ?? project.adapters[0];
  if (!adapter) throw new Error(`the recorded adapter "${build.adapterId}" is no longer available for ${build.projectDir}`);

  const launch = await launchApp({
    projectDir: build.projectDir,
    project,
    adapter,
    label,
    runDir: sessionDir,
    workDir: WORK_DIR,
    config,
    packagedBinary: build.packagedBinary,
    portOffset,
    env,
  });

  if (!launch.ok) {
    throw new Error(`could not launch the recorded build (${launch.crashSummary ?? 'unknown failure'}); re-run \`ebb run\` to rebuild`);
  }
  return { ...resolved, project, adapter, launch };
}

/** `ebb explore` - map what the app exposes, so a script can be written against it. */
export async function exploreCommand({ runId, side = 'head', out = null, config: configOverrides = {}, env = {} }) {
  const config = await loadConfig(configOverrides);
  const sessionRoot = await ensureDir(join(RUNS_DIR, runId ?? 'latest', 'explore'));
  const sessionDir = await ensureDir(join(sessionRoot, `${side}-${Date.now()}`));

  log.step(`exploring the recorded ${side} build`);
  const { runId: resolvedRunId, launch, build } = await launchRecordedBuild({ runId, side, label: 'explore', sessionDir, config, env });

  try {
    const artifactsDir = await ensureDir(join(sessionDir, 'artifacts'));
    // Let the UI settle, otherwise the map is taken mid-render and is useless.
    for (const page of launch.pages ?? []) {
      await page.waitForSettled({ timeoutMs: config.settleTimeoutMs ?? 30000 }).catch(() => {});
    }
    const map = await exploreRevision({ launch, artifactsDir });
    map.runId = resolvedRunId;
    map.side = side;
    map.binary = build.packagedBinary;

    const markdown = renderExplore(map);
    const markdownPath = out ?? join(sessionDir, 'explore.md');
    await writeText(markdownPath, markdown);
    await writeText(join(sessionDir, 'explore.md'), markdown);

    log.raw('');
    log.raw(markdown);
    log.ok(`interaction map: ${markdownPath}`);
    log.info(`machine-readable: ${join(artifactsDir, 'explore.json')}`);
    return { sessionDir, markdownPath, map };
  } finally {
    await launch.close().catch(() => {});
  }
}

/**
 * `ebb play` - run one scenario against one revision, fast.
 *
 * This is the authoring loop: write a step, play it, read the failure, fix the
 * selector, play it again. It deliberately runs only the console and scenario
 * probes, so the output is about your script rather than about the app in general.
 */
export async function playCommand({ runId, side = 'head', scenarioPath, config: configOverrides = {}, verbose = true, env = {} }) {
  const config = await loadConfig(configOverrides);
  const sessionRoot = await ensureDir(join(RUNS_DIR, runId ?? 'latest', 'play'));
  const sessionDir = await ensureDir(join(sessionRoot, `${side}-${Date.now()}`));

  if (!scenarioPath) throw new Error('--scenario <file> is required; generate a starting point with `ebb scenario <runId>`');
  const scenario = await readJson(scenarioPath, null);
  if (!scenario || !Array.isArray(scenario.steps)) throw new Error(`${scenarioPath} does not contain a "steps" array`);

  log.step(`playing ${scenario.steps.length} step(s) against the recorded ${side} build`);
  const { runId: resolvedRunId, launch } = await launchRecordedBuild({ runId, side, label: 'play', sessionDir, config, env });

  try {
    const artifactsDir = await ensureDir(join(sessionDir, 'artifacts'));
    for (const page of launch.pages ?? []) {
      await page.waitForSettled({ timeoutMs: config.settleTimeoutMs ?? 30000 }).catch(() => {});
    }

    const probes = await runProbes({
      launch,
      project: null,
      artifactsDir,
      config,
      scenario,
      artifacts: [],
      only: ['console', 'scenario'],
    });

    const scenarioProbe = probes.find((p) => p.id === 'scenario');
    const steps = scenarioProbe?.metrics?.steps ?? [];

    if (verbose) {
      log.raw('');
      log.step('steps');
      for (const step of steps) {
        if (step.ok) log.info(`  PASS  ${step.label}${step.value !== null && step.value !== undefined ? `  -> ${typeof step.value === 'string' ? step.value.slice(0, 120) : JSON.stringify(step.value).slice(0, 120)}` : ''}`);
        else log.fail(`  FAIL  ${step.label}\n         ${step.error}`);
      }
      // The not-yet-executed tail matters when a step aborts the scenario.
      for (const pending of scenario.steps.slice(steps.length)) {
        log.info(`  SKIP  ${pending.action} ${pending.selector ?? pending.name ?? ''} (scenario stopped at the failure above)`);
      }
      log.raw('');
    }

    const failed = steps.filter((s) => !s.ok);
    const executed = steps.length;
    const total = scenario.steps.length;
    const verdict = failed.length === 0 && executed === total ? 'PASS' : 'FAIL';

    log.step(`script result: ${verdict} (${executed}/${total} steps executed, ${failed.length} failed)`);
    if (verdict === 'PASS' && executed < total) log.warn('some steps never ran');

    return { sessionDir, runId: resolvedRunId, side, verdict, steps, total, executed, artifactsDir };
  } finally {
    await launch.close().catch(() => {});
  }
}
