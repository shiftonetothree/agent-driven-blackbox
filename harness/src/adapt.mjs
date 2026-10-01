/**
 * Build adaptations: minimal, declared changes to a checkout's *packaging
 * configuration* so the harness can observe the app the way the repository builds it.
 *
 * Why this exists
 * ---------------
 * Electron Forge's fuses plugin ships with `EnableNodeCliInspectArguments: false`.
 * That is a sensible production default - it stops anyone attaching a debugger to a
 * shipped app - but it also removes the main-process Node inspector, which is the
 * channel Playwright's `_electron.launch` needs. Without it, Playwright can never
 * attach to a packaged build and every launch attempt burns its full timeout.
 *
 * Safety rules
 * ------------
 * - Adaptations are applied **only inside the run's disposable worktree**
 *   (`runs/<id>/trees/<side>`). The cached clone and the user's repository are never
 *   touched.
 * - Only packaging/build configuration is rewritten. Application source is never
 *   modified, so behaviour under test is unchanged.
 * - Each adaptation is recorded with a before/after line and written to
 *   `adaptations.diff` in the run directory, and every run that used one says so in
 *   its report. A reader must never be misled into thinking the shipped
 *   configuration was tested.
 * - Security fuses that do not stand in the way of observation are left alone.
 */
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathExists, writeJson, writeText } from './util.mjs';

/** Rewrite one fused option to `value`, accepting computed and plain key syntax. */
function setFuseOption(source, option, value) {
  const patterns = [
    // [FuseV1Options.EnableNodeCliInspectArguments]: false
    new RegExp(`(\\[\\s*(?:FuseV1Options|FuseV2Options)\\.${option}\\s*\\]\\s*:\\s*)(true|false)`, 'g'),
    // EnableNodeCliInspectArguments: false   (inside an object literal)
    new RegExp(`(\\b${option}\\s*:\\s*)(true|false)`, 'g'),
  ];
  let changed = false;
  let result = source;
  for (const pattern of patterns) {
    result = result.replace(pattern, (match, prefix, current) => {
      if (current === String(value)) return match;
      changed = true;
      return `${prefix}${value}`;
    });
  }
  return { changed, result };
}

const FORGE_FILES = ['forge.config.ts', 'forge.config.js', 'forge.config.mjs', 'forge.config.cjs', 'forge.config.mts', 'forge.config.cts'];

const RULES = [
  {
    id: 'forge-fuse-node-cli-inspect',
    title: 'Enable the Node CLI inspect fuse',
    reason: 'Playwright attaches to the Electron main process through the Node inspector. Electron Forge disables that channel by default, so the packaged app cannot be observed without re-enabling it.',
    files: FORGE_FILES,
    options: [['EnableNodeCliInspectArguments', true]],
  },
  {
    id: 'forge-fuse-node-options-env',
    title: 'Allow NODE_OPTIONS to reach the packaged app',
    reason: 'Released alongside the inspect fuse so that debug and instrumentation flags the harness passes are not silently dropped by the packaged build.',
    files: FORGE_FILES,
    options: [['EnableNodeOptionsEnvironmentVariable', true]],
  },
  {
    id: 'electron-fuses-direct',
    title: 'Enable the Node CLI inspect fuse where @electron/fuses is used directly',
    reason: 'Same channel, for projects that flip fuses outside the Electron Forge plugin (for example in an electron-builder afterPack hook).',
    files: ['electron-builder.yml', 'electron-builder.json', 'electron-builder.json5', 'electron-builder.config.js', 'forge.config.ts', 'forge.config.js'],
    options: [['EnableNodeCliInspectArguments', true]],
  },
];

/**
 * Work out which adaptations apply, without writing anything.
 *
 * Used both to compute the build-cache key (which must be known *before* deciding
 * whether to build at all) and as the first half of `applyBuildAdaptations`.
 */
export async function scanAdaptations({ projectDir, config }) {
  const found = [];
  if (config?.adaptBuild === false) return found;
  const seen = new Set();

  for (const rule of RULES) {
    for (const file of rule.files) {
      const path = join(projectDir, file);
      if (!(await pathExists(path))) continue;
      if (seen.has(`${rule.id}:${file}`)) continue;
      seen.add(`${rule.id}:${file}`);

      const original = await readFile(path, 'utf8');
      let working = original;
      const changes = [];
      for (const [option, value] of rule.options) {
        const outcome = setFuseOption(working, option, value);
        if (outcome.changed) {
          changes.push({ option, value });
          working = outcome.result;
        }
      }
      if (changes.length === 0) continue;
      found.push({ rule, path, file, original, working, changes });
    }
  }
  return found;
}

/** Signature of the adaptations that would apply, for cache keying. */
export async function previewAdaptations({ projectDir, config }) {
  const found = await scanAdaptations({ projectDir, config });
  return found.map((item) => ({ id: item.rule.id, file: item.file, changes: item.changes }));
}

/**
 * Apply every applicable adaptation to a checkout.
 *
 * Resolves with `{ applied, skipped, diffPath, recordPath }`; never throws for a
 * repository that needs no adaptation.
 */
export async function applyBuildAdaptations({ projectDir, runDir, label, config }) {
  const applied = [];
  const skipped = [];
  const diffLines = [];

  if (config?.adaptBuild === false) {
    return { applied, skipped: [{ id: '*', reason: 'build adaptations are disabled (adaptBuild: false)' }], diffPath: null, recordPath: null };
  }

  for (const item of await scanAdaptations({ projectDir, config })) {
    const { rule, path, file, original, working, changes } = item;

    await writeText(path, working);

    // Record a readable before/after for the changed lines only.
    const beforeLines = original.split('\n');
    const afterLines = working.split('\n');
    const changedAt = [];
    for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i++) {
      if (beforeLines[i] !== afterLines[i]) changedAt.push(i);
    }
    for (const index of changedAt) {
      diffLines.push(`--- ${file}:${index + 1} (${label})`);
      diffLines.push(`- ${beforeLines[index] ?? ''}`);
      diffLines.push(`+ ${afterLines[index] ?? ''}`);
    }

    applied.push({
      id: rule.id,
      title: rule.title,
      reason: rule.reason,
      file,
      changes,
      lines: changedAt.map((i) => ({ line: i + 1, before: beforeLines[i] ?? '', after: afterLines[i] ?? '' })),
    });
  }

  let diffPath = null;
  let recordPath = null;
  if (applied.length > 0) {
    diffPath = join(runDir, `adaptations-${label}.diff`);
    recordPath = join(runDir, `adaptations-${label}.json`);
    await writeText(diffPath, `${diffLines.join('\n')}\n`);
    await writeJson(recordPath, {
      side: label,
      appliedAt: new Date().toISOString(),
      note: 'Applied inside the disposable worktree only. Application source was not modified.',
      applied,
      skipped,
    });
  }

  return { applied, skipped, diffPath, recordPath };
}

/** One-line summaries suitable for a report's limitations section. */
export function describeAdaptations(adaptations) {
  return adaptations.map(
    (item) => `Build adaptation applied (${basename(item.file)}): ${item.title} - ${item.changes.map((c) => `${c.option}=${c.value}`).join(', ')}. The packaged artifact under test therefore does **not** use the repository's shipped fuse configuration.`,
  );
}

export { RULES as ADAPTATION_RULES, setFuseOption };
