/**
 * Analysis: turn a change set into a test plan, and turn two probe runs into a
 * verdict per probe.
 *
 * This is where black-box testing stops being a smoke test: the diff decides which
 * risk areas matter, and the base/head comparison decides what actually regressed.
 */

// ---------------------------------------------------------------------------
// change triage
// ---------------------------------------------------------------------------

/**
 * Risk areas, most specific first. Each entry names the area, the probes that are
 * most likely to expose a defect there, and the reason a reviewer should care.
 */
const RISK_RULES = [
  {
    area: 'repo-config',
    probes: [],
    reason: 'Repository hygiene files have no runtime effect.',
    match: (p) => /(^|\/)\.(gitignore|gitattributes|editorconfig|prettierrc|prettierignore|eslintignore|npmignore|gitkeep)$/i.test(p),
  },
  {
    area: 'security-config',
    probes: ['main-process', 'windows'],
    reason: 'Changes to window or session security settings alter the app trust boundary.',
    match: (p) => /(contextIsolation|nodeIntegration|webPreferences|sandbox|webSecurity|csp|content-security)/i.test(p),
  },
  {
    area: 'preload-bridge',
    probes: ['main-process', 'console', 'scenario'],
    reason: 'The preload script is the only bridge between renderer and main; contract breaks surface as runtime errors.',
    match: (p) => /(preload|bridge|contextBridge|ipcRenderer)/i.test(p),
  },
  {
    area: 'main-process',
    probes: ['main-process', 'windows', 'console'],
    reason: 'Main-process changes affect startup, window lifecycle and privileged operations.',
    // Anything under a `main/` (or `electron/`/`background/`) tree, not just the
    // entry file: services, workers and helpers living there are all privileged.
    match: (p) => !/renderer/i.test(p) && (
      /(^|\/)(main|electron|background)\//i.test(p)
      || /(^|\/)(main|app|background)\.(ts|tsx|js|mjs|cjs)$/i.test(p)
    ),
  },
  {
    area: 'ipc',
    probes: ['main-process', 'scenario', 'console'],
    reason: 'IPC contract changes break silently unless both sides are exercised.',
    match: (p) => /(ipc|channel|invoke|handler|bridge)/i.test(p),
  },
  {
    area: 'dependency',
    probes: ['main-process', 'console', 'visual'],
    reason: 'Dependency changes can alter runtime behaviour, bundle size and startup.',
    match: (p) => /(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|npm-shrinkwrap\.json)$/i.test(p),
  },
  {
    area: 'build-config',
    probes: ['windows', 'visual'],
    reason: 'Build and packaging configuration affects what actually ships.',
    match: (p) => /(forge\.config|electron-builder|webpack|vite\.config|rollup|esbuild|tsconfig|\.npmrc|electron\.vite)/i.test(p),
  },
  {
    area: 'native-module',
    probes: ['main-process', 'console'],
    reason: 'Native addons are ABI-sensitive and can fail to load at runtime.',
    match: (p) => /(\.node$|node-gyp|prebuild|binding\.gyp)/i.test(p),
  },
  {
    area: 'renderer-ui',
    probes: ['visual', 'scenario', 'console'],
    reason: 'UI changes are only observable by rendering and interacting with the app.',
    match: (p) => /\.(tsx|jsx|css|scss|less|sass|html|vue|svelte)$/i.test(p) || /renderer/i.test(p),
  },
  {
    area: 'assets',
    probes: ['visual'],
    reason: 'Asset changes show up as missing or broken visuals.',
    match: (p) => /\.(png|jpe?g|svg|gif|ico|icns|woff2?|ttf|otf|mp3|mp4|webm)$/i.test(p),
  },
  {
    area: 'localization',
    probes: ['visual', 'scenario'],
    reason: 'Locale changes can produce missing or untranslated strings.',
    match: (p) => /(i18n|l10n|locale|lang|messages\.)/i.test(p),
  },
  {
    area: 'tests-and-docs',
    probes: [],
    reason: 'Changes here do not affect runtime behaviour.',
    match: (p) => /(^|\/)(test|tests|__tests__|spec|docs?|\.github)(\/|$)|\.(md|mdx)$|\.test\.|\.spec\./i.test(p),
  },
];

