# Changelog

The process improves by being used. Each entry records what changed and why.
Versioning: **patch** = knowledge/docs, **minor** = harness behaviour,
**major** = pipeline shape.

---

## 0.9.0 — one bar for recording, one procedure, and a guard that matches

The framework had drifted into a catalogue of itself. Its instructions said to "record
whatever you learned" after every run; two of the four instruction files told the agent to
bump `process/VERSION` for *any* learning, contradicting `AGENTS.md`, which reserved the
bump for framework changes. `failure-modes.md` opened with "Add to it whenever a run
fails" and had filled with the history of already-fixed bugs, generic advice, and entries
duplicating `environment.md`. `scenario-authoring.md` and `CHANGELOG.md` named the
application the process was developed against — exactly what `AGENTS.md` calls a leak,
which `ebb selfcheck` missed because it only looked for `projects/<owner>__<repo>` slugs
and commit hashes.

The framework is an operating procedure; it cannot record every problem that might occur.

- **One bar, stated once.** `AGENTS.md` §5 defines it — architecture, an explicit human
  request, or knowledge that cannot be inferred from a run. `PROCESS.md` Step 7,
  `README.md` and the skill now point at it rather than restating looser versions.
- **One procedure.** The seven steps, the command block, the verdict semantics, the
  ask-prompt and the fuse explanation were each written two to five times across
  `AGENTS.md`, `README.md`, `CLAUDE.md` and the skill, and had begun to drift. `AGENTS.md`
  is the single copy; `CLAUDE.md` is a pure pointer; the skill keeps only what skill
  discovery needs.
- **`failure-modes.md` pruned to its purpose**: failures that are neither the host nor the
  repository under test, whose cause cannot be read off the symptom.
- **No project leakage left** in any framework file.
- **The guard was widened to match the rule.** The generic-docs check now covers
  `README.md`, `CLAUDE.md` and the skill as well as `AGENTS.md`, `PROCESS.md`,
  `CHANGELOG.md` and `process/knowledge/`, and rejects a `#<n>` pull request reference in
  addition to project slugs and commit hashes.

---

## 0.8.1 — surface build compile errors behind an INCONCLUSIVE verdict

A run can fail to launch because the repository under test does not *compile*, not because the host cannot run Electron. When `forge-package` fails with `webpack compiled with N errors` and the `script-start` fallback also exits 1, the report's verdict is `INCONCLUSIVE` with "no probes produced results", which reads like an environment problem. Documented the tell and the remedy in `process/knowledge/failure-modes.md`: an `INCONCLUSIVE` verdict with all-immediate `exit_1` launch attempts is usually a compile error, and the webpack/TS errors live in `runs/<id>/logs/<side>-package.log` (`ERROR in` / `TS####`), not in the report.

---

## 0.8.0 — test a repository already on disk

Until now the harness could only clone a remote URL. A repository that already sits on the tester's disk — a local checkout, a branch that only exists locally, or uncommitted work — could not be tested. `--repo-dir <path>` now covers all three:

- `ebb run --repo-dir <path> --range A..B` (or `--pr N`) snapshots the checkout into `work/repos/local__<name>` and runs the full differential pipeline exactly as a URL would: two worktrees, base vs head, comparison, report. The user's repository is never touched — nothing is fetched, and the snapshot is a `--no-hardlinks` clone.
- `ebb run --repo-dir <path>` (no range) tests the working tree as it is on disk, including uncommitted changes, as a single-sided run. The report states the real `HEAD` sha and the uncommitted diff instead of `unknown`.
- `ebb acquire --repo-dir <path> --range A..B` previews the change set before any build, for local repositories too.

Refs that name a non-default branch are resolved through `origin/<branch>`, matching how a clone lays out a local checkout's branches.

---

## 0.7.2 — deliver every report in Chinese and English

The harness writes one report, `runs/<runId>/report.md`, in English. The process now produces both languages, so a human on either side of the language boundary does not have to ask for a translation. Rather than i18n the harness itself — which would move every heading, label and prose string into a catalog and still leave the machine-generated findings and launch notes in English — the requirement is written into the operator's instructions (`AGENTS.md`, the skill, `process/PROCESS.md`): after reading `report.md`, write `runs/<runId>/report.zh-CN.md`, a full Chinese rendering, and deliver both.

