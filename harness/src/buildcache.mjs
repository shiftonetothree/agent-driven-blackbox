/**
 * Build index: remember where a revision was already packaged, so a repeat run does
 * not pay for dependency installation and packaging again.
 *
 * Packaging an Electron app is by far the most expensive step in the pipeline (for
 * the reference project: ~70 s to install and ~4 minutes to package, twice per run).
 * None of that work depends on anything but the revision, the adapter, the platform
 * and which build adaptations were applied — so it is cached against exactly those.
 *
 * The index stores *paths*, not copies: the packaged bundle for the launcher project
 * is ~330 MB, so copying it would cost about as much as rebuilding.
 */
import { join } from 'node:path';
import { pathExists, readJson, shortHash, writeJson } from './util.mjs';

const INDEX_FILE = 'build-index.json';

/**
 * Content key for one packaged build.
 *
 * The adaptation signature matters: an adapted build (inspect fuse enabled) must
 * never be reused for a run that asked for the repository's shipped configuration,
 * or the report would describe a different artifact than it claims.
 */
export function buildCacheKey({ revision, adapterId, platform = process.platform, arch = process.arch, adaptationSignature = 'none' }) {
  return shortHash(String(revision), String(adapterId), `${platform}-${arch}`, String(adaptationSignature), 'v1');
}

/** Stable signature for a set of applied adaptations. */
export function adaptationSignature(adaptations = []) {
  if (adaptations.length === 0) return 'none';
  return shortHash(...adaptations.flatMap((item) => [item.id, item.file, ...item.changes.map((c) => `${c.option}=${c.value}`)]));
}

async function readIndex(workDir) {
  return await readJson(join(workDir, INDEX_FILE), { version: 1, builds: {} });
}

/** Look up a usable packaged build. Returns null when absent or since deleted. */
export async function lookupBuild(workDir, key) {
  const index = await readIndex(workDir);
  const entry = index.builds?.[key];
  if (!entry) return null;
  if (!(await pathExists(entry.binaryPath))) return null;
  if (entry.bundleDir && !(await pathExists(entry.bundleDir))) return null;
  return { ...entry, key };
}

/** Record a packaged build for future runs. */
export async function rememberBuild(workDir, key, entry) {
  const index = await readIndex(workDir);
  index.builds ??= {};
  index.builds[key] = {
    ...entry,
    key,
    rememberedAt: new Date().toISOString(),
    hits: (index.builds[key]?.hits ?? 0),
  };
  await writeJson(join(workDir, INDEX_FILE), index);
  return index.builds[key];
}

/** Record that a cached entry was used, for diagnostics. */
export async function noteBuildHit(workDir, key) {
  const index = await readIndex(workDir);
  if (!index.builds?.[key]) return;
  index.builds[key].hits = (index.builds[key].hits ?? 0) + 1;
  index.builds[key].lastUsedAt = new Date().toISOString();
  await writeJson(join(workDir, INDEX_FILE), index);
}

/** Drop index entries whose files no longer exist. */
export async function pruneBuildIndex(workDir) {
  const index = await readIndex(workDir);
  const kept = {};
  let dropped = 0;
  for (const [key, entry] of Object.entries(index.builds ?? {})) {
    if (await pathExists(entry.binaryPath)) kept[key] = entry;
    else dropped += 1;
  }
  await writeJson(join(workDir, INDEX_FILE), { version: 1, builds: kept });
  return { kept: Object.keys(kept).length, dropped };
}
