# Failure modes and remedies

A running list. **Add to it whenever a run fails in a way that is not the
repository's fault** — that is how this process stops paying the same cost twice.

Format: symptom → diagnosis → remedy.

---

## Acquire

### `git clone` fails with `schannel: AcquireCredentialsHandle failed`
**Diagnosis.** Windows' TLS backend cannot get credentials on this host.
**Remedy.** Use the OpenSSL backend. The harness already passes
`-c http.sslBackend=openssl`. Verify with `ebb doctor`.

### The diff contains unrelated changes from the default branch
**Diagnosis.** The pull request targets a non-default branch, but base resolution
fell back to the default branch because the GitHub API was unreachable.
**Remedy.** Restore API access (`ebb doctor` reports `github-api`). Offline, pass an
explicit `--range <base>..<head>` instead of `--pr`.

### `git worktree add` fails
**Diagnosis.** Old git, or a stale worktree registration.
**Remedy.** The harness falls back to `git clone --shared` plus an explicit
checkout. If it persists, `--force-clone` rebuilds the clone from scratch.

---

## Prepare (install / build)

### Install fails instantly with `exit -1` / `spawn error` / `ENOENT`
**Diagnosis.** The command is a Windows `.cmd` shim (`npm`, `npx`, `pnpm`, `yarn`)
and `child_process.spawn` was called with `shell: false`. `CreateProcess` cannot
start a `.cmd` file, so `spawn('npm', …)` fails before npm ever runs. The entry is
easy to misread as "npm is broken" — the give-away is that the exit code is `-1` and
no output log was produced at all.
**Remedy.** The harness resolves this in `buildSpawn()`: on Windows it builds a
fully-quoted command line and hands it to `cmd.exe /d /s /c` with
`windowsVerbatimArguments: true`. That is deliberately **not** `shell: true`, which
concatenates arguments unescaped — a repository-controlled script name could then
inject shell syntax. Verified by `ebb selfcheck`.

### The run stalls after probing, before the report is written
**Diagnosis.** `electronApp.close()` is waiting for the app to exit, and the app never
does — a tray icon, a background service, or a `before-quit` handler that cancels.
Playwright's `close()` has no timeout of its own.
**Remedy.** Fixed: the graceful close is bounded by `appCloseTimeoutMs` (8 s) and is
always followed by a forced process-tree kill, on both the `_electron` and
`connectOverCDP` paths. `ebb selfcheck` asserts the bound still exists. Diagnosis tip:
if a run goes quiet, check whether `runs/<id>/report.md` exists — if it does not, the
stall is in teardown, not in probing.

### A probe hangs and the run goes silent
**Diagnosis.** No per-probe budget, and no output between probes, so a probe that
never settles looks identical to a slow one.
**Remedy.** Fixed: every probe has a `timeouts.probe` budget (120 s) and logs its
name, status and duration. A timeout is reported as a finding.

### The process stays alive after the report is written
**Diagnosis.** The test process finished its work but never exits. Spawning Electron
and connecting to it with Playwright leaves handles behind — sockets, Playwright's
internal driver, and stdout/stderr pipes inherited by the app's own children — so the
event loop never drains.
**Remedy.** `close()` is idempotent, destroys the child's stdio streams and
unreferences it, and the CLI ends with an explicit flushed exit. If a run hangs
again, check that a new handle was not introduced; do not "fix" it by removing the
exit.

### A launch reports success but zero probes run
**Diagnosis.** The drivers report `ok`; the pipeline gates probing on `reachedReady`.
If that translation is lost, every probe is skipped, the comparison is empty, and the
verdict is a **false pass**. This actually happened once.
**Remedy.** Fixed in two places, and both are asserted by `ebb selfcheck`:
`launchApp` normalises `ok` to `reachedReady`, and an empty probe set is
`INCONCLUSIVE` rather than `NO_REGRESSION`. Never weaken either guard.

### A packaged app cannot be observed and `_electron.launch` just times out
**Diagnosis.** Electron fuses. See the trap in `electron-blackbox.md`.
**Remedy.** A declared build adaptation re-enables the inspect fuse; the middle
driver rung (`playwright-cdp`) works without it.

### `npm error code EPERM / syscall spawn`
**Diagnosis.** A confined session cannot open the named pipe that piped stdio
requires, so lifecycle scripts cannot run.
**Remedy.** Run under full access. Otherwise `--ignore-scripts`, then run the
needed postinstall (`node install.js` for Electron, `prebuild-install` for native
addons) manually.

