/**
 * Repository acquisition: clone the target repo, resolve the exact change set
 * (a pull request or an explicit commit range) and materialise two isolated
 * worktrees - `base` (before) and `head` (after) - for differential testing.
 */
import { join } from 'node:path';
import { buildEnv, ensureDir, gitArgs, listDir, log, pathExists, readJson, removePath, run, runCapture, writeJson } from './util.mjs';

/** Accepts https://, ssh://, git@host:owner/name.git or the `owner/name` shorthand. */
export function parseRepoUrl(input) {
  const raw = String(input).trim().replace(/\.git$/, '');
  let match;
  if ((match = raw.match(/^[\w.-]+\/[\w.-]+$/)) !== null) {
    return { host: 'github.com', owner: match[0].split('/')[0], name: match[0].split('/')[1], cloneUrl: `https://github.com/${match[0]}.git` };
  }
  if ((match = raw.match(/^git@([^:]+):(.+)$/)) !== null) {
    const [, host, path] = match;
    const [owner, name] = path.split('/');
    return { host, owner, name, cloneUrl: `https://${host}/${owner}/${name}.git` };
  }
  if ((match = raw.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/)) !== null) {
    const [, host, path] = match;
    const parts = path.split('/').filter(Boolean);
    if (parts.length < 2) throw new Error(`cannot parse repository URL: ${input}`);
    const name = parts.pop();
    const owner = parts.join('/');
    return { host, owner, name, cloneUrl: `https://${host}/${owner}/${name}.git` };
  }
  throw new Error(`cannot parse repository URL: ${input}`);
}

