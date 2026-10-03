# Failure modes and remedies

Builds and launches fail for reasons that are neither the host nor the repository under
test. Only those belong here, and only when the cause cannot be inferred from the failure
itself — this file is not a catalogue of everything that can go wrong, and every entry is
read on every future run.

Host-level problems (proxy and TLS, npm/Electron caches, mandatory launch flags, confined
sessions) live in `environment.md`. Anything true of one application lives in
`projects/<owner>__<repo>/NOTES.md`.

Format: symptom → diagnosis → remedy.

---

## Acquire

### The diff contains unrelated changes from the default branch
**Diagnosis.** The pull request targets a non-default branch, but base resolution fell
back to the repository default because the GitHub API was unreachable.
**Remedy.** Restore API access (`ebb doctor` reports `github-api`). Offline, pass an
explicit `--range <base>..<head>` instead of `--pr`.

### `git worktree add` fails
**Diagnosis.** Old git, or a stale worktree registration.
**Remedy.** The harness falls back to `git clone --shared` plus an explicit checkout. If
it persists, `--force-clone` rebuilds the clone from scratch.

---

## Prepare (install / build)

### Install fails instantly with `exit -1`, a spawn error, or `ENOENT`
**Diagnosis.** The command is a Windows `.cmd` shim (`npm`, `npx`, `pnpm`, `yarn`) and the
child was spawned with `shell: false`; `CreateProcess` cannot start a `.cmd`. The
give-away is an exit code of `-1` **and no output log at all** — easy to misread as "npm
is broken".
**Remedy.** The harness builds a quoted command line for `cmd.exe /d /s /c` in
`buildSpawn()`. Do not "fix" it with `shell: true`: that concatenates arguments unescaped,
so a repository-controlled script name could inject shell syntax.

### Packaging fails and it is not obvious whether the code is at fault
**Diagnosis.** Either the host lacks a platform toolchain (code signing, `wine`,
`codesign`), or the repository does not compile. The verdict looks the same either way.
**Remedy.** Read `runs/<id>/logs/<side>-package.log` before concluding. Compiler
diagnostics (`ERROR in` / `TS####`) mean the code under test — and the dev-script fallback
will exit 1 too. A toolchain failure has no compiler diagnostics, and the harness falls
back to the dev script automatically.

### The run goes quiet after probing
**Diagnosis.** Teardown, not probing — the app is not exiting and something is waiting on
it.
**Remedy.** Check whether `runs/<id>/report.md` exists. If it does not, the stall is in
teardown: the graceful close is bounded and a forced process-tree kill follows it.

### A packaged app cannot be observed and `_electron.launch` just times out
**Diagnosis.** Electron fuses — see the trap in `electron-blackbox.md`.
**Remedy.** The declared build adaptation re-enables the inspect fuse; the middle driver
rung (`playwright-cdp`) works without it.

---

## Launch

### The process exits immediately with `0xC0000005` or `0x80000003`
**Diagnosis.** Host-level; see `environment.md` §1.
**Remedy.** `--no-sandbox` plus an explicit `--user-data-dir` — already applied
automatically, in that order, with the winner cached.

### `no-cdp-endpoint` — the process stays alive but never opens the port
**Diagnosis.** The dev script does not forward extra argv to Electron, or the app
overrides `app.commandLine`.
**Remedy.** Check the attempt's `.out.log` / `.err.log` under
`runs/<id>/sides/<side>/launch/`. Prefer the packaged adapter, which hands argv to
Electron directly; `--launch-arg` can add individual flags.

### A first-run modal covers the app
**Diagnosis.** A welcome, telemetry or update dialog on a fresh profile.
**Remedy.** Dismiss it in the scenario before asserting anything, or pre-seed the profile
by copying a prepared `--user-data-dir` into the run. Never hand-edit the app's code.

---

## Probes

### The `main-process` probe is skipped
**Diagnosis.** The Node inspector port was unreachable — usual when the app is launched
through a wrapper that does not pass `--inspect` to Electron.
**Remedy.** Expected and non-fatal; the renderer probes still run. Prefer the packaged
adapter, which reaches Electron directly.

---

## Invariants worth not breaking

- **A successful launch must mean probes actually ran.** If `reachedReady` is ever lost in
  translation, every probe is skipped, the comparison is empty, and the verdict becomes a
  **false pass**. `ebb selfcheck` asserts both halves: `launchApp` normalises `ok` to
  `reachedReady`, and an empty probe set is `INCONCLUSIVE` rather than `NO_REGRESSION`.
