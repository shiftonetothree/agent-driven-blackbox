/**
 * The end-to-end pipeline: acquire -> build -> launch -> probe -> compare -> report.
 *
 * Each side (base, head) is prepared and exercised independently, and a failure on
 * one side never aborts the run: a build or launch failure is itself a result.
 */
import { cpus, platform, arch, totalmem, release } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { acquire } from './acquire.mjs';
import { applyBuildAdaptations, describeAdaptations, previewAdaptations } from './adapt.mjs';
import { adaptationSignature, buildCacheKey, lookupBuild, noteBuildHit, rememberBuild } from './buildcache.mjs';
import { compareRuns, suggestScenario, summariseRun, triageChangeset } from './analyze.mjs';
import {
  assessRuntimeSideEffects, assessStaticSideEffects, combineSideEffects,
  describeSideEffects, parallelExerciseAllowed,
} from './sideeffects.mjs';
import { detectProject } from './detect.mjs';
import { installDependencies, launchApp, packageApp, sweepProcesses } from './launch.mjs';
import { runProbes } from './probes.mjs';
import { writeReports } from './report.mjs';
import {
  HARNESS_DIR, ROOT, RUNS_DIR, WORK_DIR,
  buildEnv, ensureDir, loadConfig, log, readJson, readText, timestampId, writeJson, writeText, shortHash,
} from './util.mjs';

export const HARNESS_VERSION = '0.3.0';

/** Read the harness version from its own package.json so the report cannot drift. */
async function readHarnessVersion() {
  try {
    return JSON.parse(await readText(join(HARNESS_DIR, 'package.json'), '{}')).version ?? HARNESS_VERSION;
  } catch {
    return HARNESS_VERSION;
  }
}

/** Choose which adapter to use for a side. */
function pickAdapter(project, requested) {
  if (requested) {
    const found = project.adapters.find((a) => a.id === requested);
    if (!found) {
      throw new Error(`adapter "${requested}" not available; choose one of: ${project.adapters.map((a) => a.id).join(', ') || '(none)'}`);
    }
    return found;
  }
  return project.adapters[0] ?? null;
}

