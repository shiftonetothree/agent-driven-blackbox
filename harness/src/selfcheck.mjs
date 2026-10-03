/**
 * `ebb selfcheck` - validate the harness itself.
 *
 * This is the safety net that makes the process safely iterable: after any edit to
 * the harness, this runs offline (no network, no Electron) and asserts that every
 * module still loads, the fixtures are intact, the change-triage rules behave, the
 * comparison logic classifies correctly, and the report renders.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { HARNESS_DIR, ROOT, readJson } from './util.mjs';

/** Local existence check so the self-check does not import node:fs at module scope. */
async function pathExistsFromNode(path) {
  const { stat } = await import('node:fs/promises');
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function test(name, fn) {
  return { name, fn };
}

const TESTS = [
  test('node version supports the harness (>=22 for global WebSocket)', () => {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 22) throw new Error(`node ${process.versions.node} is too old; global WebSocket requires node >= 22`);
    return `node ${process.versions.node}`;
  }),

  test('every harness module imports cleanly', async () => {
    const modules = ['util', 'cdp', 'driver', 'adapt', 'buildcache', 'acquire', 'detect', 'launch', 'probes', 'analyze', 'report', 'minidump', 'doctor', 'explore', 'session', 'run'];
    const loaded = [];
    for (const name of modules) {
      await import(`./${name}.mjs`);
      loaded.push(name);
    }
    return `${loaded.length} modules: ${loaded.join(', ')}`;
  }),

  test('playwright-core is installed and exposes the Electron driver', async () => {
    const { loadPlaywright } = await import('./driver.mjs');
    const playwright = await loadPlaywright();
    if (playwright === null) {
      throw new Error('playwright-core is missing; run `npm install` inside harness/');
    }
    if (typeof playwright.launch !== 'function') throw new Error('_electron.launch is not a function');
    const version = await import('node:fs/promises')
      .then((fs) => fs.readFile(new URL('../node_modules/playwright-core/package.json', import.meta.url), 'utf8'))
      .then((text) => JSON.parse(text).version)
      .catch(() => 'unknown');
    return `playwright-core ${version}, _electron.launch available`;
  }),

  test('both drivers expose the same page surface', async () => {
    const { DOM_FINGERPRINT_EXPRESSION, classifyExit } = await import('./driver.mjs');
    for (const token of ['textLength', 'elementCount', 'textHash', 'readyState']) {
      if (!DOM_FINGERPRINT_EXPRESSION.includes(token)) throw new Error(`DOM fingerprint no longer reports ${token}`);
    }
    // The interface the probes rely on: async methods and live getters.
    const methods = ['title', 'url', 'evaluate', 'screenshot', 'domFingerprint', 'waitForSelector', 'waitForSettled', 'click', 'fill', 'press', 'textContent', 'reload'];
    const getters = ['target', 'errors'];
    const source = await (await import('node:fs/promises')).readFile(new URL('./driver.mjs', import.meta.url), 'utf8');
    for (const method of methods) {
      const occurrences = source.split(`async ${method}(`).length - 1;
      if (occurrences < 2) throw new Error(`"${method}" is implemented by ${occurrences} driver(s); both must provide it`);
    }
    for (const getter of getters) {
      const occurrences = source.split(`get ${getter}()`).length - 1;
      if (occurrences < 2) throw new Error(`"${getter}" is implemented by ${occurrences} driver(s); both must provide it`);
    }
    if (classifyExit(-1073741819) !== 'ACCESS_VIOLATION') throw new Error('exit classification moved');
    return `${methods.length} methods and ${getters.length} getters on both drivers`;
  }),

  test('process documents exist', async () => {
    const required = ['process/PROCESS.md', 'process/VERSION', 'AGENTS.md', 'README.md'];
    const missing = required.filter((rel) => !existsSync(join(ROOT, rel)));
    if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`);
    return required.join(', ');
  }),

  test('smoke fixture is valid JSON and defines a main entry', async () => {
    const pkg = JSON.parse(await readFile(join(HARNESS_DIR, 'fixtures', 'smoke-app', 'package.json'), 'utf8'));
    if (pkg.main !== 'main.js') throw new Error('fixture main entry changed');
    const main = await readFile(join(HARNESS_DIR, 'fixtures', 'smoke-app', 'main.js'), 'utf8');
    for (const token of ['app.on', 'BrowserWindow', 'handshake.json']) {
      if (!main.includes(token)) throw new Error(`fixture main.js no longer references ${token}`);
    }
    return 'fixtures/smoke-app ok';
  }),

  test('default config is well formed', async () => {
    const { DEFAULT_CONFIG } = await import('./util.mjs');
    if (!Array.isArray(DEFAULT_CONFIG.launchArgSets) || DEFAULT_CONFIG.launchArgSets.length === 0) {
      throw new Error('launchArgSets must be a non-empty array');
    }
    for (const set of DEFAULT_CONFIG.launchArgSets) {
      if (!Array.isArray(set.args)) throw new Error('each launch arg set needs an args array');
    }
    if (typeof DEFAULT_CONFIG.ports?.cdp !== 'number' || typeof DEFAULT_CONFIG.ports?.inspect !== 'number') {
      throw new Error('ports.cdp and ports.inspect must be numbers');
    }
    return `${DEFAULT_CONFIG.launchArgSets.length} launch arg sets, cdp port ${DEFAULT_CONFIG.ports.cdp}`;
  }),

  test('change triage classifies representative paths', async () => {
    const { triageChangeset } = await import('./analyze.mjs');
    const changeset = {
      files: [
        { path: 'src/main.ts', status: 'M', additions: 10, deletions: 2 },
        { path: 'src/main/services/model-sync.ts', status: 'A', additions: 90, deletions: 0 },
        { path: 'src/preload.ts', status: 'M', additions: 3, deletions: 0 },
        { path: 'src/renderer/App.tsx', status: 'M', additions: 40, deletions: 5 },
        { path: 'package.json', status: 'M', additions: 1, deletions: 1 },
        { path: '.gitignore', status: 'M', additions: 4, deletions: 1 },
        { path: 'README.md', status: 'M', additions: 5, deletions: 0 },
      ],
    };
    const triage = triageChangeset(changeset);
    const areas = triage.areas.map((a) => a.area);
    for (const expected of ['main-process', 'preload-bridge', 'renderer-ui', 'dependency', 'repo-config', 'tests-and-docs']) {
      if (!areas.includes(expected)) throw new Error(`expected risk area "${expected}" but got: ${areas.join(', ')}`);
    }
    if (areas.includes('other')) throw new Error(`every path should be classified, but got "other" for: ${triage.areas.find((a) => a.area === 'other').files.map((f) => f.path).join(', ')}`);
    if (triage.highRiskAreas.includes('tests-and-docs')) throw new Error('documentation must not be high risk');
    if (triage.highRiskAreas.includes('repo-config')) throw new Error('repository hygiene files must not be high risk');
    const mainArea = triage.areas.find((a) => a.area === 'main-process');
    if (mainArea.files.length !== 2) throw new Error(`expected both src/main.ts and the nested service file under main-process, got ${mainArea.files.map((f) => f.path).join(', ')}`);
    return areas.join(', ');
  }),

  test('comparison detects regression, fix and change', async () => {
    const { compareRuns } = await import('./analyze.mjs');
    const probe = (id, status, metrics = {}) => ({ id, title: id, status, metrics, findings: [] });
    const result = compareRuns({
      base: { probes: [probe('a', 'pass'), probe('b', 'fail'), probe('c', 'pass', { consoleErrors: 0 })], launch: { reachedReady: true } },
      head: { probes: [probe('a', 'fail'), probe('b', 'pass'), probe('c', 'pass', { consoleErrors: 4 })], launch: { reachedReady: true } },
      launchBase: { ok: true },
      launchHead: { ok: true },
    });
    const byId = Object.fromEntries(result.comparisons.map((c) => [c.id, c.classification]));
    if (byId.a !== 'REGRESSION') throw new Error(`expected a=REGRESSION, got ${byId.a}`);
    if (byId.b !== 'FIXED') throw new Error(`expected b=FIXED, got ${byId.b}`);
    if (byId.c !== 'CHANGED') throw new Error(`expected c=CHANGED, got ${byId.c}`);
    if (result.verdict !== 'REGRESSION') throw new Error(`expected verdict REGRESSION, got ${result.verdict}`);
    return `regression/fixed/changed all classified; verdict ${result.verdict}`;
  }),

  test('a failed head launch yields an INCONCLUSIVE verdict', async () => {
    const { compareRuns } = await import('./analyze.mjs');
    const result = compareRuns({
      base: { probes: [], launch: { reachedReady: true } },
      head: { probes: [], launch: { reachedReady: false, attempts: [{ label: 'default', crashKind: 'ACCESS_VIOLATION', exitCode: -1073741819 }] } },
      launchBase: { ok: true },
      launchHead: { ok: false },
    });
    if (result.verdict !== 'INCONCLUSIVE') throw new Error(`expected INCONCLUSIVE, got ${result.verdict}`);
    if (!result.findings.some((f) => f.classification === 'INCONCLUSIVE')) throw new Error('expected an INCONCLUSIVE finding');
    return 'inconclusive handling ok';
  }),

  test('markdown report renders from a synthetic run', async () => {
    const { renderMarkdown } = await import('./report.mjs');
    const run = {
      meta: {
        runId: 'selfcheck', runDir: 'F:/tmp/selfcheck', harnessDir: HARNESS_DIR, harnessVersion: '0.1.0',
        processVersion: '0.1.0', startedAt: new Date().toISOString(), durationMs: 1234, verdict: 'CHANGED',
        reproduce: 'node ./bin/ebb.mjs run --repo x --pr 1',
        env: { platform: 'win32', arch: 'x64', cpus: 4, totalMemoryGb: 8, node: process.version, session: null },
        limitations: ['synthetic'],
      },
      changeset: {
        kind: 'pull-request', repo: { cloneUrl: 'https://example.invalid/x/y.git' },
        pullRequest: { number: 1, title: 'synthetic', body: 'body' },
        base: { ref: 'main', sha: 'aaaaaaaaaaaa' }, head: { ref: 'feature', sha: 'bbbbbbbbbbbb' },
        mergeBase: 'cccccccccccc', files: [{ status: 'M', path: 'src/main.ts', additions: 1, deletions: 1 }],
        totals: { files: 1, additions: 1, deletions: 1, commits: 1 },
      },
      triage: { areas: [{ area: 'main-process', files: [], additions: 1, deletions: 1, probes: ['main-process'], reason: 'r' }], highRiskAreas: ['main-process'], prioritisedProbes: ['main-process'], summary: ['main-process: 1 file(s) +1/-1'] },
      base: { launch: { reachedReady: true, adapter: { id: 'x' }, argSet: { args: [] }, durationMs: 10, version: { Browser: 'Electron/1' } }, probes: [], project: {} },
      head: { launch: { reachedReady: true, adapter: { id: 'x' }, argSet: { args: [] }, durationMs: 10, version: { Browser: 'Electron/1' } }, probes: [], project: {} },
      comparison: {
        verdict: 'CHANGED',
        comparisons: [{ id: 'console', title: 'Console', baseStatus: 'pass', headStatus: 'warn', classification: 'CHANGED', metricDeltas: { consoleErrors: { base: 0, head: 2, delta: 2 } } }],
        findings: [{ severity: 'major', classification: 'REGRESSION', message: 'synthetic finding', evidence: { a: 1 } }],
        counts: { regression: 0, fixed: 0, changed: 1, unchanged: 0, inconclusive: 0 },
      },
    };
    const markdown = renderMarkdown(run);
    for (const token of ['# Electron black-box test report', '## 4. Test script', '## 6. Findings', 'synthetic finding', 'Reproduce this run']) {
      if (!markdown.includes(token)) throw new Error(`report is missing: ${token}`);
    }

    // Without a scenario written for the change, the report must say so loudly:
    // a generic smoke result is weak evidence and must not read like a clean bill.
    if (!/No scenario was written for this change/.test(markdown)) {
      throw new Error('an auto-generated scenario does not produce a coverage warning');
    }
    if (!/Coverage caveat/.test(markdown)) {
      throw new Error('the report header does not carry a coverage caveat for generic coverage');
    }

    // With one, it must say that too - and name the file.
    const tailored = renderMarkdown({
      ...run,
      meta: { ...run.meta, scenarioSource: 'file', scenarioPath: 'harness/scenarios/pr85.json' },
    });
    if (!/A scenario written for this change was used/.test(tailored)) {
      throw new Error('a supplied scenario is not acknowledged in the report');
    }
    if (/Coverage caveat/.test(tailored)) {
      throw new Error('a supplied scenario still produces the generic-coverage caveat');
    }
    return `${markdown.split('\n').length} lines rendered; generic vs tailored coverage both handled`;
  }),

  test('minidump parser rejects non-dump input', async () => {
    const { parseMinidumpBuffer } = await import('./minidump.mjs');
    let threw = false;
    try {
      parseMinidumpBuffer(Buffer.from('not a dump at all, definitely not'), 'synthetic');
    } catch {
      threw = true;
    }
    if (!threw) throw new Error('expected the parser to reject non-minidump input');
    return 'rejects invalid input';
  }),

  test('scenario files are valid, and project scripts stay out of the framework', async () => {
    const { readdir } = await import('node:fs/promises');
    const { PROJECTS_DIR, projectScriptsDir, HARNESS_DIR: HD } = await import('./util.mjs');
    const HARNESS_SCENARIOS = join(HD, 'scenarios');

    const validate = async (dir, label) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const files = entries.filter((e) => e.isFile() && e.name.endsWith('.json'));
      for (const file of files) {
        const scenario = await readJson(join(dir, file.name), null);
        if (!scenario || !Array.isArray(scenario.steps)) throw new Error(`${label}/${file.name} must contain a "steps" array`);
        for (const [i, step] of scenario.steps.entries()) {
          if (typeof step.action !== 'string') throw new Error(`${label}/${file.name} step ${i} has no action`);
        }
      }
      return files.map((f) => f.name);
    };

    const generic = await validate(HARNESS_SCENARIOS, 'harness/scenarios');

    // The separation itself: project scripts must live outside the harness.
    const projectDir = projectScriptsDir('some-owner', 'some-repo');
    if (projectDir.startsWith(HD)) {
      throw new Error(`project scripts must not live inside the harness (got ${projectDir})`);
    }
    if (!projectDir.startsWith(PROJECTS_DIR)) {
      throw new Error(`project scripts must live under projects/ (got ${projectDir})`);
    }

    // A framework-owned scenario must be app-agnostic. A PR number or a run
    // timestamp in the filename is the tell-tale sign one leaked in.
    for (const name of generic) {
      if (/\bpr[-_]?\d+/i.test(name) || /\d{4}-\d{2}-\d{2}T/.test(name)) {
        throw new Error(`harness/scenarios/${name} looks repository-specific; move it to projects/<owner>__<repo>/scenarios/`);
      }
    }

    // Every repository folder must carry written-down knowledge, or the next run
    // re-learns it. Validate whatever is present rather than requiring any.
    const repos = (await readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory());
    const projectFiles = [];
    for (const repo of repos) {
      const notes = join(PROJECTS_DIR, repo.name, 'NOTES.md');
      if (!(await pathExistsFromNode(notes))) throw new Error(`projects/${repo.name} has no NOTES.md`);
      projectFiles.push(...(await validate(join(PROJECTS_DIR, repo.name, 'scenarios'), `projects/${repo.name}/scenarios`)));
    }

    return `${generic.length} generic (${generic.join(', ') || 'none'}); ${repos.length} project(s), ${projectFiles.length} project script(s)`;
  }),

  test('framework docs stay generic: no project slugs or commit hashes', async () => {
    const { readdir } = await import('node:fs/promises');
    const knowledgeDir = join(ROOT, 'process', 'knowledge');
    const docs = [
      join(ROOT, 'process', 'CHANGELOG.md'),
      join(ROOT, 'process', 'PROCESS.md'),
      join(ROOT, 'AGENTS.md'),
      ...(await readdir(knowledgeDir).catch(() => []))
        .filter((f) => f.endsWith('.md'))
        .map((f) => join(knowledgeDir, f)),
    ];
    // A specific project is identified by its `projects/<owner>__<repo>` directory, and a
    // specific run by a bare commit hash. Framework docs describe the framework; those two
    // belong in `projects/<owner>__<repo>/NOTES.md` instead. Placeholders like
    // `projects/<owner>__<repo>` use angle brackets and deliberately do not match.
    const projectSlug = /projects\/[A-Za-z0-9._-]+__[A-Za-z0-9._-]+/;
    const commitHash = /\b[0-9a-f]{7,40}\b/;
    for (const file of docs) {
      const text = await readFile(file, 'utf8');
      const rel = relative(ROOT, file);
      const slug = text.match(projectSlug);
      if (slug) {
        throw new Error(`${rel} names a specific project (${slug[0]}); per-repository records belong in projects/<owner>__<repo>/NOTES.md`);
      }
      const hash = text.match(commitHash);
      if (hash) {
        throw new Error(`${rel} records a commit hash (${hash[0]}); per-repository test records belong in projects/<owner>__<repo>/NOTES.md`);
      }
    }
    return `${docs.length} framework doc(s) checked for project leakage`;
  }),

  test('teardown is bounded so a stubborn app cannot stall a run', async () => {
    const { readFile } = await import('node:fs/promises');
    const driver = await readFile(new URL('./driver.mjs', import.meta.url), 'utf8');
    const util = await readFile(new URL('./util.mjs', import.meta.url), 'utf8');
    const cli = await readFile(new URL('../bin/ebb.mjs', import.meta.url), 'utf8');

    // An Electron app with a tray icon may never honour app.quit(); Playwright then
    // waits forever and the run dies before writing its report.
    if (!/appCloseTimeoutMs/.test(driver)) throw new Error('the graceful app close is no longer bounded');
    if (!/killTree\(/.test(driver)) throw new Error('the forced process-tree kill is gone');
    if (!/appCloseTimeoutMs:/.test(util)) throw new Error('appCloseTimeoutMs is not configurable');
    if (!/runTimeoutMs/.test(util)) throw new Error('the run-level watchdog budget is not configurable');
    if (!/watchdog/.test(cli)) throw new Error('the CLI no longer arms a run watchdog');
    return 'graceful close bounded, forced kill retained, run watchdog armed';
  }),

  test('windows command shims are launched correctly', async () => {
    const { buildSpawn, quoteWinArg, run } = await import('./util.mjs');

    if (quoteWinArg('plain') !== 'plain') throw new Error('arguments without spaces must not be quoted');
    if (quoteWinArg('a b') !== '"a b"') throw new Error(`expected "a b" but got ${quoteWinArg('a b')}`);
    // Only quoted arguments need trailing-backslash doubling, so that the run of
    // backslashes cannot escape the closing quote.
    if (quoteWinArg('trail \\') !== '"trail \\\\"') throw new Error(`a quoted trailing backslash must be doubled, got ${quoteWinArg('trail \\')}`);
    if (quoteWinArg('say "hi"') !== '"say \\"hi\\""') throw new Error(`embedded quotes must be escaped, got ${quoteWinArg('say "hi"')}`);

    if (process.platform === 'win32') {
      const shim = buildSpawn('npm', ['install', '--no-audit']);
      if (!/cmd\.exe$/i.test(shim.command)) throw new Error(`a .cmd shim must be launched through cmd.exe, got ${shim.command}`);
      if (shim.verbatim !== true) throw new Error('verbatim argument passing must be enabled for the shim path');
      const native = buildSpawn('tool.exe', ['--flag']);
      if (native.verbatim !== false || native.command !== 'tool.exe') throw new Error('native executables must be spawned directly');
    }

    // End-to-end: a package-manager shim must actually execute.
    const result = await run('npm', ['--version'], { timeoutMs: 60000 });
    if (result.code !== 0) throw new Error(`\`npm --version\` exited ${result.code}: ${(result.stderr || '').trim().slice(0, 200)}`);
    return `npm resolved to ${result.stdout.trim()} on ${process.platform}`;
  }),

  test('build adaptations rewrite only the intended fuse options', async () => {
    const { setFuseOption } = await import('./adapt.mjs');

    const forge = [
      'new FusesPlugin({',
      '  version: FuseVersion.V1,',
      '  [FuseV1Options.RunAsNode]: false,',
      '  [FuseV1Options.EnableNodeCliInspectArguments]: false,',
      '  [FuseV1Options.OnlyLoadAppFromAsar]: true,',
      '})',
    ].join('\n');

    const outcome = setFuseOption(forge, 'EnableNodeCliInspectArguments', true);
    if (!outcome.changed) throw new Error('expected the inspect fuse to be rewritten');
    if (!outcome.result.includes('[FuseV1Options.EnableNodeCliInspectArguments]: true')) {
      throw new Error('the inspect fuse was not set to true');
    }
    // Security-relevant fuses must survive untouched.
    for (const untouched of ['[FuseV1Options.RunAsNode]: false', '[FuseV1Options.OnlyLoadAppFromAsar]: true']) {
      if (!outcome.result.includes(untouched)) throw new Error(`adaptation modified an unrelated fuse: ${untouched}`);
    }

    // Plain-key syntax, as used by electron-builder afterPack hooks.
    const plain = setFuseOption('flipFuses(process.execPath, { EnableNodeCliInspectArguments: false })', 'EnableNodeCliInspectArguments', true);
    if (!plain.changed || !plain.result.includes('EnableNodeCliInspectArguments: true')) {
      throw new Error('plain-key fuse syntax was not rewritten');
    }

    // Idempotent: running it again must report no change.
    const again = setFuseOption(outcome.result, 'EnableNodeCliInspectArguments', true);
    if (again.changed) throw new Error('adaptation is not idempotent');
    return 'computed and plain fuse syntax rewritten; unrelated fuses and repeats untouched';
  }),

  test('an empty probe set can never produce a pass verdict', async () => {
    const { compareRuns, summariseRun } = await import('./analyze.mjs');

    // The dangerous case: both sides "launched" but nothing was actually probed.
    const differential = compareRuns({
      base: { probes: [], launch: { reachedReady: true } },
      head: { probes: [], launch: { reachedReady: true } },
      launchBase: { ok: true, reachedReady: true },
      launchHead: { ok: true, reachedReady: true },
    });
    if (differential.verdict !== 'INCONCLUSIVE') {
      throw new Error(`expected INCONCLUSIVE when no probes ran, got ${differential.verdict}`);
    }
    if (!differential.findings.some((f) => f.severity === 'blocker')) {
      throw new Error('an empty comparison must raise a blocker finding');
    }

    const single = summariseRun({ probes: [], launch: { reachedReady: true } });
    if (single.verdict !== 'INCONCLUSIVE') {
      throw new Error(`expected INCONCLUSIVE for a single-sided run with no probes, got ${single.verdict}`);
    }

    // …and a genuinely probed run still works.
    const healthy = compareRuns({
      base: { probes: [{ id: 'a', title: 'a', status: 'pass', metrics: {}, findings: [] }], launch: { reachedReady: true } },
      head: { probes: [{ id: 'a', title: 'a', status: 'pass', metrics: {}, findings: [] }], launch: { reachedReady: true } },
      launchBase: { ok: true, reachedReady: true },
      launchHead: { ok: true, reachedReady: true },
    });
    if (healthy.verdict !== 'NO_REGRESSION') throw new Error(`expected NO_REGRESSION for a healthy probed run, got ${healthy.verdict}`);
    return 'empty probe sets are INCONCLUSIVE; a probed clean run still reports NO_REGRESSION';
  }),

  test('a successful launch reports reachedReady so probes are never skipped', async () => {
    const source = await (await import('node:fs/promises')).readFile(new URL('./launch.mjs', import.meta.url), 'utf8');
    // The pipeline gates probing on `reachedReady`; the drivers report `ok`. Any
    // change that drops this translation silently skips every probe.
    if (!/reachedReady:\s*true/.test(source)) throw new Error('launchApp no longer sets reachedReady: true on success');
    if (!/if \(!side\.launch\.reachedReady\)/.test(await (await import('node:fs/promises')).readFile(new URL('./run.mjs', import.meta.url), 'utf8'))) {
      throw new Error('the pipeline no longer gates probing on reachedReady; revisit this invariant');
    }
    return 'launch success normalises ok -> reachedReady, and the pipeline gates on it';
  }),

  test('probe module resolves every helper it calls', async () => {
    // A missing import here aborts a run only after both revisions have been built,
    // which is an expensive way to find a typo.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./probes.mjs', import.meta.url), 'utf8');
    const imported = new Set();
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
      for (const name of match[1].split(',')) imported.add(name.trim().split(/\s+as\s+/).pop());
    }
    const used = new Set([...source.matchAll(/\b(ensureDir|writeJson|writeText|sleep|createHash|join|sha1)\s*\(/g)].map((m) => m[1]));
    const missing = [...used].filter((name) => !imported.has(name) && name !== 'sha1');
    if (missing.length > 0) throw new Error(`probes.mjs calls ${missing.join(', ')} without importing it/them`);
    return `${used.size} helpers resolved`;
  }),

  test('build cache keys distinguish exactly the things that change a build', async () => {
    const { buildCacheKey, adaptationSignature } = await import('./buildcache.mjs');

    const base = { revision: 'abc123', adapterId: 'forge-package' };
    const k1 = buildCacheKey(base);
    if (k1 !== buildCacheKey({ ...base })) throw new Error('the same inputs must produce the same key');
    if (k1 === buildCacheKey({ ...base, revision: 'def456' })) throw new Error('a different revision must not collide');
    if (k1 === buildCacheKey({ ...base, adapterId: 'builder-package' })) throw new Error('a different adapter must not collide');

    // The critical one: an adapted build must never be reused for a run that asked
    // for the repository's shipped packaging configuration.
    const adapted = adaptationSignature([{ id: 'forge-fuse-node-cli-inspect', file: 'forge.config.ts', changes: [{ option: 'EnableNodeCliInspectArguments', value: true }] }]);
    const shipped = adaptationSignature([]);
    if (adapted === shipped) throw new Error('an adapted build must not share a key with an unadapted one');
    if (buildCacheKey({ ...base, adaptationSignature: adapted }) === buildCacheKey({ ...base, adaptationSignature: shipped })) {
      throw new Error('adaptation signature is not part of the cache key');
    }
    // …and the adaptation signature itself must be stable for identical input.
    if (adapted !== adaptationSignature([{ id: 'forge-fuse-node-cli-inspect', file: 'forge.config.ts', changes: [{ option: 'EnableNodeCliInspectArguments', value: true }] }])) {
      throw new Error('adaptation signature is not deterministic');
    }
    return 'revision, adapter and adaptation set all separate cache entries';
  }),

  test('the scenario scaffold is aimed at the change, not at the app in general', async () => {
    const { scaffoldScenario } = await import('./analyze.mjs');
    const changeset = {
      pullRequest: { number: 85, title: 'feat: sync config' },
      files: [
        { path: 'src/main/services/sync.ts', status: 'M', additions: 40, deletions: 2 },
        { path: 'src/renderer/pages/settings/index.tsx', status: 'M', additions: 20, deletions: 1 },
      ],
    };
    const { triageChangeset } = await import('./analyze.mjs');
    const triage = triageChangeset(changeset);
    const scenario = scaffoldScenario({ changeset, triage });

    if (!Array.isArray(scenario.steps) || scenario.steps.length === 0) throw new Error('scaffold produced no steps');
    if (!Array.isArray(scenario.targets) || scenario.targets.length === 0) throw new Error('scaffold named no targets');
    for (const target of scenario.targets) {
      if (!target.hint || target.hint.length < 20) throw new Error(`target "${target.area}" has no useful hint`);
      if (!Array.isArray(target.files) || target.files.length === 0) throw new Error(`target "${target.area}" lists no files`);
    }
    const areas = scenario.targets.map((t) => t.area);
    if (!areas.includes('main-process') || !areas.includes('renderer-ui')) {
      throw new Error(`expected the changed areas to be named, got: ${areas.join(', ')}`);
    }
    // A scaffold must never claim coverage it does not have.
    if (!/replace the steps|generic smoke/i.test(JSON.stringify(scenario.$comment))) {
      throw new Error('the scaffold does not tell the author to replace the generated steps');
    }
    // Every step must be a real action the runner understands.
    const { PROBES } = await import('./probes.mjs');
    const known = new Set(['wait', 'waitForSelector', 'click', 'type', 'fill', 'press', 'eval', 'assertEval', 'assertText', 'assertSelector', 'assertVisible', 'assertNoConsoleErrors', 'assertNoPageErrors', 'screenshot']);
    for (const step of scenario.steps) {
      if (!known.has(step.action)) throw new Error(`scaffold emits an action the runner does not implement: ${step.action}`);
    }
    if (PROBES.length === 0) throw new Error('no probes registered');
    return `${scenario.targets.length} target(s): ${areas.join(', ')}`;
  }),

  test('side-effect assessment forbids overlapping runs when they could interfere', async () => {
    const {
      assessStaticSideEffects, combineSideEffects, describeSideEffects,
      parallelExerciseAllowed, parseListeningPorts,
    } = await import('./sideeffects.mjs');

    // netstat parsing is the runtime half of the decision; get it exactly right.
    const netstat = [
      '  TCP    0.0.0.0:8001           0.0.0.0:0              LISTENING       4242',
      '  TCP    127.0.0.1:54321        0.0.0.0:0              LISTENING       4242',
      '  TCP    0.0.0.0:9222           0.0.0.0:0              LISTENING       9999',
      '  TCP    127.0.0.1:5000         127.0.0.1:6000         ESTABLISHED     4242',
    ].join('\n');
    const parsed = parseListeningPorts(netstat);
    if (parsed.length !== 3) throw new Error(`expected 3 listening sockets, got ${parsed.length}`);
    if (!parsed.some((p) => p.port === 8001 && p.pid === 4242)) throw new Error('fixed port 8001 was not attributed to its pid');

    // A change to a syncing service is exactly the dangerous case.
    const dangerous = assessStaticSideEffects({
      changeset: {
        files: [
          { path: 'src/main/deepseek-harness-service/workbuddy-model-sync.ts' },
          { path: 'src/main/deepseek-harness-service/dsh-config-backup.ts' },
        ],
      },
      triage: { areas: [{ area: 'main-process', additions: 479, files: [{ path: 'a' }] }] },
    });
    if (dangerous.level === 'none') throw new Error('a config-syncing service must be flagged');
    for (const expected of ['service', 'sync-config']) {
      if (!dangerous.signals.some((s) => s.id === expected)) {
        throw new Error(`expected signal "${expected}", got: ${dangerous.signals.map((s) => s.id).join(', ')}`);
      }
    }
    if (parallelExerciseAllowed(dangerous)) throw new Error('overlapping runs must be refused for a side-effecting change');
    if (!/not permitted/.test(describeSideEffects(dangerous))) throw new Error('the refusal is not explained');

    // A pure renderer tweak should not be blocked.
    const harmless = assessStaticSideEffects({
      changeset: { files: [{ path: 'src/renderer/components/Button.tsx' }, { path: 'src/renderer/theme.scss' }] },
      triage: { areas: [{ area: 'renderer-ui', additions: 12, files: [{ path: 'src/renderer/components/Button.tsx' }] }] },
    });
    if (harmless.level !== 'none') {
      throw new Error(`a renderer-only change must not be flagged, got: ${harmless.signals.map((s) => s.id).join(', ')}`);
    }
    if (!parallelExerciseAllowed(harmless)) throw new Error('a side-effect-free change must permit overlapping runs');

    // Runtime evidence outranks the diff heuristic.
    const observed = combineSideEffects(harmless, {
      level: 'likely',
      signals: [{ id: 'single-instance-lock', kind: 'runtime', reason: 'holds a lock' }],
    });
    if (observed.level !== 'likely') throw new Error('observed evidence must outrank the diff scan');
    if (parallelExerciseAllowed(observed)) throw new Error('an observed lock must forbid overlapping runs');

    return 'static and runtime evidence both gate overlapping exercise; 3 listening sockets parsed';
  }),

  test('only one app instance is on screen at a time by default', async () => {
    const { DEFAULT_CONFIG } = await import('./util.mjs');
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('./run.mjs', import.meta.url), 'utf8');

    // Building two revisions at once is safe and worth it…
    if (DEFAULT_CONFIG.parallelPrepare !== true) {
      throw new Error('parallelPrepare should default on: install and packaging need no window');
    }
    // …launching them at once is not: identical window titles, doubled startup work,
    // and a single-instance lock would silently test one revision twice.
    if (DEFAULT_CONFIG.parallelExercise !== false) {
      throw new Error('parallelExercise must default to false');
    }
    if (!/for \(const \[index, side\] of prepared\.entries\(\)\)/.test(source)) {
      throw new Error('the exercise phase is no longer serial by default; two app windows would appear at once');
    }
    if (!/parallelExercise is on/.test(source)) {
      throw new Error('opting into parallel exercise no longer warns that two windows will appear');
    }
    return 'build concurrent, GUI serial; parallel exercise is opt-in and warns';
  }),

  test('launch exit-code classification is stable', async () => {
    const { classifyExit } = await import('./launch.mjs');
    const cases = [[-1073741819, 'ACCESS_VIOLATION'], [-2147483645, 'BREAKPOINT'], [0, 'exit_0']];
    for (const [code, expected] of cases) {
      const actual = classifyExit(code);
      if (actual !== expected) throw new Error(`classifyExit(${code}) = ${actual}, expected ${expected}`);
    }
    return 'access violation, breakpoint and clean exit classified';
  }),
];

export async function selfcheck({ json = false } = {}) {
  const results = [];
  for (const { name, fn } of TESTS) {
    const started = Date.now();
    try {
      const detail = await fn();
      results.push({ name, status: 'pass', detail: detail ?? '', durationMs: Date.now() - started });
    } catch (error) {
      results.push({ name, status: 'fail', detail: error.message, durationMs: Date.now() - started });
    }
  }

  const failed = results.filter((r) => r.status === 'fail');
  const report = { generatedAt: new Date().toISOString(), total: results.length, failed: failed.length, results };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('');
    console.log('ebb selfcheck');
    console.log('=============');
    for (const item of results) {
      console.log(`[${item.status === 'pass' ? 'ok  ' : 'FAIL'}] ${item.name}`);
      if (item.detail) console.log(`       ${item.detail}`);
    }
    console.log('');
    console.log(failed.length === 0 ? `All ${results.length} checks passed.` : `${failed.length} of ${results.length} checks FAILED.`);
  }
  return report;
}