/** Map each changed file to a risk area. */
export function triageChangeset(changeset) {
  const areas = new Map();
  for (const file of changeset.files ?? []) {
    const rule = RISK_RULES.find((candidate) => candidate.match(file.path)) ?? {
      area: 'other',
      probes: ['console', 'visual'],
      reason: 'Unclassified change; covered by the default probe set.',
    };
    if (!areas.has(rule.area)) {
      areas.set(rule.area, { area: rule.area, reason: rule.reason, probes: [...rule.probes], files: [], additions: 0, deletions: 0 });
    }
    const entry = areas.get(rule.area);
    entry.files.push({ path: file.path, status: file.status, additions: file.additions, deletions: file.deletions });
    entry.additions += file.additions;
    entry.deletions += file.deletions;
  }

  const ordered = [...areas.values()].sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions));
  /** Areas with no runtime effect must never drive probe prioritisation. */
  const NON_RUNTIME_AREAS = new Set(['tests-and-docs', 'repo-config', 'assets']);
  const highRisk = ordered.filter((a) => !NON_RUNTIME_AREAS.has(a.area));

  return {
    areas: ordered,
    highRiskAreas: highRisk.map((a) => a.area),
    prioritisedProbes: [...new Set(highRisk.flatMap((a) => a.probes))],
    summary: ordered.map((a) => `${a.area}: ${a.files.length} file(s) +${a.additions}/-${a.deletions}`),
  };
}

/**
 * Derive a small, high-signal interaction scenario from the change shape.
 *
 * The harness deliberately keeps this generic: it exercises the surfaces every
 * Electron app has (window present, document settled, no error UI) plus any
 * scenario the agent supplies. Repo-specific flows belong in a scenario file.
 */
export function suggestScenario(triage, changeset) {
  const steps = [
    { action: 'wait', ms: 1500 },
    { action: 'assertSelector', selector: 'body', severity: 'blocker' },
    { action: 'eval', expression: 'document.readyState' },
    { action: 'assertNoConsoleErrors', severity: 'major' },
    { action: 'screenshot', name: 'settled' },
  ];
  return { source: 'auto', steps, rationale: triage.highRiskAreas };
}

/**
 * What a test author needs to know about each risk area, to write a script that
 * actually exercises this change rather than the app in general.
 */
const AREA_HINTS = {
  'security-config': 'The diff touches window/session security. Assert the observable consequence in the UI, and read the resulting preferences back from the main process.',
  'preload-bridge': 'The diff touches the preload bridge. Call the exposed API from the page (for example `await window.<bridge>.<method>()`) and assert on the resolved value, not just that the page loaded.',
  'main-process': 'The diff touches the main process. Drive the feature through the UI that triggers it, and assert the resulting window state or persisted value rather than only that startup succeeded.',
  ipc: 'The diff touches an IPC contract. Exercise both ends: trigger the renderer action that sends the message, then assert on what the main process did with it.',
  dependency: 'The diff changes dependencies. Check for changed runtime behaviour in console output and main-process versions, and re-exercise the feature that uses the dependency.',
  'build-config': 'The diff changes build/packaging configuration. Only a packaged build can show the effect; assert on assets actually loading from the bundle.',
  'native-module': 'The diff touches a native addon. Assert the code path that loads it runs without throwing.',
  'renderer-ui': 'The diff touches the renderer. Wait for the changed component to mount, then assert its content and interact with it.',
  assets: 'The diff changes assets. Assert the images/icons actually load (naturalWidth > 0) rather than merely being present in the DOM.',
  localization: 'The diff touches localization. Assert the rendered strings for the locale under test, not just that the page rendered.',
  other: 'Unclassified change. Start by mapping the UI with `ebb explore`, then assert the most load-bearing path you can reach.',
  'tests-and-docs': 'Documentation/test-only change; no runtime behaviour to assert.',
  'repo-config': 'Repository hygiene change; no runtime behaviour to assert.',
};

/**
 * Build a starting scenario for one specific change.
 *
 * The point is to remove the blank page, not to guess the test: it names the risk
 * areas, lists the files that changed in each, and explains what a meaningful
 * assertion for that area would look like. Everything it emits still has to be
 * replaced with real selectors — which is what `ebb explore` is for.
 */