/** Prepare one revision: detect, install, package. */
async function prepareSide({ label, projectDir, runDir, workDir, config, adapterId, frozen, skipInstall, logDir, revision }) {
  const side = { label, projectDir };
  log.raw('');
  log.step(`=== ${label.toUpperCase()} :: ${projectDir} ===`);

  try {
    side.project = await detectProject(projectDir, config);
  } catch (error) {
    side.prepareError = `project detection failed: ${error.message}`;
    log.fail(side.prepareError);
    return side;
  }

  log.info(`package manager: ${side.project.packageManager}; toolchain: ${side.project.toolchain}; electron: ${side.project.electron.installed ?? side.project.electron.declared ?? 'unknown'}`);

  side.adapter = pickAdapter(side.project, adapterId);
  if (!side.adapter) {
    side.prepareError = 'no launch adapter available for this project';
    log.fail(side.prepareError);
    return side;
  }
  log.info(`adapter: ${side.adapter.id} (${side.adapter.label})`);

  // A packaged build is expensive (~5 minutes for the reference project) and depends
  // only on the revision, adapter, platform and adaptations. Reuse it when we can.
  const packagingAdapter = side.adapter.kind === 'packaged-binary' ? side.adapter : null;
  const expectedAdaptations = packagingAdapter ? await previewAdaptations({ projectDir, config }) : [];
  const cacheKey = packagingAdapter && config.buildCache !== false
    ? buildCacheKey({
      revision: revision ?? projectDir,
      adapterId: packagingAdapter.id,
      adaptationSignature: adaptationSignature(expectedAdaptations),
    })
    : null;

  if (cacheKey) {
    const cached = await lookupBuild(workDir, cacheKey);
    if (cached) {
      await noteBuildHit(workDir, cacheKey);
      side.cacheHit = true;
      side.packagedBinary = cached.binaryPath;
      side.adaptations = cached.adaptations ?? [];
      side.package = { ok: true, binary: cached.binaryPath, cached: true, fromRun: cached.runId ?? null };
      log.ok(`reusing the packaged build from a previous run (no install, no packaging): ${cached.binaryPath}`);
      if (side.adaptations.length > 0) {
        log.info(`that build already carries ${side.adaptations.length} declared adaptation(s)`);
      }
      return side;
    }
  }

  if (!skipInstall) {
    const install = await installDependencies({
      projectDir,
      project: side.project,
      config,
      frozen,
      logFile: join(logDir, `${label}-install.log`),
    });
    side.install = { ok: install.ok, command: install.command, exitCode: install.result.code, durationMs: install.result.durationMs };
    if (!install.ok) {
      side.prepareError = `dependency installation failed (exit ${install.result.code}); see ${join(logDir, `${label}-install.log`)}`;
      log.fail(side.prepareError);
      return side;
    }
    log.ok(`dependencies installed (${Math.round(install.result.durationMs / 1000)} s)`);
  }

  // A packaged binary is the most faithful black-box target; fall back to the dev
  // script when packaging fails, because the dev path can still reveal defects.
  if (side.adapter.kind === 'packaged-binary') {
    // Adapt the packaging configuration so the app can be observed at all. This is
    // confined to the disposable worktree and is reported to the reader.
    const adaptation = await applyBuildAdaptations({ projectDir, runDir, label, config });
    side.adaptations = adaptation.applied;
    side.adaptationRecord = adaptation;
    for (const item of adaptation.applied) {
      log.warn(`adapted ${item.file}: ${item.title} [${item.changes.map((c) => `${c.option}=${c.value}`).join(', ')}]`);
    }
    if (adaptation.applied.length > 0) {
      log.info(`adaptation diff: ${adaptation.diffPath}`);
    }

    const packaged = await packageApp({
      projectDir,
      project: side.project,
      adapter: side.adapter,
      config,
      logFile: join(logDir, `${label}-package.log`),
    });
    side.package = { ok: packaged.ok, command: packaged.command, binary: packaged.binary, exitCode: packaged.result?.code, error: packaged.error };
    if (packaged.ok) {
      side.packagedBinary = packaged.binary;
      log.ok('packaged');
      if (cacheKey) {
        await rememberBuild(workDir, cacheKey, {
          binaryPath: packaged.binary,
          bundleDir: dirname(packaged.binary),
          revision: revision ?? null,
          adapterId: side.adapter.id,
          projectDir,
          runId: runDir.split(/[\\/]/).pop(),
          adaptations: adaptation.applied,
        });
      }
    } else {
      log.warn(`packaging failed (exit ${packaged.result?.code}): ${packaged.error ?? 'see package log'}`);
      const fallback = side.project.adapters.find((a) => a.kind !== 'packaged-binary');
      if (fallback) {
        log.warn(`falling back to adapter ${fallback.id} for ${label}`);
        side.adapter = fallback;
        side.package.fallbackAdapter = fallback.id;
      } else {
        side.prepareError = 'packaging failed and no fallback adapter is available';
        return side;
      }
    }
  }
  return side;
}

