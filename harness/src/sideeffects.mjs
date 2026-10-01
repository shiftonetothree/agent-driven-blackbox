/**
 * Side-effect assessment: decide automatically whether two revisions may be exercised
 * at the same time.
 *
 * Two runs may only overlap when they cannot affect each other. Separate
 * `--user-data-dir` covers the app's *own* profile, and that is all it covers. An
 * Electron app routinely reaches beyond it:
 *
 *   - it may take a single-instance lock, in which case the second instance exits and
 *     the run silently tests one revision twice while reporting two;
 *   - it may bind a fixed TCP port, so the second instance either fails to start its
 *     service or - worse - talks to the first instance's service;
 *   - the change under test may write to a shared file, registry key, container or
 *     remote service. The reference project's PR #85 exists precisely to sync a
 *     shared DSH configuration file, so two overlapping runs could clobber each
 *     other's config and produce a differential that means nothing.
 *
 * A human should not have to work that out per repository, so the harness does:
 * definitive runtime evidence (lock held, fixed port bound) is checked on the live
 * app, and the diff is scanned for the kinds of change that imply external effects.
 * Anything above `none` forbids overlapping exercise, whatever was requested.
 */
import { join } from 'node:path';
import { run, writeJson } from './util.mjs';

/**
 * Diff-level markers for "this change touches something outside the process".
 *
 * Deliberately conservative: a false positive costs a little wall-clock, a false
 * negative makes the comparison unsound.
 */
const STATIC_SIGNALS = [
  { id: 'service', pattern: /(^|\/)[\w.-]*(service|daemon|worker)[\w.-]*(\/|\.|$)/i, reason: 'manages a background service, which usually has ports, files or a lifecycle outside the app' },
  { id: 'install', pattern: /(install|uninstall|setup|provision)/i, reason: 'installs or removes something on the host' },
  { id: 'sync-config', pattern: /(sync|backup|restore|migrate|import-config|export-config)/i, reason: 'writes to a shared configuration or backup location' },
  { id: 'config-file', pattern: /(^|\/)[\w.-]*config[\w.-]*\.(ts|js|mjs|cjs|json|toml|ya?ml)$/i, reason: 'reads or writes shared configuration files' },
  { id: 'container', pattern: /(docker|podman|wsl|containerd|kubernetes|hyper-v)/i, reason: 'drives a container or VM runtime shared by the whole machine' },
  { id: 'system-integration', pattern: /(tray|autostart|autolaunch|registry|shortcut|file-association|protocol-handler)/i, reason: 'changes system integration state' },
  { id: 'network-transfer', pattern: /(torrent|webtorrent|magnet|download|dlc|update-check|release-fetch)/i, reason: 'performs transfers with side effects outside the sandbox' },
  { id: 'fixed-port', pattern: /(localhost|127\.0\.0\.1|0\.0\.0\.0)[^\d]{0,4}(port)?\s*[:=]?\s*(8\d{3}|[1-9]\d{3})/i, reason: 'references what looks like a fixed local port' },
];

/** Ports below this are not in the ephemeral range, so two instances can collide. */
const EPHEMERAL_PORT_FLOOR = 49152;

/**
 * Scan the change set for external-effect markers.
 * Returns `{ level, signals }` where level is 'none' | 'possible'.
 */
export function assessStaticSideEffects({ changeset, triage } = {}) {
  const signals = [];
  const files = (changeset?.files ?? []).map((f) => f.path);

  for (const rule of STATIC_SIGNALS) {
    const hits = files.filter((path) => rule.pattern.test(path));
    if (hits.length > 0) {
      signals.push({ id: rule.id, kind: 'static', reason: rule.reason, files: hits.slice(0, 8), fileCount: hits.length });
    }
  }

  // A change that adds a large service module is telling even without a keyword match.
  const serviceAreas = (triage?.areas ?? []).filter((area) => area.area === 'main-process');
  const mainProcessChurn = serviceAreas.reduce((sum, area) => sum + area.additions, 0);
  if (mainProcessChurn >= 200) {
    signals.push({
      id: 'large-main-process-change',
      kind: 'static',
      reason: `the diff adds ${mainProcessChurn} lines to the main process, which is where privileged and side-effecting work lives`,
      files: serviceAreas.flatMap((a) => a.files.map((f) => f.path)).slice(0, 8),
      fileCount: serviceAreas.reduce((n, a) => n + a.files.length, 0),
    });
  }

  return { level: signals.length > 0 ? 'possible' : 'none', signals };
}

/** Parse `netstat -ano -p TCP` output into listening sockets. */
export function parseListeningPorts(netstatOutput) {
  const results = [];
  for (const line of String(netstatOutput).split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5) continue;
    const [protocol, local, , state, pid] = columns;
    if (!/^TCP/i.test(protocol)) continue;
    if (state !== 'LISTENING') continue;
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    if (!Number.isInteger(port)) continue;
    results.push({ port, pid: Number(pid) });
  }
  return results;
}

