# Electron Black-Box Testing Process

An agent-executable, agent-evolvable process for black-box testing Electron applications.

**Give it a repository URL and a pull request (or a commit range). It builds both
revisions, launches the real Electron app, observes it, and writes a test report
that says whether the change regressed anything.**

```bash
node harness/bin/ebb.mjs doctor --smoke                        # can this host test Electron?
node harness/bin/ebb.mjs acquire --repo <url> --pr 85          # what exactly changed?
node harness/bin/ebb.mjs run     --repo <url> --pr 85          # test it, write the report
```

Report: `runs/<runId>/report.md` (English) + `runs/<runId>/report.zh-CN.md` (Chinese)

---

## Why it is built this way

| Decision | Reason |
|---|---|
| **Differential by default** — base *and* head | A black-box test that only runs the new code cannot tell a regression from a pre-existing bug. Comparing two revisions turns "it printed an error" into "this PR introduced that error". |
| **Playwright drives the app** | `playwright-core`'s Electron support gives real user input (locators with actionability checks and auto-waiting), main-process evaluation and first-class console/error/network events — with no test hooks injected into the app. Dependency-free hand-rolled protocol code is exactly the kind of thing that quietly rots. |
| **…but a built-in driver backs it up** | A hand-written DevTools Protocol driver covers two cases Playwright cannot: it runs when `playwright-core` is not installed, and it is *required* for dev-server adapters, where an npm script owns the Electron process and Playwright has nothing to launch. Both drivers implement the same page interface, asserted method-by-method by `ebb selfcheck`. |
| **The real Electron binary** | No mocks, no jsdom, no stubbed IPC. Probes attach to the app that actually ships. |
| **Probes are independent and non-fatal** | One broken probe must never hide the other five. Every probe returns the same result shape so revisions can be compared mechanically. |
| **A failed launch is a result, not an error** | `INCONCLUSIVE` is a first-class verdict with crash evidence attached, never a silent pass. |
| **Knowledge is written down** | Every environment quirk and failure mode found while using this process is recorded under `process/knowledge/`, so the process gets better each time. |
| **Build adaptations are declared, not sneaked in** | A packaged Electron app often cannot be observed at all: Electron Forge's `EnableNodeCliInspectArguments` fuse removes the Node inspector that Playwright attaches to. The harness re-enables it **inside the run's disposable worktree only**, records the diff, and states it prominently in the report — because the artifact then does not match the repository's shipped settings. `--no-adapt` turns it off. See `harness/src/adapt.mjs`. |

The one dependency is deliberately `playwright-core` and **not** `playwright`:
the harness drives the application's own Electron binary, so bundled browsers are
never needed and the install stays small.

---

## Layout

```
AGENTS.md                     Canonical entry contract for any agent opening this directory.
CLAUDE.md                     Pointer to AGENTS.md for Claude Code.
.agents/skills/               Skill descriptor (cross-tool convention; also read by DSH).
README.md                     This file.
process/                      The process itself: playbook, version, knowledge, changelog.
  PROCESS.md                  Full step-by-step playbook.
  VERSION                     Process version (bump when the process improves).
  CHANGELOG.md                What changed and why.
  knowledge/                  Reusable findings - true of Electron, of Windows, or of this host.
    environment.md            Host/network/toolchain quirks and recipes.
    failure-modes.md          Ways builds and launches fail, and how to fix them.
    electron-blackbox.md      Electron-specific black-box technique and checklists.
    scenario-authoring.md     How to write a test script for a specific change.
    repo-notes.md             Index of per-repository notes (detail lives in projects/).
projects/                     PER-REPOSITORY material. Not part of the framework.
  <owner>__<repo>/
    NOTES.md                  This app's launch quirks, selectors, pre-existing noise.
    scenarios/                Test scripts written for this app's actual UI.
harness/                      The framework (Node ESM). App-agnostic.
  bin/ebb.mjs                 CLI.
  src/                        Pipeline modules.
    driver.mjs                Playwright driver + DevTools Protocol fallback.
    adapt.mjs                 Declared build adaptations (disposable worktree only).
    launch.mjs                Build, package, and adaptive launch-flag discovery.
    probes.mjs                The seven observation probes + scenario runner.
    explore.mjs               Maps selectors, forms, dialogs, routes, IPC channels.
    session.mjs               Relaunch a built revision for explore/play.
    analyze.mjs               Change triage, scenario scaffolding, base/head comparison.
    buildcache.mjs            Reuse a packaged build for an already-built revision.
  fixtures/smoke-app/         Minimal Electron app used to probe host capability.
  scenarios/                  App-AGNOSTIC scripts only (generic-smoke.json). Keep tiny.
  node_modules/               playwright-core (the only dependency).
runs/<runId>/                 One directory per test run; the report lives here.
work/                         Clones, worktrees, caches, discovered capabilities.
.cache/                       npm/Electron download caches (kept inside the workspace).
```