/** Run probes for one prepared side. */
async function exerciseSide({ side, runId, runDir, workDir, config, scenario, extraArgs, extraEnv, portOffset = 0 }) {
  if (side.prepareError || !side.adapter) {
    side.launch = { reachedReady: false, attempts: [], crashSummary: side.prepareError ?? 'not prepared' };
    side.probes = [];
    return side;
  }

  const sideDir = await ensureDir(join(runDir, 'sides', side.label));
  side.launch = await launchApp({
    projectDir: side.projectDir,
    project: side.project,
    adapter: side.adapter,
    label: side.label,
    runDir: sideDir,
    workDir,
    config,
    extraArgs,
    env: extraEnv,
    portOffset,
    packagedBinary: side.packagedBinary ?? null,
  });

  if (!side.launch.reachedReady) {
    side.probes = [];
    return side;
  }

  // Let each window finish its first render before probing, so fingerprints are not
  // taken mid-render and the visual probe is not fooled by an empty first paint.
  side.settleMs = [];
  for (const page of side.launch.pages ?? []) {
    const elapsed = await page.waitForSettled({ timeoutMs: config.settleTimeoutMs ?? 30000 }).catch(() => null);
    side.settleMs.push(elapsed);
  }
  if (side.settleMs.some((ms) => ms !== null)) {
    log.info(`[${side.label}] windows settled in ${side.settleMs.filter((ms) => ms !== null).join(', ')} ms`);
  }

  // While the app is live, collect definitive side-effect evidence: a held
  // single-instance lock, or a fixed listening port. The diff scan can only guess;
  // this observes.
  try {
    const extension = process.platform === 'win32' ? '.exe' : '';
    const binaryName = side.packagedBinary
      ? basename(side.packagedBinary)
      : side.project?.productName
        ? `${side.project.productName}${extension}`
        : null;
    side.runtimeSideEffects = await assessRuntimeSideEffects({
      launch: side.launch,
      imageName: binaryName,
      // Our own debugging ports are not the app's side effects.
      ignorePorts: [config.ports.cdp, config.ports.inspect, config.ports.cdp + 100, config.ports.inspect + 100],
      artifactsDir: join(sideDir, 'artifacts'),
    });
    if (side.runtimeSideEffects.signals.length > 0) {
      log.warn(`[${side.label}] ${describeSideEffects(side.runtimeSideEffects)}`);
    } else {
      log.info(`[${side.label}] no lock and no fixed port: overlapping exercise would not collide`);
    }
  } catch (error) {
    side.runtimeSideEffects = { level: 'unknown', signals: [], error: error.message };
  }

  side.probes = await runProbes({
    launch: side.launch,
    project: side.project,
    artifactsDir: join(sideDir, 'artifacts'),
    config,
    scenario: scenario ?? suggestScenario({ highRiskAreas: [] }, null),
  });

  try {
    await side.launch.close();
  } catch {}
  return side;
}

/** Load a scenario JSON file, if given. */
export async function loadScenario(pathOrNull) {
  if (!pathOrNull) return null;
  const scenario = await readJson(pathOrNull, null);
  if (!scenario) throw new Error(`scenario file not found or invalid JSON: ${pathOrNull}`);
  if (!Array.isArray(scenario.steps)) throw new Error(`scenario ${pathOrNull} must have a "steps" array`);
  return scenario;
}