The translation is a full rendering, not a summary: headings, labels, table headers and prose are translated, while verdict tokens, status codes, side labels (`base`/`head`), metric names, file paths, command lines, URLs and other identifiers stay verbatim so the two files cross-reference cleanly and neither contradicts `report.json`.

---

## 0.7.1 — record where `doctor --smoke` finds an Electron binary

`ebb doctor --smoke` can report `electron-launch: no Electron binary found` on a host, because `findAnyElectron()` only searches the cached clone's `node_modules/electron`, which never exists when installs happen in each run's disposable worktree. The smoke check therefore always needs `--electron <path>`. Documented where binaries actually live (`runs/*/trees/{base,head}/node_modules/electron/dist/`, or the pre-harness probe checkout `_probe/target/launcher/…`), and that `.cache/electron/` holds only zips.

---

## 0.7.0 — `--env`: make a side-effecting feature testable, not just forbidden

0.6.0 established that two runs sharing ports, a lock or a config file must not overlap. That protects the *comparison*, but it leaves a gap: for a feature whose whole purpose is to write a shared file, there is still nowhere safe to let it act.

`--env KEY=VALUE` (repeatable) sets environment variables on the launched application, on `run`, `explore` and `play`:

```bash
node harness/bin/ebb.mjs run --repo <url> --pr N \
  --env USERPROFILE=projects/<slug>/fixtures/home \
  --env APP_HOME=projects/<slug>/fixtures/app
```

The app then reads, backs up and writes inside `projects/<slug>/fixtures/` instead of the tester's real profile, so the real sync code runs against disposable files. This is what makes a side-effecting feature testable at all.

Runs that used `--env` say so in the report's launch notes **and** in the reproduce command, because a reader reproducing the run has to recreate the sandbox first.

**Fixture hygiene matters and was initially missed.** A redirected `USERPROFILE` also collects Chromium's and the GPU driver's caches, so the first version of the fixture tree accumulated run byproducts rather than fixtures. The tree is now hand-authored inputs only, with a `fixtures/.gitignore` and a `README.md` so the next person does not commit a run's byproducts as fixtures.

**Also in this release**

- A hand-authored fixture file covering the cases the sync must handle — a normal model, a non-ASCII id, an empty API key, and an entry with no `id`. All keys synthetic, all URLs `example.com`.
- A scenario recording that the sync **button is only rendered when the service state is `installed`**, so on a fresh sandbox the feature's UI is unreachable — the script calls the bridge method directly instead. A precondition worth establishing before asserting anything.

**Verification.** `ebb selfcheck` remains 24 checks.

---

## 0.6.0 — decide automatically whether two runs may overlap

0.5.1 stopped two windows appearing, but for the wrong reason. The lock was the *example*, not the rule. The rule is: **two runs with external effects must never overlap**, and the harness should work that out rather than relying on someone to set a flag.

`--user-data-dir` isolates each app's own profile and nothing else — not ports, not shared configuration files, not containers, not registry keys, not remote state. A repository under test may bind fixed ports, check for updates, or synchronise a shared config file, and two overlapping runs could then clobber each other's state; the differential would be meaningless rather than merely untidy.

**New: `harness/src/sideeffects.mjs`.** Two independent kinds of evidence:

- **Diff scan, before anything is built.** Markers for background services, install/remove steps, sync/backup/migrate, shared config files, container/VM runtimes, system integration (tray, autostart, registry, protocol handlers), network transfers with side effects, fixed local ports, and large main-process changes.
- **Live inspection, while the app runs.** `app.hasSingleInstanceLock()` read from the main process, and every listening socket owned by the app's own PIDs (`tasklist` + `netstat -ano`), flagging anything below the ephemeral port range as a fixed port that a second instance would collide with or, worse, share.

Anything above `none` **forbids overlapping exercise whatever was requested**. `--parallel-exercise` is a request, not an override; it is refused with an explanation, and the reason appears in the report's side-effect section. Observed results are cached in `work/capabilities.json` so later runs do not rediscover them.