/** PIDs for a process image name, via tasklist. */
export async function pidsForImage(imageName) {
  const result = await run('tasklist', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH'], { timeoutMs: 30000 });
  const pids = [];
  for (const line of String(result.stdout ?? '').split('\n')) {
    // "image","pid","session","session#","mem"
    const match = line.match(/^"[^"]+","(\d+)"/);
    if (match) pids.push(Number(match[1]));
  }
  return pids;
}

/**
 * Listening ports currently owned by the app's own processes.
 *
 * A port below the ephemeral floor is fixed enough that a second instance would
 * collide with it - either failing to start or, worse, silently using the first
 * instance's service.
 */
export async function fixedPortsForImage(imageName, { ignorePorts = [] } = {}) {
  if (process.platform !== 'win32') return { ports: [], available: false };
  const pids = await pidsForImage(imageName);
  if (pids.length === 0) return { ports: [], available: true };

  const netstat = await run('netstat', ['-ano', '-p', 'TCP'], { timeoutMs: 30000 });
  if (netstat.code !== 0) return { ports: [], available: false };

  const owned = parseListeningPorts(netstat.stdout).filter((entry) => pids.includes(entry.pid));
  const fixed = owned.filter((entry) => entry.port < EPHEMERAL_PORT_FLOOR && !ignorePorts.includes(entry.port));
  return { ports: fixed, allPorts: owned, available: true, pidCount: pids.length };
}

/**
 * Ask the live main process what it knows about its own exclusivity.
 *
 * `app.hasSingleInstanceLock()` is true when the app took a single-instance lock,
 * which is definitive: a second instance would exit immediately.
 */
export async function assessRuntimeSideEffects({ launch, imageName, ignorePorts = [], artifactsDir = null }) {
  const signals = [];

  // 1. Single-instance lock - definitive.
  try {
    const lock = await launch.mainEvaluate(({ app }) => {
      let held = null;
      try {
        held = app.hasSingleInstanceLock();
      } catch {}
      return {
        held,
        userData: (() => { try { return app.getPath('userData'); } catch { return null; } })(),
        appData: (() => { try { return app.getPath('appData'); } catch { return null; } })(),
        logs: (() => { try { return app.getPath('logs'); } catch { return null; } })(),
      };
    });
    if (lock?.held === true) {
      signals.push({
        id: 'single-instance-lock',
        kind: 'runtime',
        reason:
          'the app takes a single-instance lock, so it assumes it is the only instance on the machine. '
          + 'It very likely owns OS-level state that two overlapping runs would contend for (tray icon, global shortcuts, '
          + 'file associations, protocol handlers, a shared config file). Note the lock is scoped to the user-data directory, '
          + 'so the harness\'s separate --user-data-dir does NOT stop a second test instance from running - which is exactly '
          + 'why this has to be a signal rather than something the lock enforces for us.',
        evidence: lock,
      });
    }
    if (lock) signals.push({ id: '_paths', kind: 'runtime', silent: true, evidence: lock });
  } catch {
    // No inspector (packaged build with fuses off) - the port check still applies.
  }

  // 2. Fixed listening ports - definitive enough.
  if (imageName) {
    const ports = await fixedPortsForImage(imageName, { ignorePorts });
    if (ports.ports.length > 0) {
      signals.push({
        id: 'fixed-port',
        kind: 'runtime',
        reason: `the app is listening on ${ports.ports.map((p) => p.port).join(', ')}, so two instances would collide or share a service`,
        evidence: ports.ports,
      });
    }
    if (ports.available) {
      signals.push({ id: '_ports', kind: 'runtime', silent: true, evidence: { listening: ports.allPorts ?? [], fixed: ports.ports } });
    }
  }

  const visible = signals.filter((s) => s.silent !== true);
  if (artifactsDir) {
    await writeJson(join(artifactsDir, 'side-effects.json'), { signals, visible }).catch(() => {});
  }
  return { level: visible.some((s) => s.kind === 'runtime') ? 'likely' : 'none', signals: visible, detail: signals.filter((s) => s.silent === true) };
}

/** Combine the two assessments; runtime evidence outranks the diff heuristic. */
export function combineSideEffects(staticAssessment, runtimeAssessment) {
  const signals = [...(staticAssessment?.signals ?? []), ...(runtimeAssessment?.signals ?? [])];
  const level = (runtimeAssessment?.signals?.length ?? 0) > 0
    ? 'likely'
    : (staticAssessment?.signals?.length ?? 0) > 0
      ? 'possible'
      : 'none';
  return { level, signals, detail: runtimeAssessment?.detail ?? [] };
}

/**
 * Whether overlapping exercise is permitted.
 * Only a clean `none` allows it; anything else forbids it regardless of request.
 */
export function parallelExerciseAllowed(assessment) {
  return (assessment?.level ?? 'possible') === 'none';
}

/** One-line summary for logs and reports. */
export function describeSideEffects(assessment) {
  if (!assessment || assessment.level === 'none') {
    return 'No external side effects detected; overlapping exercise would be safe.';
  }
  const reasons = assessment.signals.map((s) => `${s.id}: ${s.reason}`);
  return `${assessment.level === 'likely' ? 'External side effects detected' : 'Possible external side effects'} (${reasons.length}) - overlapping exercise is not permitted. ${reasons.join(' | ')}`;
}

export { EPHEMERAL_PORT_FLOOR };
