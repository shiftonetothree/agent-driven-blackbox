# PROCESS — the playbook

The full procedure for testing a change in an Electron application. `AGENTS.md` is
the short contract; this is the detail.

Version: see `process/VERSION`.

---

## Step 0 — Establish the subject

The human gives a repository URL. **Do not start cloning yet.**

Ask for the change, using `ask_user_question`, offering both forms:

```
要测试哪个改动？请二选一：
  1) Pull Request 编号，例如 85
  2) 一段 git commit 范围，例如 v1.2.0..v1.3.0 或 abc123..def456

Which change should I test? Pick one:
  1) A pull request number, e.g. 85
  2) A git commit range, e.g. v1.2.0..v1.3.0 or abc123..def456
```

Then ask the single follow-up that changes the cost of the run:

> Compare against the base revision too, or test only the new code?
> (Comparing finds regressions; head-only is roughly twice as fast.)

Both questions are cheap compared to a wrong multi-minute build.

**Do not proceed without an answer.** If the human says "you pick", choose a
head-only run of the default branch's latest commit and say clearly that this cannot
detect regressions.

---

## Step 1 — Capability check

```bash
node harness/bin/ebb.mjs doctor --smoke
```

Read every `FAIL`. This step exists so that an environment problem is never reported
as a defect in the repository under test.

- `workspace-writable` FAIL → the session's file permissions are wrong; nothing else
  will work.
- `git-remote` FAIL → no clone; fix the proxy or TLS backend
  (`process/knowledge/environment.md` §2).
- `electron-launch` FAIL → the host cannot run Electron at all. **Stop and report
  this.** Do not produce a test report that implies coverage you do not have. Attach
  the crash evidence the doctor prints.
- `crash-dumps` warn with historical dumps → expected on this host; those predate
  the run.

---

## Step 2 — Resolve the change set (cheap, no build)

```bash
node harness/bin/ebb.mjs acquire --repo <url> --pr <n>
node harness/bin/ebb.mjs acquire --repo <url> --range <A..B>
```

Show the human, before spending build time:

- which base branch and which head commit were resolved,
- the size of the diff,
- the risk triage (which areas changed, and which probes they imply).

Sanity-check the resolution. If the diff is enormous, or the base branch looks
wrong, resolve it now — not after two package builds. For a pull request the base is
taken from the API (`base.ref`), so it is the *real* target branch and not the
repository default.

---

## Step 3 — Decide the test plan

Three decisions, in order of preference.

**a. Which adapter.** `acquire` and the run both write `project.json` describing the
detected toolchain (electron-forge / electron-builder / plain) and an ordered adapter
list. Default is the first. A **packaged binary** is the most faithful target — it is
what the human actually ships, and it is also the only form Playwright can drive
directly, since Playwright must own the Electron process. Fall back to the dev script
only when packaging fails or is prohibitively slow; that routes the launch through
the built-in CDP driver instead, and you must record the choice in the report's
limitations.

**b. Which scenario — this step is mandatory.** With no input, the harness derives a
generic smoke scenario: the document settles, a body element exists, no uncaught
console errors, a screenshot. That is not a test of the change. **A run without a
script written for the change reports a coverage caveat and must not be presented as a
clean bill of health.**

Write one:

```bash
node harness/bin/ebb.mjs scenario <runId>             # scaffold aimed at this diff
node harness/bin/ebb.mjs explore  <runId> --side head # what the app ACTUALLY exposes
#   ...edit the script...
node harness/bin/ebb.mjs play     <runId> --scenario <file>            # seconds per attempt
node harness/bin/ebb.mjs play     <runId> --side base --scenario <file>
```

`explore` maps durable selectors, forms, dialogs open right now, reachable routes, and
every registered IPC channel and menu item — it is how you avoid inventing selectors
that do not exist. `play` reuses an already-built revision, so iteration is seconds,
not minutes.

Two rules that matter more than the rest, both learned the hard way:

1. **Dismiss any first-run modal first.** In the reference project the app opened a
   dialog over everything, and the generic probes reported a healthy page that was
   entirely modal text.
2. **One script per question.** A blocker assertion that the new API exists *fails on
   the base revision by design* and stops the script, so everything after it is
   skipped. Put the feature-presence assertion in its own script (it will classify as
   `FIXED`), and put downstream health assertions in a second script that completes on
   both revisions. That split is what distinguishes a regression from pre-existing
   noise.

Full method, action reference and common mistakes: `process/knowledge/scenario-authoring.md`.

**Where the script goes.** `ebb scenario` writes to
`projects/<owner>__<repo>/scenarios/` — per-repository material, kept out of the
framework. `harness/scenarios/` holds only app-agnostic scripts and must stay tiny;
`ebb selfcheck` fails if a repository-specific-looking file appears there. If a script
would need editing before it could run against a different app, it belongs under
`projects/`.

**c. Both sides or one.** Both is the default and is the only way to claim a
regression.

---

## Step 4 — Run