/** Main entry used by the CLI. */
export async function runPipeline(options) {
  const config = await loadConfig(options.configOverrides ?? {});
  const startedAt = new Date();
  const runId = options.runId ?? `${timestampId(startedAt)}-${shortHash(options.repoUrl ?? 'local', String(options.pr ?? options.range ?? ''))}`;
  const runDir = await ensureDir(join(RUNS_DIR, runId));
  const logDir = await ensureDir(join(runDir, 'logs'));
  const workDir = await ensureDir(WORK_DIR);

  log.step(`run ${runId}`);
  log.info(`run directory: ${runDir}`);

  const meta = {
    runId,
    runDir,
    harnessDir: HARNESS_DIR,
    harnessVersion: await readHarnessVersion(),
    processVersion: await readText(join(ROOT, 'process', 'VERSION'), 'unversioned').then((v) => v.trim()).catch(() => 'unversioned'),
    startedAt: startedAt.toISOString(),
    repoUrl: options.repoUrl,
    pr: options.pr ?? null,
    range: options.range ?? null,
    adapterId: options.adapterId ?? null,
    scenarioPath: options.scenarioPath ?? null,
    env: {
      platform: `${platform()} ${release()}`,
      arch: arch(),
      node: process.version,
      cpus: cpus().length,
      totalMemoryGb: Math.round(totalmem() / 1024 ** 3),
      session: process.env.SESSIONNAME ?? null,
    },
    launchNotes: [],
    limitations: [],
  };

  const scenario = await loadScenario(options.scenarioPath);
  const extraArgs = options.extraArgs ?? [];
  const extraEnv = options.extraEnv ?? {};

  let changeset = null;
  let triage = null;
  let repoDir = null;
  let base = null;
  let head = null;

  try {
    // ---- acquire ---------------------------------------------------------
    if (options.repoDir) {
      repoDir = options.repoDir;
      log.info(`using existing checkout ${repoDir}`);
    } else {
      const acquired = await acquire({
        repoUrl: options.repoUrl,
        pr: options.pr,
        range: options.range,
        workDir,
        runDir,
        config,
        force: options.forceClone === true,
      });
      repoDir = acquired.repoDir;
      changeset = acquired.changeset;
      var trees = acquired;
    }

    if (!changeset) {
      // Local-checkout mode has no change set; build a trivial one so the report renders.
      changeset = {
        kind: 'working-copy',
        repo: { cloneUrl: repoDir, owner: 'local', name: repoDir.split(/[\\/]/).pop() },
        base: { ref: 'HEAD', sha: 'unknown' },
        head: { ref: 'HEAD', sha: 'unknown' },
        mergeBase: 'unknown',
        files: [],
        totals: { files: 0, additions: 0, deletions: 0, commits: 0 },
      };
    }

    meta.reproduce = options.reproduceCommand ?? buildReproduceCommand(options);

    // ---- triage and side-effect assessment --------------------------------
    // Both depend only on the change set, so they run before anything is built or
    // launched - which is what lets the side-effect verdict gate the launch strategy
    // instead of merely describing it afterwards.
    triage = triageChangeset(changeset);
    await writeJson(join(runDir, 'triage.json'), triage);

    const staticSideEffects = assessStaticSideEffects({ changeset, triage });
    log.raw('');
    log.step('side-effect assessment');
    log.info(describeSideEffects(staticSideEffects));
    for (const signal of staticSideEffects.signals) {
      log.info(`  ${signal.id}: ${signal.files.slice(0, 3).join(', ')}${signal.fileCount > 3 ? ` (+${signal.fileCount - 3} more)` : ''}`);
    }

    // ---- prepare + exercise ---------------------------------------------
    const only = options.only ?? 'both';
    const wantsBase = only !== 'head' && trees?.baseDir;
    const wantsHead = only !== 'base';

    const baseDir = trees?.baseDir ?? repoDir;
    const headDir = trees?.headDir ?? repoDir;

    // Base and head are completely independent, and the expensive part of a run is
    // install + package. Running them concurrently roughly halves wall-clock time.
    // Each side gets its own port range and its own launch directory.
    const plans = [];
    if (wantsBase) plans.push({ label: 'base', projectDir: baseDir, revision: changeset.base?.sha, portOffset: 0 });
    if (wantsHead) plans.push({ label: 'head', projectDir: headDir, revision: changeset.head?.sha, portOffset: 100 });

    const prepareOne = async (plan) => {
      const prepared = await prepareSide({
        label: plan.label,
        projectDir: plan.projectDir,
        revision: plan.revision,
        runDir,
        workDir,
        config,
        adapterId: options.adapterId,
        frozen: options.frozen,
        skipInstall: options.skipInstall,
        logDir,
      });
      // Record where this side's build lives, so `ebb explore` and `ebb play` can
      // relaunch it in seconds instead of rebuilding the app to iterate on a script.
      prepared.build = {
        projectDir: plan.projectDir,
        revision: plan.revision ?? null,
        adapterId: prepared.adapter?.id ?? null,
        packagedBinary: prepared.packagedBinary ?? null,
        cacheHit: prepared.cacheHit === true,
        adaptations: prepared.adaptations ?? [],
      };
      return prepared;
    };

    // Phase 1: prepare. Installing and packaging dominate a cold run's wall clock and
    // need no window, no display and no port, so they are safe to run concurrently.
    const parallelPrepare = config.parallelPrepare !== false && plans.length > 1;
    if (parallelPrepare) log.info('building both revisions concurrently (no app windows yet)');
    const prepared = parallelPrepare
      ? await Promise.all(plans.map(prepareOne))
      : await (async () => {
        const sequential = [];
        for (const plan of plans) sequential.push(await prepareOne(plan));
        return sequential;
      })();

    // Phase 2: exercise. Launching and probing is deliberately SERIAL by default.
    // Two Electron instances on screen at once are indistinguishable (identical window
    // titles), double the startup work each app does, and would break outright any app
    // that takes a single-instance lock. Only the GUI phase has this problem, and it
    // is not where the time goes.
    // Overlapping exercise is permitted only when the change carries no sign of
    // external effects. `--parallel-exercise` is a request, not an override: two runs
    // that can affect each other do not produce a sound comparison, and the person
    // asking for speed cannot know that from the outside.
    const requestedParallel = config.parallelExercise === true && prepared.length > 1;
    const parallelExercise = requestedParallel && parallelExerciseAllowed(staticSideEffects);
    if (requestedParallel && !parallelExercise) {
      log.warn('parallel exercise was requested but is not permitted for this change:');
      log.warn('  two runs that share ports, a config file or a lock cannot be compared.');
      log.warn('  Set parallelExercise:false to silence this, or split the change into independent parts.');
    }

    const finished = [];
    if (parallelExercise) {
      log.warn('parallelExercise is on and permitted: two app instances will be on screen at once');
      finished.push(...await Promise.all(prepared.map((side, index) => exerciseSide({
        side, runId, runDir, workDir, config, scenario, extraArgs, extraEnv, portOffset: plans[index].portOffset,
      }))));
    } else {
      for (const [index, side] of prepared.entries()) {
        if (prepared.length > 1) log.info(`testing ${plans[index].label} now; the other revision is not running`);
        finished.push(await exerciseSide({
          side, runId, runDir, workDir, config, scenario, extraArgs, extraEnv, portOffset: plans[index].portOffset,
        }));
      }
    }

    for (const [index, plan] of plans.entries()) {
      if (plan.label === 'base') base = finished[index];
      else head = finished[index];
    }

    // ---- analyse ---------------------------------------------------------
    log.raw('');
    log.step('analysing');
    for (const line of triage.summary) log.info(line);

    // Fold the triage into the auto-scenario when the caller did not supply one.
    const effectiveScenario = scenario ?? suggestScenario(triage, changeset);

    // Re-run the scenario-aware probe only when a caller scenario exists; the
    // auto scenario is already covered by the generic probes.
    let comparison = null;
    let summary = null;
    if (base && head) {
      comparison = compareRuns({ base, head, launchBase: base.launch, launchHead: head.launch });
    } else if (head ?? base) {
      summary = summariseRun(head ?? base);
    }

    // ---- report ----------------------------------------------------------
    const run = { meta, changeset, triage, base, head, comparison, summary };

    // Surface every build adaptation in the report: the reader must know that the
    // packaged artifact was not produced with the repository's shipped settings.
    const adaptations = [
      ...(base?.adaptations ?? []).map((item) => ({ ...item, side: 'base' })),
      ...(head?.adaptations ?? []).map((item) => ({ ...item, side: 'head' })),
    ];
    meta.adaptations = adaptations;
    if (adaptations.length > 0) {
      meta.limitations.push(...describeAdaptations(adaptations));
    }

    // Combine what the diff suggested with what the live app actually showed, and
    // record which exercise mode that forced.
    const runtimeAssessments = [base, head].map((side) => side?.runtimeSideEffects).filter(Boolean);
    const runtimeWorst = runtimeAssessments.find((a) => a.level === 'likely') ?? runtimeAssessments[0] ?? { level: 'none', signals: [] };
    const sideEffects = combineSideEffects(staticSideEffects, runtimeWorst);
    sideEffects.exerciseMode = parallelExercise ? 'parallel' : 'serial';
    sideEffects.parallelRequested = requestedParallel;
    sideEffects.runtimeDetail = runtimeWorst.detail ?? [];
    meta.sideEffects = sideEffects;

    if (sideEffects.level !== 'none') {
      meta.limitations.push(
        `External side effects were detected, so the two revisions were exercised one at a time: ${sideEffects.signals.map((s) => `${s.id} - ${s.reason}`).join('; ')}. Overlapping them could have made them interfere with each other and invalidated the comparison.`,
      );
    }
    if (runtimeWorst.level === 'likely') {
      // Remember it, so a later run does not have to rediscover the same thing.
      const capabilitiesPath = join(WORK_DIR, 'capabilities.json');
      const capabilities = await readJson(capabilitiesPath, {});
      await writeJson(capabilitiesPath, {
        ...capabilities,
        sideEffectsLikely: true,
        sideEffectsReason: runtimeWorst.signals.map((s) => s.id),
        sideEffectsSeenAt: new Date().toISOString(),
      });
    }
    meta.limitations.push(`Probes ran against a build produced locally on ${platform()}; platform-specific packaging, code signing and auto-update behaviour are out of scope.`);
    if (Object.keys(extraEnv).length > 0) {
      // A run that redirects the app's profile must say so - and one that does not
      // must not claim it did. A reader reproducing this has to know whether the app
      // touched real files or fixture files.
      const keys = Object.keys(extraEnv);
      const profileKeys = keys.filter((key) => /^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|DSH_HOME|XDG_)/i.test(key));
      const consequence = profileKeys.length > 0
        ? `${profileKeys.join(', ')} redirect the app's profile, so every file this change reads, backs up or writes went to that sandbox rather than the tester's real profile.`
        : "None of them redirect the profile, so the app still read and wrote the tester's real files.";
      meta.launchNotes.push(`The launched app was given environment overrides: ${keys.join(', ')}. ${consequence}`);
    }
    if ((head ?? base)?.launch?.driver && (head ?? base).launch.driver !== 'playwright') {
      meta.limitations.push(`Interaction steps ran through the "${(head ?? base).launch.driver}" driver, so they did not use Playwright's actionability checks.`);
    }

    const durationMs = Date.now() - startedAt.getTime();
    run.meta.durationMs = durationMs;
    run.meta.scenarioSource = scenario ? 'file' : 'auto-generated';
    run.meta.effectiveScenario = effectiveScenario;

    const verdict = comparison?.verdict ?? summary?.verdict ?? 'UNKNOWN';
    run.meta.verdict = verdict;

    const { markdownPath, jsonPath } = await writeReports(run);

    log.raw('');
    log.step(`verdict: ${verdict}`);
    log.ok(`report: ${markdownPath}`);
    log.info(`machine-readable: ${jsonPath}`);

    return { runId, runDir, verdict, markdownPath, jsonPath, comparison, summary, base, head, changeset, triage };
  } finally {
    // Never leave app processes behind, even on failure.
    for (const side of [base, head]) {
      try {
        await side?.launch?.close?.();
      } catch {}
    }
    if (head?.project?.productName) await sweepProcesses(`${head.project.productName}.exe`).catch(() => {});
  }
}