**`harness/` must stay app-agnostic; `projects/` holds everything that names one
application.** If a script would need editing before it could run against a different
Electron app, it does not belong in the harness. `ebb selfcheck` enforces this for
scripts and fails if a repository-specific-looking file appears in
`harness/scenarios/`.

## Testing a specific change, not just "does it start"

The seven built-in probes prove the app still launches, renders and stays quiet. They
cannot tell you whether the **change** works — that needs a script written for it.

```bash
node harness/bin/ebb.mjs run      --repo <url> --pr 85        # builds both revisions
node harness/bin/ebb.mjs scenario <runId>                     # scaffold aimed at the diff
node harness/bin/ebb.mjs explore  <runId> --side head         # real selectors + IPC channels
#   ...edit projects/<owner>__<repo>/scenarios/<file>.json...
node harness/bin/ebb.mjs play     <runId> --scenario <file>   # iterate in seconds
node harness/bin/ebb.mjs run      --repo <url> --pr 85 --scenario <file>   # final run
```

`explore` and `play` reuse the packaged build a previous run already produced, so the
authoring loop costs seconds per turn. Every report states in section 4 whether it
rested on a script written for the change or only on the generated smoke script — and
carries a coverage caveat in the latter case. See
`process/knowledge/scenario-authoring.md`.

## Using it from any agent framework

The process is deliberately framework-neutral: **it is three shell commands**, and
anything that can run a command can drive it. There is no SDK, no MCP server and no
plugin to install.

```bash
node harness/bin/ebb.mjs doctor  --smoke
node harness/bin/ebb.mjs acquire --repo <url> --pr 85
node harness/bin/ebb.mjs run     --repo <url> --pr 85
```

- `AGENTS.md` is the canonical entry point — the convention most coding agents read.
- `CLAUDE.md` points at it for Claude Code; `.agents/skills/` carries the same
  guidance as a discoverable skill. Adding a pointer for another framework is a
  one-line file that references `AGENTS.md`.
- Every command is non-interactive, writes `runs/<runId>/report.json` for machines
  and `report.md` for humans, and exits `1` on `REGRESSION`/`FAIL` so CI can gate.
  The agent also writes `report.zh-CN.md`, a Chinese translation of `report.md`, so
  each result is delivered in both English and Chinese.

## Runtime

| Scenario | Wall clock (reference host, measured) |
|---|---|
| First run of a revision | ~5–6 min — `npm install` and packaging for both revisions, **concurrently** |
| Repeat run of the same revision | **30 s** — both packaged builds reused, only launch + probe (measured) |
| `--only head` on a cached build | ~15 s |

Packaging dominates everything else, so the harness caches packaged builds by
revision + adapter + platform + applied adaptations (`work/build-index.json`).

**Only the windowless phase runs concurrently.** Installing and packaging need no
window, so both revisions are built at once. Launching and probing is deliberately
**serial**, because running two Electron instances together puts two identically
titled windows on screen, doubles the app's real startup work, and would silently
break any app that takes a single-instance lock. `parallelExercise: true` opts back in
and warns; `--serial` disables concurrency entirely.