```bash
node harness/bin/ebb.mjs run --repo <url> --pr <n> [--scenario <file>] [--adapter <id>]
```

The pipeline is `acquire → prepare → launch → probe → compare → report`. Expect
minutes, not seconds on a cold run: dependency install plus packaging, twice.

**Only the windowless phase runs concurrently.** Both revisions are built at once
(install + package), but they are launched and probed **one at a time**. Running two
Electron instances together puts two identically titled windows on screen, doubles the
app's real startup work, and would silently break an app that takes a single-instance
lock — the second instance would quit and you would test one revision twice while
believing you tested two. Pass `--parallel-exercise` to override, or `--serial` to
disable concurrency entirely.

### Overlapping runs are refused automatically when they could interfere

Separate `--user-data-dir` isolates each app's *own* profile, and that is all it
isolates. An Electron app routinely reaches beyond it: ports, shared config files,
containers, registry keys, remote services. Two overlapping runs that share any of
those can interfere, and a comparison between them would not mean anything.

You do not have to work this out per repository. Before anything is built, the harness
scans the diff for external-effect markers (services, install/remove, sync/backup,
config files, container/VM runtimes, system integration, network transfers, fixed
ports, large main-process changes). While the app is live it also observes
definitive evidence: `app.hasSingleInstanceLock()` and any fixed listening port owned
by the app's processes.

Anything above "none" **forbids overlapping exercise whatever was requested** —
`--parallel-exercise` is a request, not an override — and the reason appears in the
report. The observed result is remembered in `work/capabilities.json`, so later runs
do not rediscover it.

Note the lock subtlety: `requestSingleInstanceLock()` is scoped to the **user-data
directory**, so giving each revision its own `--user-data-dir` also gives it its own
lock namespace. The lock therefore does *not* stop two test instances from running —
which is exactly why this has to be an explicit signal rather than something the app
enforces for us.

Watch for these while it runs:

- **Install failure** → there is no test; report the install error as the result.
- **Packaging failure with a successful fallback** → test continues on the dev path;
  this must appear in the limitations.
- **A driver downgrade** → if the log says `playwright-core is not installed` or that
  the Playwright driver could not start the app, the run fell back to the CDP driver.
  Interaction steps then have no actionability checks. Either install the driver
  (`npm install` inside `harness/`) or say so in the report.
- **Launch failure on one side only** → that is itself a serious finding (the change
  broke startup). Confirm it by re-running the failing side once
  (`--only head`) to rule out a transient.
- **Both sides failing to launch** → almost always the host, not the change. Go back
  to Step 1.

---

## Step 5 — Read the report

`runs/<runId>/report.md`.

1. **Verdict.** `INCONCLUSIVE` is not a pass.
2. **Launch section.** Adapter, flags, engine version, time to ready.
3. **Probe matrix.** base vs head per probe.
4. **Metric deltas.** `consoleErrors 0 → 3` is the kind of thing that matters even
   when both sides "pass".
5. **Findings**, worst first, each with evidence.
6. **Screenshots.** Look at them; a machine cannot tell you the layout is wrong.

Then judge:

- A **regression** needs a plausible causal link to the diff. Check the triage: does
  the failing probe correspond to an area the change touched? If not, suspect
  flakiness and re-run before reporting.
- A **change** may be intended. Report the delta; do not editorialise.
- An **improvement** is worth mentioning; it means the PR fixed something.

---

## Step 6 — Report to the human

Lead with the verdict in one line, then:

- what was tested (repo, PR/range, both revisions, adapter),
- what changed in behaviour, with the numbers,
- what you could **not** test, and why,
- the report path.

Never overstate coverage. If a probe was skipped, say so. If only one revision ran,
say so. If the packaged artifact was not exercised, say so.

---

## Step 7 — Evolve the process

This step is the reason the process improves rather than repeating itself.

Ask: *what did I learn that the next run should not have to learn again?*

| Learning | Destination |
|---|---|
| Environment quirk (proxy, TLS, cache, a required flag) | `process/knowledge/environment.md` |
| A build/launch failure and its fix | `process/knowledge/failure-modes.md` |
| A new observation technique or assertion | `process/knowledge/electron-blackbox.md` |
| A repository that needed a custom adapter/scenario | `process/knowledge/repo-notes.md` |
| A harness code change | `harness/` + `ebb selfcheck` |
| A config-only change (mirror, proxy, extra flag) | `harness/ebb.config.json` |

Then:

1. Bump `process/VERSION` (patch = docs/knowledge, minor = harness behaviour,
   major = pipeline shape).
2. Add a `process/CHANGELOG.md` entry saying what changed and *why*.
3. Run `node harness/bin/ebb.mjs selfcheck` — it must be fully green.
4. If you changed harness behaviour, re-run the most recent case to confirm you did
   not regress the process itself.

**Anti-patterns.** Weakening a probe so a run passes. Hard-coding a repository's
paths into harness logic instead of adding an adapter or a scenario. Adding an npm
dependency. Recording a "fix" in the changelog without verifying it.