function buildReproduceCommand(options) {
  const parts = ['node ./bin/ebb.mjs run'];
  if (options.repoUrl) parts.push(`--repo ${options.repoUrl}`);
  if (options.pr) parts.push(`--pr ${options.pr}`);
  if (options.range) parts.push(`--range "${options.range}"`);
  if (options.adapterId) parts.push(`--adapter ${options.adapterId}`);
  if (options.only && options.only !== 'both') parts.push(`--only ${options.only}`);
  if (options.scenarioPath) parts.push(`--scenario "${options.scenarioPath}"`);
  for (const [key, value] of Object.entries(options.extraEnv ?? {})) parts.push(`--env "${key}=${value}"`);
  return parts.join(' ');
}

/** List previous runs, newest first. */
export async function listRuns() {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(RUNS_DIR, { withFileTypes: true }).catch(() => []);
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(RUNS_DIR, entry.name);
    const report = await readJson(join(dir, 'report.json'), null);
    const changeset = await readJson(join(dir, 'changeset.json'), null);

    // `ebb acquire` writes only a change set; `ebb run` additionally writes a report.
    const verdict = report?.meta?.verdict ?? (changeset ? 'change-set-only' : 'incomplete');
    const subject = report?.changeset?.pullRequest
      ? `PR #${report.changeset.pullRequest.number}`
      : report?.changeset?.range
        ? `${report.changeset.range.from}..${report.changeset.range.to}`
        : changeset?.pullRequest
          ? `PR #${changeset.pullRequest.number}`
          : changeset?.range
            ? `${changeset.range.from}..${changeset.range.to}`
            : '-';

    // Sort on the recorded start time, not the directory name: names are prefixed
    // (`acquire-…`) or timestamped, and comparing them as strings interleaves the
    // two families incorrectly.
    const startedAt = report?.meta?.startedAt ?? changeset?.generatedAt ?? null;

    runs.push({
      runId: entry.name,
      verdict,
      startedAt,
      subject,
      kind: report ? 'run' : changeset ? 'acquire' : 'incomplete',
      report: join(dir, 'report.json'),
      sortKey: startedAt ?? entry.name,
    });
  }
  return runs.sort((a, b) => String(b.sortKey).localeCompare(String(a.sortKey)));
}

export { buildEnv, ensureDir, writeJson, writeText, log };