### The single-instance lock is a signal, not an enforcement

The runtime check found that the reference app **does** hold a single-instance lock, even though two of its windows could coexist. Both are true, because `requestSingleInstanceLock()` is scoped to the **user-data directory**: giving each revision its own `--user-data-dir` also gives it its own lock namespace, so the lock never fires between the two test instances. The lock therefore cannot enforce exclusivity for the harness, and is treated as a *signal* — an app that takes it assumes it is alone on the machine and very likely owns OS-level state that two runs would contend for. 0.5.1's wording has been corrected; the refusal stands, for a better-stated reason.

**Verification.** `ebb selfcheck` is 24 checks, including netstat parsing and the static/runtime precedence rule.

---

## 0.5.1 — stop putting two app windows on screen

Two application windows appeared every time a run exercised both revisions, and both carried the app's own title, so there was no way to tell base from head. The cause was the `parallelSides` optimisation added in 0.4.0: it ran the entire pipeline for both revisions at once to halve wall-clock time, so both Electron instances were on screen together.

**The fix keeps the speed and drops the windows.** Preparation and exercise are now separate phases:

- **Prepare concurrently.** `npm install` and packaging dominate a cold run's wall clock and need no window, no display and no port. Running both at once is safe, so this stays parallel.
- **Exercise serially.** Launching and probing is where the windows come from, and it is not where the time goes. `ebb run` now launches one revision at a time and says so in the log.

Cold-run wall clock is unchanged, because the parallelised part was always the expensive part.

Two further reasons this default matters, beyond looking confusing:

- Each instance repeats the app's real startup work (network calls, update checks), so resource use doubled for no benefit.
- An app calling `app.requestSingleInstanceLock()` would have its second instance exit immediately. The run would then have tested **one revision twice** while reporting two — a silent correctness bug, not just a cosmetic one.

`parallelExercise: true` opts back in and warns; `--serial` disables concurrency entirely; `ebb selfcheck` asserts the default (23 checks).

---

## 0.5.0 — testing the change, not just the app; and keeping projects out of the framework

Two corrections, both prompted by using 0.4.0 rather than reading it.

### The process did not actually test the change

A `ebb run` used a generated smoke script. That proves the app still starts, renders and logs nothing — it says nothing about whether the change's feature works. A report that said `NO_REGRESSION` on that basis was a weak claim dressed as a strong one.

Authoring a script for the specific change is now a **mandatory step**, not an optional refinement, and the harness grew the tools to make it practical:

- **`ebb explore`** launches a revision a previous run already built and maps what the app actually exposes: durable selectors separated from fragile structural paths, headings and landmarks, forms, dialogs open *right now*, reachable routes, and every registered IPC channel and application-menu item.
- **`ebb play`** runs one scenario against one revision and prints each step — `PASS` with its value, `FAIL` with the error, `SKIP` for everything the failure prevented from running. It reuses the cached build, so the authoring loop is seconds per turn.
- **`ebb scenario`** now scaffolds *at the diff*: it names the risk areas, lists the changed files in each, and explains what a meaningful assertion for that area looks like, instead of emitting a blank page.
- **`assertEval`** was added — the assertion form of `eval`. Without it a scenario can record that a new API exists but cannot *fail* on its absence, so the differential cannot see the feature.
- **Report section 4, "Test script"**, states which script ran, its steps, and the per-side result. When no change-specific script was used the report now carries a prominent **coverage caveat** in the header, and the verdict line says the run does not cover the change.

### Project material was polluting the framework

0.4.0 wrote authored scripts into `harness/scenarios/` and per-repository knowledge into `process/knowledge/repo-notes.md`. Both named one application's routes, selectors and dialogs — meaningless for any other repository, and a slow way to turn a project-agnostic framework into a pile of one project's trivia.