### `npm error code EPERM / syscall open ... npm-cache`
**Diagnosis.** npm is writing its cache to the user profile, which is not writable.
**Remedy.** The harness sets `npm_config_cache` into `<root>/.cache/npm`. If you are
running a command by hand, set it yourself.

### `Electron failed to install correctly`
**Diagnosis.** `node_modules/electron` exists but `dist/` does not: the postinstall
never ran.
**Remedy.** `npx install-electron --no` inside the project, with `ELECTRON_MIRROR`
and `ELECTRON_GET_USE_PROXY` set (see `environment.md`).

### Packaging fails but the edit clearly builds in CI
**Diagnosis.** Local packaging often needs a platform toolchain (signed binaries,
`wine`, macOS `codesign`) that this host does not have.
**Remedy.** The harness automatically falls back to the project's dev script. Record
in the report's limitations that the packaged artifact was not exercised.

### Install succeeds but the app cannot find a module at runtime
**Diagnosis.** A monorepo/workspace package, or a `postinstall` code-generation
step, did not run.
**Remedy.** Install from the workspace root, not the package directory, and check
whether the repo requires a separate `prepare`/`build` script.

---

## Launch

### Two application windows appear at once
**Diagnosis.** Base and head are being launched and probed concurrently, so two
Electron instances are on screen together. Introduced by parallelising the whole
pipeline for speed; the two windows are indistinguishable because they carry the same
title. Measured on the reference host: **2 top-level windows, 8 processes, ~10 s of
overlap.**
**Remedy.** Fixed by splitting the phases: preparation (install + package) runs
concurrently because it needs no window, and exercise (launch + probe) runs serially.
Only the GUI phase had this problem and it is not where the time goes — the cold-run
wall clock is unchanged. `parallelExercise: true` opts back in and warns; the default
is asserted by `ebb selfcheck`.

The same reasoning covers a worse case: an app that calls
`app.requestSingleInstanceLock()` would have its second instance quit immediately, so
a parallel run would quietly test one revision twice and report it as two.

### The process exits immediately with `0xC0000005` or `0x80000003`
**Diagnosis.** See `environment.md` §1. Read the crash dump rather than guessing:
`ebb doctor --smoke` reports the exception and faulting module+offset.
**Remedy.** `--no-sandbox` and an explicit `--user-data-dir`; both are already
applied automatically, in that order, with the winner cached.

### `no-cdp-endpoint` — the process stays alive but never opens the port
**Diagnosis.** Usually one of: the app overrides `app.commandLine`, the dev script
does not forward extra argv to Electron, or a first-run dialog/modal blocks startup.
**Remedy.** Check the attempt's `.out.log`/`.err.log` under
`runs/<id>/sides/<side>/launch/`. If it is an argv-forwarding problem, use the
packaged adapter, or add `--launch-arg` and, if needed, a repo adapter.

### The app launches but no window appears
**Diagnosis.** Some apps start minimised to tray, or require a profile/login step.
**Remedy.** Assert on the main process instead of the renderer (`main-process`
probe reports `windowCount`), and add scenario steps that open the window. Record
the repo in `repo-notes.md`.

### A first-run dialog blocks every run
**Diagnosis.** A welcome/telemetry/update modal on a fresh profile.
**Remedy.** Add scenario steps that dismiss it, or pre-seed the profile by copying a
prepared `--user-data-dir` into the run. Never hand-edit the app's code.

---

## Probes

### Screenshots are black or uniform
**Diagnosis.** The window is hidden or never composited.
**Remedy.** The `visual` probe already cross-checks the DOM fingerprint; a tiny
screenshot *plus* zero text is reported as a blank surface, but a tiny screenshot
with healthy text is not treated as a failure.

### `main-process` probe is skipped
**Diagnosis.** The Node inspector port was not reachable — common when the app is
launched through a wrapper that does not pass `--inspect` to Electron.
**Remedy.** Expected and non-fatal; renderer probes still run. Prefer the packaged
adapter so argv reaches Electron directly.

### Console is full of unrelated warnings, or a probe reports a false positive
**Diagnosis.** Third-party noise, or a severity heuristic that is too broad.
**Remedy.** Tighten the pattern in `harness/src/probes.mjs` (`SEVERE_CONSOLE`) or
downgrade the check — then run `ebb selfcheck` and re-run the previous case to
confirm the process did not regress.