/** GitHub REST lookup for a PR. Returns null when the API is unreachable. */
export async function fetchPullRequest({ host, owner, name }, prNumber, { timeoutMs = 20000 } = {}) {
  if (host !== 'github.com') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${name}/pulls/${prNumber}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'electron-blackbox-harness', Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return null;
    const data = await response.json();
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? '',
      state: data.state,
      draft: data.draft ?? false,
      additions: data.additions,
      deletions: data.deletions,
      changedFiles: data.changed_files,
      author: data.user?.login,
      url: data.html_url,
      baseRef: data.base?.ref,
      baseSha: data.base?.sha,
      headRef: data.head?.ref,
      headSha: data.head?.sha,
      headRepoCloneUrl: data.head?.repo?.clone_url ?? null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Parse `A..B`, `A...B` or `A B` into two revisions. */
export function parseRange(input) {
  const text = String(input).trim();
  const match = text.match(/^(\S+?)\s*(\.\.\.?)\s*(\S+)$/);
  if (match) return { from: match[1], to: match[3], exclusive: match[2] === '...' };
  const spaceParts = text.split(/\s+/).filter(Boolean);
  if (spaceParts.length === 2) return { from: spaceParts[0], to: spaceParts[1], exclusive: false };
  throw new Error(`cannot parse commit range: ${input} (expected A..B)`);
}

const git = (config, cwd, args, options = {}) =>
  run('git', gitArgs(config, args), { cwd, env: buildEnv(config), ...options });

const gitOut = (config, cwd, args, options = {}) =>
  runCapture('git', gitArgs(config, args), { cwd, env: buildEnv(config), ...options });

/** Clone (or refresh) the repository under `work/repos/<owner>__<name>`. */
export async function cloneRepo({ repo, workDir, config, force = false }) {
  const repoDir = join(workDir, 'repos', `${repo.owner}__${repo.name}`);
  if (force) await removePath(repoDir);

  if (await pathExists(join(repoDir, '.git'))) {
    log.info(`reusing clone at ${repoDir}`);
    const fetchResult = await git(config, repoDir, ['fetch', '--all', '--tags', '--prune'], { timeoutMs: 900000 });
    if (fetchResult.code !== 0) log.warn(`git fetch failed (exit ${fetchResult.code}); continuing with the existing clone`);
    return repoDir;
  }

  await ensureDir(join(workDir, 'repos'));
  log.step(`cloning ${repo.cloneUrl}`);
  const result = await git(config, workDir, ['clone', repo.cloneUrl, repoDir], {
    timeoutMs: 1800000,
    logFile: join(workDir, 'logs', 'clone.log'),
  });
  if (result.code !== 0) {
    throw new Error(`git clone failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 800)}`);
  }
  return repoDir;
}

/** Resolve the change set for a PR or commit range and write `changeset.json`. */
export async function resolveChangeset({ repoDir, repo, pr, range, config, runDir }) {
  const changeset = { repo, generatedAt: new Date().toISOString() };

  if (pr !== undefined && pr !== null) {
    log.step(`resolving pull request #${pr}`);
    const meta = await fetchPullRequest(repo, pr);
    if (meta) {
      changeset.kind = 'pull-request';
      changeset.pullRequest = meta;
      changeset.base = { ref: meta.baseRef, sha: meta.baseSha };
      changeset.head = { ref: meta.headRef, sha: meta.headSha };
      log.info(`PR #${pr} "${meta.title}" by ${meta.author}`);
      log.info(`base ${meta.baseRef}@${String(meta.baseSha).slice(0, 10)} -> head ${meta.headRef}@${String(meta.headSha).slice(0, 10)}`);
    } else {
      // Offline fallback: fetch the PR head ref and diff against the default branch.
      log.warn('GitHub API unavailable; falling back to `git fetch pull/<n>/head`');
      changeset.kind = 'pull-request';
      changeset.pullRequest = { number: pr, title: null, url: null, offline: true };
    }
    const fetch = await git(config, repoDir, ['fetch', '--no-tags', 'origin', `+pull/${pr}/head:refs/ebb/pr-${pr}`], { timeoutMs: 900000 });
    if (fetch.code !== 0) throw new Error(`failed to fetch pull/${pr}/head: ${(fetch.stderr || '').trim().slice(0, 500)}`);
    changeset.head = { ...(changeset.head ?? {}), ref: `refs/ebb/pr-${pr}`, sha: await revParse(config, repoDir, `refs/ebb/pr-${pr}`) };
    if (!changeset.base?.sha) {
      const defaultRef = await defaultBranch(config, repoDir);
      changeset.base = { ref: defaultRef.replace(/^origin\//, ''), sha: await revParse(config, repoDir, defaultRef) };
      log.warn(`base branch unknown offline; using default branch ${defaultRef}`);
    }
  } else {
    log.step(`resolving commit range ${range}`);
    const parsed = parseRange(range);
    await git(config, repoDir, ['fetch', '--all', '--tags', '--prune'], { timeoutMs: 900000 });
    const headSha = await revParse(config, repoDir, parsed.to);
    const baseSha = parsed.exclusive
      ? await gitOut(config, repoDir, ['merge-base', parsed.from, parsed.to])
      : await revParse(config, repoDir, parsed.from);
    changeset.kind = 'commit-range';
    changeset.range = parsed;
    changeset.base = { ref: parsed.from, sha: baseSha };
    changeset.head = { ref: parsed.to, sha: headSha };
    log.info(`base ${parsed.from}@${baseSha.slice(0, 10)} -> head ${parsed.to}@${headSha.slice(0, 10)}${parsed.exclusive ? ' (merge-base)' : ''}`);
  }

  // Diff from the merge base so unrelated base-branch movement never shows up.
  const mergeBase = await gitOut(config, repoDir, ['merge-base', changeset.base.sha, changeset.head.sha]).catch(() => changeset.base.sha);
  changeset.mergeBase = mergeBase;

  const diffRange = `${mergeBase}..${changeset.head.sha}`;
  changeset.diffRange = diffRange;

  const nameStatus = await gitOut(config, repoDir, ['diff', '--name-status', '--find-renames', diffRange]);
  const numstat = await gitOut(config, repoDir, ['diff', '--numstat', '--find-renames', diffRange]);
  const statText = await gitOut(config, repoDir, ['diff', '--stat', '--find-renames', diffRange]);

  const numstatByPath = new Map();
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue;
    const [additions, deletions, ...rest] = line.split('\t');
    numstatByPath.set(rest.join('\t'), {
      additions: additions === '-' ? 0 : Number(additions),
      deletions: deletions === '-' ? 0 : Number(deletions),
      binary: additions === '-',
    });
  }

  changeset.files = nameStatus
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const parts = line.split('\t');
      const statusCode = parts[0];
      const status = statusCode[0];
      const path = status === 'R' || status === 'C' ? parts[2] : parts[1];
      const previousPath = status === 'R' || status === 'C' ? parts[1] : null;
      const counts = numstatByPath.get(path) ?? { additions: 0, deletions: 0, binary: false };
      return {
        status,
        statusCode,
        path,
        previousPath,
        additions: counts.additions,
        deletions: counts.deletions,
        binary: counts.binary,
      };
    });

  const commits = (await gitOut(config, repoDir, ['log', '--oneline', '--no-merges', diffRange]))
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(' ');
      return { sha: line.slice(0, space), subject: line.slice(space + 1) };
    });

  changeset.statText = statText;
  changeset.commits = commits;
  changeset.totals = {
    files: changeset.files.length,
    additions: changeset.files.reduce((sum, f) => sum + f.additions, 0),
    deletions: changeset.files.reduce((sum, f) => sum + f.deletions, 0),
    commits: commits.length,
  };

  await writeJson(join(runDir, 'changeset.json'), changeset);
  return changeset;
}