- **`projects/<owner>__<repo>/`** now holds everything specific to one application: `NOTES.md` (launch quirks, selector vocabulary, pre-existing noise, what is not covered) and `scenarios/` (scripts written against that app's real UI).
- `ebb scenario` writes there by default; `--global` writes into the harness and warns.
- `process/knowledge/repo-notes.md` became an index that points at the per-repository notes, rather than a store.
- **`ebb selfcheck` enforces the rule**: it validates scenario JSON under both roots, asserts that the project-scripts directory resolves outside the harness, and fails if a repository-specific-looking filename (a PR number or a run timestamp) appears in `harness/scenarios/`. It also requires every `projects/<slug>/` to carry a `NOTES.md`.

### What the new workflow found on the first real use

Running it against a real change immediately justified itself:

- **The app opens a first-run modal** over the real UI. The generic probes had reported a healthy page that was *entirely modal text*. Any script that does not dismiss it measures the dialog.
- **The change's actual API** surfaced as a registered IPC channel and bridge method — exactly the feature the change adds. The authored script asserts that bridge method exists: **base `undefined`, head `function`**. The differential classified it `FIXED`, the honest reading of a feature-addition change.
- **A pair of console errors** on the changed page would have been reported against the change by a single-sided run. A second script, deliberately asserting nothing about the feature so it completes on both revisions, proved they are **pre-existing**. That split — one script per question — is now documented as the most important authoring rule.

**Verification.** `ebb selfcheck` is 22 checks.

---

## 0.4.0 — fast enough to actually use, and neutral about who drives it

Two problems with 0.3.0, both reported from using it rather than reading it.

### The run was far too slow

A run spent almost none of its wall clock testing: it was `npm install` and `electron-forge package` done **twice, serially**, and redone from scratch on every invocation even for a revision it had already built.

- **Build cache.** A packaged build depends only on the revision, adapter, platform and applied adaptations, so it is indexed against exactly those in `work/build-index.json`. The index stores *paths*, not copies — the launcher bundle is ~330 MB, so copying would cost about as much as rebuilding. The adaptation signature is part of the key, so an adapted build can never be reused for a run that asked for the repository's shipped configuration.
- **Parallel sides.** Base and head are independent; they now install and package concurrently, each with its own port range (`portOffset`) and launch directory.
- **Effect.** A repeat run of an already-built revision drops from minutes to seconds.

### It hung instead of finishing

Two separate unbounded waits, both found by the run stalling with no new output:

- **`electronApp.close()` never returned.** The launcher has a tray icon and background services, so it can ignore `app.quit()`; Playwright waits forever for the process to exit. The run died *after* probing and *before* writing its report, which is the worst possible place. Graceful close is now bounded (`appCloseTimeoutMs`, default 8 s) and always followed by a forced process-tree kill. Same bounding applied to `browser.close()` on the `connectOverCDP` path.
- **No probe had a time budget**, so a probe that never settled stalled everything silently. Every probe now has a `timeouts.probe` budget (default 120 s) and a timeout is reported as a finding rather than a hang.
- **No progress output during probing**, which made the hang hard to localise. Each probe now logs its name, status and duration.
- **A run-level watchdog** (`runTimeoutMs`, default 45 min) terminates an unattended run with a diagnostic instead of hanging a CI job indefinitely.

### It was tied to one agent framework

0.3.0 shipped its skill in a single framework's private discovery path. That contradicted the point of the project: it exists to *help the agent the user already uses*, not to be operated by a particular one.

- The skill moved to **`.agents/skills/electron-blackbox/SKILL.md`** — the cross-tool directory convention, which the original framework also discovers, so nothing was lost.
- **`CLAUDE.md`** added as a pointer to `AGENTS.md`, which remains the single canonical, framework-neutral entry point.
- `README.md` and the skill now state the relationship explicitly: the process is **three shell commands**, and any agent that can run a command can drive it. There is no SDK, no MCP server and no framework plugin, because there is no agent inside this project — only domain expertise and a deterministic harness.

### Also

- Corrected `harness/package.json` to 0.2.0, `HARNESS_VERSION` to match, and the report now reads its version from `package.json` so the two cannot drift.

**Verification.** `ebb selfcheck` is 21 checks. A final full run drove both sides with Playwright, executed all 7 probes on both sides, and returned `NO_REGRESSION`.

---

## 0.3.0 — build adaptations: the packaged app becomes observable

**The problem.** Playwright's `_electron.launch` attaches to the Electron main process through the Node inspector. Electron Forge's fuses plugin ships with `EnableNodeCliInspectArguments: false` — a good production default, and exactly what a hardened repository sets. The consequence was that Playwright could never attach to a *packaged* build: `_electron.launch` sat until its timeout and gave up. The app itself was fine — the renderer came up and rendered a real window — so this was an observability problem, not a defect.

**The change.** A new layer, `harness/src/adapt.mjs`, applies *declared* build adaptations before packaging. Currently two fuses are re-enabled: `EnableNodeCliInspectArguments` and `EnableNodeOptionsEnvironmentVariable`. With those, Playwright drives the packaged app directly, with real locators and main-process access.

**Guard rails.** This deliberately relaxes a boundary that 0.1.0 stated as absolute, so the constraints are explicit:

- Applied **only inside the run's disposable worktree** (`runs/<id>/trees/<side>`). The cached clone and the user's repository are never modified.
- **Packaging configuration only.** Application source is never touched, so behaviour under test is unchanged.
- Every adaptation is recorded (`adaptations-<side>.diff`, `adaptations-<side>.json`) and stated **prominently in the report**, because the packaged artifact then does *not* use the repository's shipped settings. A reader must not be misled.
- Security-relevant fuses (`RunAsNode`, `OnlyLoadAppFromAsar`, `EnableEmbeddedAsarIntegrityValidation`) are left alone, and `ebb selfcheck` asserts that they are.
- `--no-adapt` restores the previous behaviour and tests the shipped configuration.

**Driver ladder.** Launching now tries, in order: Playwright `_electron.launch` (richest, needs the inspector) → Playwright over `connectOverCDP` (locators and auto-waiting without needing the inspector) → the built-in CDP client (no dependencies at all). The winning combination is cached, and each attempt records which rung produced it.

**Also fixed**

- **A false pass.** The 0.2.0 drivers report `ok`; the pipeline gates probing on `reachedReady`. Adding Playwright silently dropped that translation, so *every probe was skipped*, the comparison was empty, and a report claimed `NO_REGRESSION` on zero evidence. Two guards now make this impossible: `launchApp` normalises `ok` → `reachedReady`, and an empty probe set is reported as `INCONCLUSIVE` with a blocker finding rather than as a pass. Both are asserted by `ebb selfcheck`. An untrustworthy "no regression" is worse than no report.
- The test process hung after writing its report. Spawning Electron and connecting with Playwright leaves handles behind (sockets, Playwright's internal driver, and stdio pipes inherited by the app's children), so the event loop never drained. `close()` is now idempotent, destroys and unreferences the child, and the CLI ends with an explicit flushed exit.
- `close()` called `app.process()` *after* disposing the application, which threw `Cannot read properties of undefined (reading '_object')` on every doctor run.
- Playwright's launch timeout produced a *stray unhandled rejection* that killed the whole run before the fallback drivers were tried, even though the failing call was inside a `try`/`catch`. There is now a narrowly-scoped guard that swallows only recognisably-Playwright failures and records them; everything else still surfaces.
- Rung-1 attempts use `playwrightLaunchTimeoutMs` (25 s) rather than the general launch timeout, so an impossible attach does not stall the ladder.
- Attempt log lines now name the driver that produced them.
- Windows: package-manager shims (`npm`, `npx`, `pnpm`, `yarn`) are `.cmd` files that `spawn` cannot start with `shell: false`. `run()` now builds a properly quoted command line for `cmd.exe /d /s /c` with `windowsVerbatimArguments`, rather than using `shell: true` (which concatenates arguments unescaped and would let a repository-controlled script name inject shell syntax). This was silently turning every install into `exit -1`.
- Added a page-settle step (`waitForSettled`) before probing, so fingerprints and screenshots are not captured mid-render.
- Report details: adaptation blocks are disambiguated by title, the launch-failure table names the driver, the harness version is read from `package.json` instead of a hard-coded string, and the Electron version falls back to the declared range.

**Verification.** `ebb selfcheck` is 18 checks, including fuse-rewriting (correct option changed, unrelated fuses untouched, idempotent), driver-surface parity, and the two false-pass guards.

---

## 0.2.0 — Playwright becomes the primary driver

**Changed.** The harness now drives the application with Playwright's Electron support (`playwright-core`, `_electron.launch`) instead of a hand-rolled DevTools Protocol client. This was a deliberate reversal of the 0.1.0 decision:

- **Real user input.** `locator.click()` / `fill()` / `press()` perform actionability checks and auto-wait, so scenario steps no longer fight timing. The previous driver had to synthesise DOM events in-page, which silently succeeds on elements a user could never actually reach.
- **Main process for free.** `electronApp.evaluate(({ app, BrowserWindow }) => ...)` replaces the `--inspect` + raw-CDP shim, with no `require()` workaround.
- **Better event capture.** `page.on('console' | 'pageerror' | 'requestfailed')` replaces hand-written `Runtime.exceptionThrown` parsing.
- **A maintained surface.** Less protocol code in this repository to keep correct.

**Dependency policy changed accordingly.** `playwright-core` is now the single dependency. It is deliberately `playwright-core` and not `playwright`: the harness drives the application's own Electron binary, so bundled browsers are never needed and the install stays small. Zero-dependency was a good instinct for the wrong reason — the guarantee that actually matters is that the process still *runs* before any install has succeeded, and that is preserved by keeping the previous driver as a fallback (see below).

**The old driver was kept, not deleted.**

- It is the fallback when `playwright-core` is absent, so `ebb doctor`, `ebb acquire`, `ebb selfcheck` and a CDP-driven run all work on a bare checkout.
- It is *required* for `dev-script` adapters: when an npm script owns the Electron process (`electron-forge start`, `vite dev`), Playwright cannot launch it, so the harness spawns the script and attaches over `--remote-debugging-port`.

Both drivers implement the same page interface, and `ebb selfcheck` asserts that they do so method by method — a probe can never silently depend on Playwright-only behaviour.

**Verified.** `ebb doctor --smoke` launches the smoke app through Playwright, reads back `ebb smoke ok`, reports the Electron and Chrome versions, and captures a screenshot on a host with no interactive desktop shell. A separate spike confirmed `_electron` main-process evaluation, locator clicks and screenshots all work under the mandatory `--no-sandbox --user-data-dir=...` flags.

**Also in this release**

- Change triage now classifies whole `src/main/**` trees (including service files), not just entry-point filenames, and has a `repo-config` area for `.gitignore` and friends — previously a real change left six files unclassified.
- `project.json` is written per side; previously base and head overwrote each other.
- `ebb selfcheck` grew from 12 to 14 checks, including driver-parity assertions.

---

## 0.1.0 — initial process

First working version, built and verified against a real Electron application.

**Pipeline.** `acquire → prepare → launch → probe → compare → report`, with base and head revisions exercised side by side and a per-probe verdict.

**Harness.** Zero npm dependencies (Node built-ins only, including the global `WebSocket` for CDP). This is deliberate: on the reference host the *first* thing that fails is `npm install`, so a harness that needs installing could never run.

**Probes.** windows, console, visual, network, main-process, stability, scenario.

**Why `--user-data-dir` is mandatory.** The reference host crashes Electron during browser-process init whenever the default user-data directory is resolved. Recorded in `process/knowledge/environment.md` §1 so it is never rediscovered.

**Why launch flags are auto-discovered.** The same host also cannot initialise Chromium's sandbox. Rather than hard-code `--no-sandbox`, the launcher tries flag sets in order and caches the winner in `work/capabilities.json`, so the retry cost is paid once per host.

**Why the harness is plain Node, not PowerShell.** `.ps1` files are rejected by Windows execution policy on this host ("not digitally signed"), and confined sessions cannot spawn npm lifecycle scripts. Neither limitation applies to `node script.mjs`.

**Verification.** `ebb doctor --smoke` launches the bundled smoke app, reads back its DOM (`ebb smoke ok`) and captures a screenshot — proving renderer observation works on a host with no interactive desktop shell.