export function scaffoldScenario({ changeset, triage, explored = null }) {
  const targets = (triage?.areas ?? [])
    .filter((area) => area.probes.length > 0)
    .map((area) => ({
      area: area.area,
      churn: `+${area.additions}/-${area.deletions}`,
      files: area.files.map((f) => f.path),
      hint: AREA_HINTS[area.area] ?? AREA_HINTS.other,
      suggestedProbes: area.probes,
    }));

  const steps = [
    { action: 'wait', ms: 1500 },
    {
      action: 'eval',
      expression: "[...document.querySelectorAll('[data-testid],button,a[href],input,select,textarea')].slice(0,30).map(e=>({tag:e.tagName.toLowerCase(),id:e.id||null,testid:e.getAttribute('data-testid'),text:(e.innerText||e.value||'').trim().slice(0,40)})).filter(e=>e.text||e.id||e.testid)",
      $comment: 'Discovery: run once with `ebb play` and read the returned array. Replace the steps below with real selectors from it, or use `ebb explore` for the full map.',
      optional: true,
    },
    { action: 'assertSelector', selector: 'body', severity: 'blocker' },
    { action: 'screenshot', name: 'initial', $comment: 'Then navigate to the surface this change affects.' },
    { action: 'assertNoConsoleErrors', severity: 'major', $comment: 'Fails on any console error seen so far.' },
  ];

  if (explored) {
    steps.push({
      action: 'eval',
      expression: 'document.title',
      $comment: `Exploration found ${explored.interactiveCount ?? 0} interactive element(s); see ${explored.path ?? 'the interaction map'}.`,
      optional: true,
    });
  }

  return {
    $comment: [
      'Scenario for ONE specific change. Generated as a starting point — replace the steps with real assertions.',
      '',
      'Workflow:',
      '  1. ebb explore <runId> --side head    # map real selectors, IPC channels and menu items',
      '  2. edit the steps below',
      '  3. ebb play <runId> --scenario <this file>   # seconds per attempt',
      '  4. ebb run <repo> --pr <n> --scenario <this file>   # full differential run',
      '',
      'A generic smoke scenario only proves the app still starts. It cannot tell you whether',
      'this change works, and a "no regression" verdict from it is weak evidence.',
    ].join('\n'),
    generatedAt: new Date().toISOString(),
    subject: changeset?.pullRequest
      ? `PR #${changeset.pullRequest.number}: ${changeset.pullRequest.title}`
      : changeset?.range
        ? `Range ${changeset.range.from}..${changeset.range.to}`
        : 'unknown change',
    targets,
    steps,
  };
}

// ---------------------------------------------------------------------------
// base/head comparison
// ---------------------------------------------------------------------------

const STATUS_RANK = { pass: 0, skip: 0, warn: 1, fail: 2, error: 3 };

/** Numeric metrics worth diffing between the two sides. */
const COMPARABLE_METRICS = [
  'windowCount',
  'appWindowCount',
  'consoleErrors',
  'consoleWarnings',
  'exceptions',
  'logErrors',
  'severeErrors',
  'nonCanceledFailures',
  'totalTextLength',
  'totalElements',
  'newExceptions',
];

/**
 * Compare the two probe runs.
 *
 * Classification rules:
 *   REGRESSION   head fails/warns where base passed
 *   FIXED        head passes where base failed/warned
 *   CHANGED      both ran, a comparable metric moved materially
 *   FLAKY        same status but a metric moved both ways across reloads
 *   INCONCLUSIVE the head side never reached a runnable state
 */