export async function revParse(config, repoDir, rev) {
  return await gitOut(config, repoDir, ['rev-parse', rev]);
}

export async function defaultBranch(config, repoDir) {
  try {
    return await gitOut(config, repoDir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  } catch {
    for (const candidate of ['origin/main', 'origin/master']) {
      const exists = await git(config, repoDir, ['rev-parse', '--verify', '--quiet', candidate]);
      if (exists.code === 0) return candidate;
    }
    throw new Error('cannot determine the default branch');
  }
}

/**
 * Create `base` and `head` worktrees. Using worktrees instead of two clones keeps
 * a single object store (fast, small) while giving each side a pristine checkout.
 */
export async function createWorktrees({ repoDir, runDir, changeset, config }) {
  const treesDir = join(runDir, 'trees');
  await ensureDir(treesDir);
  const baseDir = join(treesDir, 'base');
  const headDir = join(treesDir, 'head');

  for (const [label, dir, sha] of [['base', baseDir, changeset.base.sha], ['head', headDir, changeset.head.sha]]) {
    await removePath(dir);
    log.step(`creating ${label} worktree at ${sha.slice(0, 10)}`);
    const result = await git(config, repoDir, ['worktree', 'add', '--force', '--detach', dir, sha], { timeoutMs: 300000 });
    if (result.code !== 0) {
      // Older git or a locked worktree list: fall back to a plain checkout copy.
      log.warn(`git worktree failed for ${label} (exit ${result.code}); falling back to clone + checkout`);
      const clone = await git(config, treesDir, ['clone', '--no-hardlinks', '--shared', repoDir, dir], { timeoutMs: 900000 });
      if (clone.code !== 0) throw new Error(`failed to create ${label} tree: ${(clone.stderr || '').trim().slice(0, 400)}`);
      const checkout = await git(config, dir, ['checkout', '--force', sha], { timeoutMs: 300000 });
      if (checkout.code !== 0) throw new Error(`failed to check out ${sha} in ${label} tree`);
    }
  }

  const diffPatch = join(runDir, 'changes.diff');
  await git(config, repoDir, ['diff', '--binary', changeset.diffRange], { timeoutMs: 300000, logFile: diffPatch });

  return { baseDir, headDir, diffPatch };
}

/** Full acquisition step. */
export async function acquire({ repoUrl, pr, range, workDir, runDir, config, force = false }) {
  if ((pr === undefined || pr === null) && !range) throw new Error('either a pull request number or a commit range is required');
  const repo = parseRepoUrl(repoUrl);
  await ensureDir(runDir);

  const repoDir = await cloneRepo({ repo, workDir, config, force });
  const changeset = await resolveChangeset({ repoDir, repo, pr, range, config, runDir });
  const trees = await createWorktrees({ repoDir, runDir, changeset, config });

  log.ok(`${changeset.totals.files} changed file(s), +${changeset.totals.additions}/-${changeset.totals.deletions} across ${changeset.totals.commits} commit(s)`);
  return { repo, repoDir, changeset, ...trees };
}

export { listDir, readJson };