**And the harness decides that itself.** Separate `--user-data-dir` isolates each
app's own profile and nothing else — not ports, not shared config files, not
containers, not remote state. Before building anything, the harness scans the diff for
external-effect markers, and while the app runs it observes definitive evidence
(`app.hasSingleInstanceLock()`, fixed listening ports). Anything above "none" forbids
overlapping runs *whatever was requested*, and the reason lands in the report. The
observed result is cached in `work/capabilities.json`.

> Subtlety worth knowing: `requestSingleInstanceLock()` is scoped to the user-data
> directory, so giving each revision its own `--user-data-dir` gives it its own lock
> namespace too. The lock does **not** stop two test instances — which is precisely why
> this has to be an explicit signal.

---

## The pipeline

```
acquire ──► prepare ──► launch ──► probe ──► compare ──► report
   │           │          │         │         │           │
   │           │          │         │         │           └─ report.md + report.zh-CN.md + report.json
   │           │          │         │         └─ base vs head, per probe
   │           │          │         └─ windows, console, visual, network,
   │           │          │            main-process, stability, scenario
   │           │          └─ adaptive flag discovery over CDP
   │           └─ detect toolchain, install, package
   └─ clone, resolve PR/range, create base+head worktrees
```

**Acquire** resolves a pull request through the GitHub API (so the *actual* base
branch is used, not the default branch) or parses an explicit `A..B` / `A...B`
range, then diffs from the merge base. Base and head become two `git worktree`
checkouts sharing one object store.

**Prepare** detects the package manager from the lockfile, the toolchain
(electron-forge / electron-builder / plain), and derives an ordered list of launch
adapters. A packaged binary is preferred because it is the most faithful black-box
target; if packaging fails the harness falls back to the dev script so a build
break still produces a useful run.

**Launch** starts the app and waits for its first window, trying three drivers in
order until one attaches:

| Rung | Driver | Needs | Gives |
|---|---|---|---|
| 1 | Playwright `_electron.launch` | the main-process Node inspector | Full Playwright API and main-process evaluation |
| 2 | Playwright over `chromium.connectOverCDP` | only the DevTools port | Locators and auto-waiting, no main-process access |
| 3 | Built-in CDP client | nothing (no dependencies) | DOM, console, screenshots — no actionability checks |

Which rung won is recorded in the report. Dev-server adapters skip to rung 2 or 3,
because an npm script owns the Electron process and Playwright has nothing to launch.
Launch flags are tried in order and the winning set is cached in
`work/capabilities.json`; an explicit `--user-data-dir` is injected on every attempt.
See `process/knowledge/environment.md` for why that flag is mandatory and not merely
tidy.

**Probe** attaches to every window and to the main process, then runs:

| Probe | Observes |
|---|---|
| `windows` | Window/target inventory; did a window ever appear |
| `console` | Console errors, uncaught exceptions, browser log errors |
| `visual` | Screenshot per window, DOM fingerprint, blank-surface detection |
| `network` | Failed requests |
| `main-process` | Electron/Chrome/Node versions, window security preferences, app paths |
| `stability` | Reload rounds and any new exceptions |
| `scenario` | Declarative interaction steps with assertions |

**Compare** classifies every probe as `REGRESSION`, `FIXED`, `CHANGED`,
`UNCHANGED` or `INCONCLUSIVE`, and diffs comparable metrics between the revisions.

**Report** renders Markdown with the verdict, the change triage, a base-vs-head
matrix, metric deltas, severity-ranked findings with evidence, screenshot links,
environment facts and the exact command to reproduce the run.

---

## Reading the result

```
REGRESSION     head is worse than base (exit 1)
CHANGED        observable behaviour differs; may be intended
NO_REGRESSION  both ran, nothing got worse
PASS/WARN/FAIL single-sided run
INCONCLUSIVE   a revision never ran — NOT a pass
```

---

## Improving the process

This repository is meant to change. After each run, record whatever you learned —
a proxy that was needed, a repo whose build step differs, a probe that produced a
false positive — in `process/knowledge/`, bump `process/VERSION`, note it in
`process/CHANGELOG.md`, and run `node harness/bin/ebb.mjs selfcheck`.