export function compareRuns({ base, head, launchBase, launchHead }) {
  const comparisons = [];
  const findings = [];

  if (!launchHead?.ok) {
    findings.push({
      severity: 'blocker',
      classification: 'INCONCLUSIVE',
      message: 'The head revision could not be launched, so no behavioural comparison is possible.',
      evidence: head?.launch?.attempts ?? [],
    });
  }

  // An empty probe set is not evidence of health. Without this guard a launch that
  // silently skipped its probes would compare nothing to nothing and report
  // NO_REGRESSION - a false pass, and the single most damaging result this tool
  // could produce.
  const baseProbeCount = (base?.probes ?? []).length;
  const headProbeCount = (head?.probes ?? []).length;
  if (baseProbeCount === 0 || headProbeCount === 0) {
    findings.push({
      severity: 'blocker',
      classification: 'INCONCLUSIVE',
      message: `No probes produced results (base: ${baseProbeCount}, head: ${headProbeCount}), so nothing was actually compared.`,
      evidence: {
        base: { reachedReady: launchBase?.reachedReady ?? null, attempts: launchBase?.attempts ?? [] },
        head: { reachedReady: launchHead?.reachedReady ?? null, attempts: launchHead?.attempts ?? [] },
      },
    });
    return {
      comparisons,
      findings,
      verdict: 'INCONCLUSIVE',
      counts: { regression: 0, fixed: 0, changed: 0, unchanged: 0, inconclusive: 0 },
    };
  }

  const baseById = new Map((base?.probes ?? []).map((p) => [p.id, p]));
  const headById = new Map((head?.probes ?? []).map((p) => [p.id, p]));

  for (const id of new Set([...baseById.keys(), ...headById.keys()])) {
    const b = baseById.get(id);
    const h = headById.get(id);
    const entry = {
      id,
      title: h?.title ?? b?.title ?? id,
      baseStatus: b?.status ?? 'missing',
      headStatus: h?.status ?? 'missing',
      classification: 'UNCHANGED',
      metricDeltas: {},
    };

    const baseRank = STATUS_RANK[b?.status] ?? 0;
    const headRank = STATUS_RANK[h?.status] ?? 0;

    if (baseRank <= 0 && headRank >= 1) entry.classification = 'REGRESSION';
    else if (baseRank >= 1 && headRank <= 0) entry.classification = 'FIXED';
    else if (headRank > baseRank) entry.classification = 'REGRESSION';
    else if (headRank < baseRank) entry.classification = 'FIXED';
    else if (!b || !h) entry.classification = 'INCONCLUSIVE';

    for (const metric of COMPARABLE_METRICS) {
      const before = b?.metrics?.[metric];
      const after = h?.metrics?.[metric];
      if (typeof before === 'number' && typeof after === 'number' && before !== after) {
        entry.metricDeltas[metric] = { base: before, head: after, delta: after - before };
      }
    }

    if (entry.classification === 'UNCHANGED' && Object.keys(entry.metricDeltas).length > 0) {
      entry.classification = 'CHANGED';
    }

    comparisons.push(entry);

    if (entry.classification === 'REGRESSION') {
      findings.push({
        severity: 'major',
        classification: 'REGRESSION',
        message: `Probe "${entry.title}" regressed: ${entry.baseStatus} -> ${entry.headStatus}.`,
        evidence: h?.findings ?? [],
      });
    }
    if (entry.classification === 'FIXED') {
      findings.push({
        severity: 'info',
        classification: 'FIXED',
        message: `Probe "${entry.title}" improved: ${entry.baseStatus} -> ${entry.headStatus}.`,
        evidence: [],
      });
    }
  }

  // Head-only findings are the actual defects introduced by the change.
  for (const probe of head?.probes ?? []) {
    if (probe.status !== 'fail' && probe.status !== 'error') continue;
    const baseProbe = baseById.get(probe.id);
    if (baseProbe && (baseProbe.status === 'fail' || baseProbe.status === 'error')) continue;
    for (const item of probe.findings) {
      findings.push({ severity: item.severity ?? 'major', classification: 'INTRODUCED', message: `[${probe.id}] ${item.message}`, evidence: item.evidence });
    }
  }

  const worst = comparisons.reduce((acc, c) => {
    const rank = c.classification === 'REGRESSION' ? 3 : c.classification === 'INCONCLUSIVE' ? 2 : c.classification === 'CHANGED' ? 1 : 0;
    return Math.max(acc, rank);
  }, 0);

  return {
    comparisons,
    findings,
    verdict: !launchHead?.ok ? 'INCONCLUSIVE' : worst >= 3 ? 'REGRESSION' : worst >= 1 ? 'CHANGED' : 'NO_REGRESSION',
    counts: {
      regression: comparisons.filter((c) => c.classification === 'REGRESSION').length,
      fixed: comparisons.filter((c) => c.classification === 'FIXED').length,
      changed: comparisons.filter((c) => c.classification === 'CHANGED').length,
      unchanged: comparisons.filter((c) => c.classification === 'UNCHANGED').length,
      inconclusive: comparisons.filter((c) => c.classification === 'INCONCLUSIVE').length,
    },
  };
}

// ---------------------------------------------------------------------------
// single-side (head-only) summarisation
// ---------------------------------------------------------------------------

/** Summarise one side's probes when only one revision is run. */
export function summariseRun(run) {
  const probes = run.probes ?? [];
  const findings = [];
  for (const probe of probes) {
    for (const item of probe.findings) {
      if (item.severity === 'info') continue;
      findings.push({ severity: item.severity ?? 'minor', classification: probe.status === 'fail' ? 'FAILED' : 'OBSERVED', message: `[${probe.id}] ${item.message}`, evidence: item.evidence });
    }
  }
  const counts = {
    pass: probes.filter((p) => p.status === 'pass').length,
    warn: probes.filter((p) => p.status === 'warn').length,
    fail: probes.filter((p) => p.status === 'fail').length,
    error: probes.filter((p) => p.status === 'error').length,
    skip: probes.filter((p) => p.status === 'skip').length,
  };
  // Same guard as the differential path: no probes means no verdict, not a pass.
  if (probes.length === 0) {
    findings.push({
      severity: 'blocker',
      classification: 'INCONCLUSIVE',
      message: 'No probes produced results, so there is nothing to report on.',
      evidence: run.launch?.attempts ?? [],
    });
    return { findings, counts, verdict: 'INCONCLUSIVE' };
  }
  const verdict = !run.launch?.reachedReady
    ? 'INCONCLUSIVE'
    : counts.fail + counts.error > 0
      ? 'FAIL'
      : counts.warn > 0
        ? 'WARN'
        : 'PASS';
  return { findings, counts, verdict };
}
