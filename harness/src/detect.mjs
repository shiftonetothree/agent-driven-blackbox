/**
 * Project detection: work out how to install, build and launch an Electron app.
 *
 * Detection writes a `project.json` describing the chosen adapter. The agent can
 * (and should) review and override it when a repository does something unusual -
 * that record is the main extension point of the process.
 */
import { join } from 'node:path';
import { buildEnv, log, pathExists, readJson, run, writeJson } from './util.mjs';

const PACKAGE_MANAGERS = [
  { name: 'pnpm', lockfiles: ['pnpm-lock.yaml'], install: ['pnpm', 'install'], frozen: ['pnpm', 'install', '--frozen-lockfile'], run: (s, a) => ['pnpm', 'run', s, ...a], exec: (a) => ['pnpm', 'exec', ...a] },
  { name: 'yarn', lockfiles: ['yarn.lock'], install: ['yarn', 'install'], frozen: ['yarn', 'install', '--frozen-lockfile'], run: (s, a) => ['yarn', s, ...a], exec: (a) => ['yarn', ...a] },
  { name: 'bun', lockfiles: ['bun.lockb', 'bun.lock'], install: ['bun', 'install'], frozen: ['bun', 'install', '--frozen-lockfile'], run: (s, a) => ['bun', 'run', s, ...a], exec: (a) => ['bunx', ...a] },
  { name: 'npm', lockfiles: ['package-lock.json', 'npm-shrinkwrap.json'], install: ['npm', 'install', '--no-audit', '--no-fund'], frozen: ['npm', 'ci', '--no-audit', '--no-fund'], run: (s, a) => ['npm', 'run', s, ...(a.length ? ['--', ...a] : [])], exec: (a) => ['npx', '--no-install', ...a] },
];

/** Inspect a checkout and describe how to build and launch it. */
export async function detectProject(projectDir, config, { outputPath } = {}) {
  const packageJson = await readJson(join(projectDir, 'package.json'));
  if (packageJson === undefined) throw new Error(`no package.json in ${projectDir}`);

  const scripts = packageJson.scripts ?? {};
  const deps = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };

  let packageManager = PACKAGE_MANAGERS.find((pm) => pm.name === 'npm');
  for (const pm of PACKAGE_MANAGERS) {
    for (const lockfile of pm.lockfiles) {
      if (await pathExists(join(projectDir, lockfile))) {
        packageManager = pm;
        break;
      }
    }
    if (packageManager === pm) break;
  }

  const hasForge = Boolean(deps['@electron-forge/cli']) || (await hasAny(projectDir, ['forge.config.js', 'forge.config.ts', 'forge.config.mjs', 'forge.config.cjs']));
  const hasBuilder = Boolean(deps['electron-builder']) || (await hasAny(projectDir, ['electron-builder.yml', 'electron-builder.json', 'electron-builder.json5', 'electron-builder.config.js']));

  const declaredElectron = deps.electron ?? null;
  const installedElectron = await detectInstalledElectron(projectDir, config);

  const project = {
    detectedAt: new Date().toISOString(),
    dir: projectDir,
    name: packageJson.name ?? 'unknown',
    version: packageJson.version ?? null,
    productName: packageJson.productName ?? packageJson.name ?? 'unknown',
    main: packageJson.main ?? 'index.js',
    packageManager: packageManager.name,
    scripts,
    electron: { declared: declaredElectron, installed: installedElectron?.version ?? null, binary: installedElectron?.binary ?? null },
    toolchain: hasForge ? 'electron-forge' : hasBuilder ? 'electron-builder' : 'plain',
    adapters: [],
    warnings: [],
  };

  project.adapters = buildAdapters({ project, packageManager, hasForge, hasBuilder, scripts, projectDir });
  if (project.adapters.length === 0) {
    project.warnings.push('no launch adapter could be derived; supply one via `--launch-cmd` or a run config');
  }

  await writeJson(join(projectDir, '..', 'project.json'), project);
  return project;
}

async function hasAny(dir, names) {
  for (const name of names) {
    if (await pathExists(join(dir, name))) return true;
  }
  return false;
}

/** Ask the checkout's own `electron` package where its binary lives. */
export async function detectInstalledElectron(projectDir, config) {
  const result = await run('node', ['-e', "try{const p=require('electron');const v=require('electron/package.json').version;console.log(JSON.stringify({binary:p,version:v}))}catch(e){console.log(JSON.stringify({error:e.message}))}"], {
    cwd: projectDir,
    env: buildEnv(config),
    timeoutMs: 60000,
  });
  if (result.code !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout.trim().split('\n').pop());
    return parsed.error ? null : parsed;
  } catch {
    return null;
  }
}

/**
 * Build the ordered list of launch strategies to try.
 *
 * Ordering expresses preference: a packaged binary is the most faithful black-box
 * target, then the project's own dev script, then a bare `electron <dir>`.
 */
function buildAdapters({ project, packageManager, hasForge, hasBuilder, scripts, projectDir }) {
  const adapters = [];

  if (hasForge) {
    adapters.push({
      id: 'forge-package',
      label: 'electron-forge package then run the produced binary',
      kind: 'packaged-binary',
      build: [...packageManager.frozen.slice(0, 2), '--no-audit', '--no-fund'].slice(0, 2),
      package: ['npx', '--no-install', 'electron-forge', 'package'],
      outputGlobs: ['out/**/*.exe', 'out/**/*.app/Contents/MacOS/*', 'out/**/*'],
      timeouts: { package: 1800000 },
    });
  }

  if (hasBuilder) {
    adapters.push({
      id: 'builder-package',
      label: 'electron-builder --dir then run the produced binary',
      kind: 'packaged-binary',
      package: ['npx', '--no-install', 'electron-builder', '--dir'],
      outputGlobs: ['dist/**/*.exe', 'dist/mac*/*.app/Contents/MacOS/*', 'dist/linux-unpacked/*'],
      timeouts: { package: 1800000 },
    });
  }

  const devScript = ['start', 'dev', 'electron', 'electron:dev', 'start:electron'].find((name) => typeof scripts[name] === 'string');
  if (devScript) {
    adapters.push({
      id: `script-${devScript}`,
      label: `package.json script "${devScript}"`,
      kind: 'dev-script',
      script: devScript,
    });
  }

  if (project.electron.binary) {
    adapters.push({
      id: 'direct-electron',
      label: 'run the installed electron binary on the project directory',
      kind: 'direct-electron',
      binary: project.electron.binary,
    });
  }

  return adapters;
}

/** Read back a previously written project.json, if present. */
export async function loadProject(projectDir) {
  return await readJson(join(projectDir, '..', 'project.json'), null);
}

export { log };
