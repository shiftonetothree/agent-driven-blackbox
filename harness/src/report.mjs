/**
 * Report generation: a human-readable Markdown report plus a machine-readable
 * JSON companion. Both are written into the run directory.
 */
import { basename, join, relative } from 'node:path';
import { writeJson, writeText } from './util.mjs';

const STATUS_BADGE = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', error: 'ERROR', skip: 'skip', missing: '-' };
const SEVERITY_ORDER = { blocker: 0, major: 1, minor: 2, info: 3 };

function rel(from, to) {
  return relative(from, to).split('\\').join('/');
}

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => `| ${cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join(' | ')} |`;
  return [line(headers), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`, ...rows.map(line)].join('\n');
}

/** Build the Markdown report body. */
export function renderMarkdown(run) {
  const { changeset, triage, comparison, base, head, meta } = run;
  const lines = [];
  const push = (...values) => lines.push(...values);

  const verdict = comparison?.verdict ?? run.summary?.verdict ?? 'UNKNOWN';
  const verdictNote =
    verdict === 'REGRESSION' ? '**A behavioural regression was found.**'
      : verdict === 'CHANGED' ? '**Behaviour changed; review the deltas below.**'
        : verdict === 'NO_REGRESSION' ? 'No regression detected.'
          : verdict === 'PASS' ? 'All probes passed.'
            : verdict === 'FAIL' ? '**Probe failures detected.**'
              : verdict === 'WARN' ? 'Probes completed with warnings.'
                : '**The result is inconclusive; see the launch section.**';

  push(`# Electron black-box test report`);
  push('');
  push(`> ${verdictNote}`);
  if (meta.scenarioSource !== 'file') {
    push('>');
    push(`> **Coverage caveat.** No scenario was written for this change, so the run used a`);
    push(`> generated smoke script. It proves the app still starts, renders and logs no`);
    push(`> errors - it does **not** exercise the changed code. Read section 4 before`);
    push(`> drawing a conclusion from the verdict above.`);
  }
  push('');

  // ---- subject -----------------------------------------------------------
  push(`## 1. Subject under test`);
  push('');
  const pr = changeset?.pullRequest;
  push(table([
    ['Repository', changeset?.repo?.cloneUrl ?? meta.repoUrl],
    ['Change', changeset?.kind === 'pull-request' ? `Pull request #${pr?.number ?? '?'}${pr?.title ? ` - ${pr.title}` : ''}` : `Commit range ${changeset?.range?.from}..${changeset?.range?.to}`],
    ['Merge base', changeset?.mergeBase?.slice(0, 12) ?? '-'],
    ['Base revision', `${changeset?.base?.ref ?? '?'} @ ${changeset?.base?.sha?.slice(0, 12) ?? '?'}`],
    ['Head revision', `${changeset?.head?.ref ?? '?'} @ ${changeset?.head?.sha?.slice(0, 12) ?? '?'}`],
    ['Diff size', `${changeset?.totals?.files ?? 0} file(s), +${changeset?.totals?.additions ?? 0}/-${changeset?.totals?.deletions ?? 0}, ${changeset?.totals?.commits ?? 0} commit(s)`],
    ['Electron', head?.project?.electron?.installed ?? base?.project?.electron?.installed ?? (head?.project?.electron?.declared ?? base?.project?.electron?.declared ?? null) ?? 'unknown'],
    ['Toolchain', head?.project?.toolchain ?? base?.project?.toolchain ?? 'unknown'],
    ['Run id', meta.runId],
    ['Started', meta.startedAt],
    ['Duration', `${Math.round((meta.durationMs ?? 0) / 1000)} s`],
    ['Harness', `ebb ${meta.harnessVersion} (process ${meta.processVersion})`],
  ], ['Field', 'Value']));
  push('');

  if (pr?.body) {
    push(`<details><summary>Pull request description</summary>`);
    push('');
    push('```');
    push(String(pr.body).slice(0, 4000));
    push('```');
    push('');
    push(`</details>`);
    push('');
  }

  // ---- change triage -----------------------------------------------------
  if (triage) {
    push(`## 2. Change triage`);
    push('');
    push('Each changed file is mapped to a risk area, which decides which probes matter most.');
    push('');
    push(table(
      triage.areas.map((a) => [a.area, a.files.length, `+${a.additions}/-${a.deletions}`, a.probes.join(', ') || '-']),
      ['Risk area', 'Files', 'Churn', 'Priority probes'],
    ));
    push('');
    push(`<details><summary>Changed files (${changeset?.files?.length ?? 0})</summary>`);
    push('');
    push(table(
      (changeset?.files ?? []).map((f) => [f.status, f.path, `+${f.additions}`, `-${f.deletions}`]),
      ['', 'Path', '+', '-'],
    ));
    push('');
    push(`</details>`);
    push('');
  }

  // ---- launch ------------------------------------------------------------
  push(`## 3. Launch`);
  push('');
  const sides = [
    base ? { label: 'base', side: base } : null,
    head ? { label: 'head', side: head } : null,
  ].filter(Boolean);

  push(table(
    sides.map(({ label, side }) => [
      label,
      side.launch?.reachedReady ? 'ready' : 'FAILED',
      side.launch?.adapter?.id ?? '-',
      (side.launch?.argSet?.args ?? []).join(' ') || '(none)',
      side.launch?.version?.Browser ?? '-',
      `${side.launch?.durationMs ?? '-'} ms`,
    ]),
    ['Side', 'Result', 'Adapter', 'Launch flags', 'Engine', 'Time to ready'],
  ));
  push('');

  if (meta.launchNotes?.length) {
    for (const note of meta.launchNotes) push(`- ${note}`);
    push('');
  }

  const failedLaunch = sides.find(({ side }) => !side.launch?.reachedReady);
  if (failedLaunch) {
    push(`> The ${failedLaunch.label} revision never reached a debuggable state. Every probe below is therefore **inconclusive**, and the crash evidence is the primary result.`);
    push('');
    push(table(
      (failedLaunch.side.launch?.attempts ?? []).map((a) => [a.driver ?? '-', a.label, a.crashKind ?? '-', a.exitCode ?? '-', `${a.durationMs ?? '-'} ms`]),
      ['Driver', 'Flag set', 'Failure', 'Exit code', 'Duration'],
    ));
    push('');
    const stderr = (failedLaunch.side.launch?.stderr ?? '').trim();
    if (stderr) {
      push(`<details><summary>${failedLaunch.label} process stderr (tail)</summary>`);
      push('');
      push('```');
      push(stderr.split('\n').slice(-60).join('\n'));
      push('```');
      push('');
      push(`</details>`);
      push('');
    }
  }

  // ---- build adaptations -------------------------------------------------
  if ((meta.adaptations ?? []).length > 0) {
    push(`### Build adaptations applied`);
    push('');
    push(`> **Read this before trusting the packaged result.** To observe the app, the`);
    push(`> harness changed packaging configuration inside the run's disposable worktree.`);
    push(`> Application source was not modified, and the cached clone and your repository`);
    push(`> were not touched — but the packaged artifact below does **not** use the`);
    push(`> repository's shipped settings.`);
    push('');
    push(table(
      meta.adaptations.map((item) => [item.side, basename(item.file), item.title, item.changes.map((c) => `${c.option}=${c.value}`).join(', ')]),
      ['Side', 'File', 'Adaptation', 'Change'],
    ));
    push('');
    for (const item of meta.adaptations) {
      push(`<details><summary>${item.side} / ${basename(item.file)} — ${item.title}</summary>`);
      push('');
      push(item.reason);
      push('');
      if ((item.lines ?? []).length > 0) {
        push('```diff');
        for (const line of item.lines) {
          push(`@@ line ${line.line} @@`);
          push(`- ${String(line.before).trim()}`);
          push(`+ ${String(line.after).trim()}`);
        }
        push('```');
        push('');
      }
      push(`</details>`);
      push('');
    }
  }

  // ---- side effects ------------------------------------------------------
  if (meta.sideEffects) {
    const side = meta.sideEffects;
    push(`### Side-effect assessment`);
    push('');
    if (side.level === 'none') {
      push(`No external side effects detected (diff scan and live inspection of the running app). Exercising the two revisions one at a time is not required for correctness, but remains the default.`);
    } else {
      push(`> **The two revisions were exercised one at a time, and must be.**`);
      push(`>`);
      push(`> A separate \`--user-data-dir\` keeps each app's own profile apart, but says`);
      push(`> nothing about ports, locks, shared configuration files, containers or remote`);
      push(`> state. Two overlapping runs that share any of those can interfere with each`);
      push(`> other, and a comparison between them would not mean anything.`);
      push('');
      push(table(
        side.signals.map((signal) => [
          signal.kind === 'runtime' ? 'observed on the live app' : 'inferred from the diff',
          signal.id,
          signal.reason,
        ]),
        ['Evidence', 'Signal', 'Why it forbids overlapping runs'],
      ));
      push('');
    }
    push(`Exercise mode: **${side.exerciseMode}**${side.parallelRequested && side.exerciseMode === 'serial' ? ' (parallel was requested and refused)' : ''}.`);
    push('');
  }

  // ---- test script -------------------------------------------------------
  {
    const tailored = meta.scenarioSource === 'file';
    push(`## 4. Test script`);
    push('');
    if (tailored) {
      push(`A scenario written for this change was used (\`${meta.scenarioPath ?? 'supplied file'}\`). Its steps are the assertions this report actually rests on.`);
    } else {
      push(`> **No scenario was written for this change.** The run used a generated smoke`);
      push(`> script, which only proves the app still starts and renders. A "no regression"`);
      push(`> verdict says nothing about whether the changed code works.`);
      push('');
      push('To test the change itself: `ebb scenario <runId>` -> `ebb explore <runId>` -> edit -> `ebb play <runId> --scenario <file>` -> re-run with `--scenario`.');
    }
    push('');
    const steps = meta.effectiveScenario?.steps ?? [];
    if (steps.length > 0) {
      push(table(
        steps.map((step, index) => [
          index + 1,
          step.action,
          step.selector ?? step.name ?? (step.expression ? String(step.expression).slice(0, 48) : step.key ?? step.ms ?? ''),
          step.severity ?? '',
          step.optional === true ? 'optional' : '',
        ]),
        ['#', 'Action', 'Target', 'Severity', 'Flags'],
      ));
      push('');
    }
    for (const { label, side } of sides) {
      const probe = (side.probes ?? []).find((p) => p.id === 'scenario');
      if (!probe || probe.status === 'skip') continue;
      const executedSteps = probe.metrics?.executed ?? 0;
      const failedSteps = probe.metrics?.failed ?? 0;
      push(`- **${label}**: ${executedSteps} step(s) executed, ${failedSteps} failed, real user input: ${probe.metrics?.usedRealInput === true ? 'yes' : 'no'}`);
    }
    push('');
  }

  // ---- results matrix ----------------------------------------------------
  if (comparison) {
    push(`## 5. Probe results: base vs head`);
    push('');
    push(table(
      comparison.comparisons.map((c) => [c.title, STATUS_BADGE[c.baseStatus] ?? c.baseStatus, STATUS_BADGE[c.headStatus] ?? c.headStatus, c.classification, Object.keys(c.metricDeltas).length]),
      ['Probe', 'base', 'head', 'Verdict', 'Metric deltas'],
    ));
    push('');

    const moved = comparison.comparisons.filter((c) => Object.keys(c.metricDeltas).length > 0);
    if (moved.length > 0) {
      push(`### Metric deltas`);
      push('');
      for (const entry of moved) {
        push(`**${entry.title}**`);
        push('');
        push(table(
          Object.entries(entry.metricDeltas).map(([metric, d]) => [metric, d.base, d.head, d.delta > 0 ? `+${d.delta}` : d.delta]),
          ['Metric', 'base', 'head', 'Δ'],
        ));
        push('');
      }
    }
  } else if (run.summary) {
    push(`## 5. Probe results`);
    push('');
    push(table(
      (head ?? base).probes.map((p) => [p.title, STATUS_BADGE[p.status] ?? p.status, p.findings.length]),
      ['Probe', 'Status', 'Findings'],
    ));
    push('');
  }

  // ---- findings ----------------------------------------------------------
  const findings = (comparison?.findings ?? run.summary?.findings ?? []).slice().sort(
    (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
  );

  push(`## 6. Findings`);
  push('');
  if (findings.length === 0) {
    push('No findings. Every probe that ran produced its expected result.');
    push('');
  } else {
    for (const [index, item] of findings.entries()) {
      push(`### ${index + 1}. [${(item.severity ?? 'minor').toUpperCase()}] ${item.classification ?? ''} ${item.message}`);
      push('');
      if (item.evidence !== undefined && item.evidence !== null) {
        const rendered = typeof item.evidence === 'string' ? item.evidence : JSON.stringify(item.evidence, null, 2);
        if (rendered && rendered !== '[]' && rendered !== '{}') {
          push('<details><summary>Evidence</summary>');
          push('');
          push('```json');
          push(rendered.slice(0, 3000));
          push('```');
          push('');
          push('</details>');
          push('');
        }
      }
    }
  }

  // ---- artifacts ---------------------------------------------------------
  const artifacts = [];
  for (const { label, side } of sides) {
    for (const probe of side.probes ?? []) {
      for (const artifact of probe.artifacts ?? []) {
        artifacts.push({ side: label, probe: probe.id, path: artifact });
      }
    }
  }

  push(`## 7. Evidence artifacts`);
  push('');
  if (artifacts.length === 0) {
    push('No artifacts were captured.');
    push('');
  } else {
    push(table(artifacts.map((a) => [a.side, a.probe, `[${a.path.split(/[\\/]/).pop()}](<${rel(meta.runDir, a.path)}>)`]), ['Side', 'Probe', 'File']));
    push('');
    const screenshots = artifacts.filter((a) => a.path.endsWith('.png'));
    if (screenshots.length > 0) {
      push(`### Screenshots`);
      push('');
      for (const shot of screenshots) {
        push(`**${shot.side} / ${shot.probe}** - \`${shot.path.split(/[\\/]/).pop()}\``);
        push('');
        push(`![${shot.side} ${shot.probe}](<${rel(meta.runDir, shot.path)}>)`);
        push('');
      }
    }
  }

  // ---- environment & reproduction ----------------------------------------
  push(`## 8. Environment`);
  push('');
  push(table([
    ['Host', `${meta.env.platform} ${meta.env.arch} (${meta.env.cpus} cpu, ${meta.env.totalMemoryGb} GB)`],
    ['Node', meta.env.node],
    ['Session', meta.env.session ?? '-'],
    ['Run directory', `\`${meta.runDir}\``],
  ], ['Field', 'Value']));
  push('');

  push(`## 9. Reproduce this run`);
  push('');
  push('```bash');
  push(`cd "${meta.harnessDir}"`);
  push(meta.reproduce);
  push('```');
  push('');

  push(`## 10. Method and limitations`);
  push('');
  push(...(meta.limitations ?? ['- None recorded.']).map((l) => `- ${l}`));
  push('');

  return `${lines.join('\n')}\n`;
}

/** Write both reports and return their paths. */
export async function writeReports(run) {
  const markdownPath = join(run.meta.runDir, 'report.md');
  const jsonPath = join(run.meta.runDir, 'report.json');
  await writeText(markdownPath, renderMarkdown(run));
  await writeJson(jsonPath, {
    meta: run.meta,
    changeset: run.changeset,
    triage: run.triage,
    comparison: run.comparison,
    summary: run.summary,
    probeResults: {
      base: run.base ? { launch: stripLaunch(run.base.launch), build: run.base.build ?? null, probes: run.base.probes } : null,
      head: run.head ? { launch: stripLaunch(run.head.launch), build: run.head.build ?? null, probes: run.head.probes } : null,
    },
  });
  return { markdownPath, jsonPath };
}

/** Reduce a launch handle to its serialisable fields. */
function stripLaunch(launch) {
  if (!launch) return null;
  const { child, pages, mainEvaluate, refreshPages, windowCount, close, adapter, argSet, ...rest } = launch;
  return { ...rest, adapterId: adapter?.id ?? null, launchFlags: argSet?.args ?? [] };
}

export { rel };
