# AGENTS.md — Electron black-box testing process

This directory **is** an Electron black-box testing process. It is meant to be opened
by an agent and driven by a human in conversation. Nothing here is specific to one
repository.

Read this file first. Then read `process/PROCESS.md` for the full playbook.

---

## 1. What a human expects when they open this directory

They will say something like:

> "测试这个仓库：https://github.com/owner/name"
> "Test this repo: https://github.com/owner/name"
> "Test this repo on disk: /path/to/checkout"

Your job from that moment is fixed and non-negotiable in order:

1. **Ask which change to test — do not guess.**
   Use `ask_user_question`. Ask for **either** a pull request number **or** a git
   commit range. Do not start a long clone/build before you have the answer.

2. **Run the capability check.**
   `node harness/bin/ebb.mjs doctor --smoke`

3. **Resolve the change set** and show the human what you are about to test.

4. **Write a test script for this change. Do not skip this.**
   The built-in probes only prove the app still starts and renders. To test what the
   change actually does, you must author a script aimed at it:
   `ebb scenario` → `ebb explore` → edit → `ebb play`. The full method is in
   `process/knowledge/scenario-authoring.md`. This is the part of the job that
   requires judgement, and it is the difference between a real test and a smoke test.

5. **Test it** — base revision and head revision, side by side, with your script.

6. **Deliver a report** (`runs/<runId>/report.md`) and state the verdict in one line.
   If you did not write a script, say so plainly; the report will carry a coverage
   caveat and you must not present it as a clean bill of health.
   Then **translate it into Chinese**: write `runs/<runId>/report.zh-CN.md`, a full
   Chinese rendering of the same report, and deliver both files.

7. **Record only what qualifies** (§5) — a change to the architecture, something the
   human asked to be remembered, or knowledge that cannot be inferred from the run.
   Most runs qualify for nothing, and that is the normal outcome.

---

## 2. The exact wording to use when asking

Ask once, with both options visible. Chinese and English, because the human may
prefer either:

```
要测试哪个改动？请二选一：
  1) Pull Request 编号，例如 85
  2) 一段 git commit 范围，例如 v1.2.0..v1.3.0 或 abc123..def456

Which change should I test? Pick one:
  1) A pull request number, e.g. 85
  2) A git commit range, e.g. v1.2.0..v1.3.0 or abc123..def456
```

Ask at most one follow-up: whether they want **both revisions compared** (default,
slower, finds regressions) or **only the head revision** (faster, finds absolute
breakage but cannot prove a regression).

---

## 3. Commands

All commands are non-interactive. Run them from the repository root.

```bash
# 1. Can this host clone, build and launch Electron at all?
node harness/bin/ebb.mjs doctor --smoke

# 2. Resolve the change set (fast; no build). Shows the diff and risk triage.
node harness/bin/ebb.mjs acquire --repo <url> --pr 85
node harness/bin/ebb.mjs acquire --repo <url> --range v1.2.0..v1.3.0

# 3. Run it. Without --scenario this is only a smoke test.
node harness/bin/ebb.mjs run --repo <url> --pr 85
node harness/bin/ebb.mjs run --repo <url> --range v1.2.0..v1.3.0

# A repository already on disk (no clone): give its path instead of a URL.
node harness/bin/ebb.mjs acquire --repo-dir <path> --range v1.2.0..v1.3.0
node harness/bin/ebb.mjs run     --repo-dir <path> --range v1.2.0..v1.3.0   # differential
node harness/bin/ebb.mjs run     --repo-dir <path>                           # working tree, single-sided

# 4. Author a test script for THIS change (method: process/knowledge/scenario-authoring.md).
node harness/bin/ebb.mjs scenario <runId>              # scaffold aimed at the diff
node harness/bin/ebb.mjs explore  <runId> --side head  # map real selectors + IPC channels
#    ...edit projects/<owner>__<repo>/scenarios/<file>.json...
node harness/bin/ebb.mjs play <runId> --scenario <file>              # iterate in seconds
node harness/bin/ebb.mjs play <runId> --side base --scenario <file>  # same script, base
node harness/bin/ebb.mjs run --repo <url> --pr 85 --scenario <file>  # final, scripted run

# 5. Housekeeping.
node harness/bin/ebb.mjs runs                  # history
node harness/bin/ebb.mjs selfcheck             # validate the harness itself
```

Reports land in `runs/<runId>/report.md` (human, English) and
`runs/<runId>/report.json` (machine). After a run, also write
`runs/<runId>/report.zh-CN.md` — a Chinese translation of `report.md` — so every
result is delivered in both languages. Translate headings, labels, table headers and
prose; keep verdict tokens, status codes, side labels (`base`/`head`), metric names,
paths, commands, URLs and other identifiers verbatim. Exit code is `1` for
`REGRESSION`/`FAIL`, and for a failing `ebb play`.

---

## 4. How to read the verdict

| Verdict | Meaning | What to tell the human |
|---|---|---|
| `NO_REGRESSION` | Both revisions ran; nothing got worse | "No regression detected in the probed surfaces." |
| `CHANGED` | Both ran; observable behaviour differs | Show the metric deltas; some may be intended. |
| `REGRESSION` | Head is worse than base on at least one probe | Lead with this. Link the evidence. |
| `PASS` / `WARN` / `FAIL` | Single-sided run (`--only head`) | Report absolute findings. |
| `INCONCLUSIVE` | The head revision never ran | **Not a pass.** Investigate the launch section. |

Section 4 of every report states whether the run used a script written for the change
or only the generated smoke script. If it says the latter, the verdict does not cover
the change — say so.

**Never present `INCONCLUSIVE` as a pass.** If the app could not be launched, the
launch evidence is the result and you must say so plainly.

---

## 5. Evolving this process

The process is meant to be improved by the agent using it — but it is an **operating
procedure, not a catalogue of everything that can go wrong.** It records how to run the
process, plus the few facts that cannot be worked out from a run itself. Every line is
read on every future run, so anything else is a cost with no return.

Add to the framework only when one of these holds:

1. the architecture needs adjusting;
2. the human explicitly asks for something to be recorded;
3. it is knowledge that cannot reasonably be inferred from the run output, the logs or
   the source — and the next run would otherwise pay the same cost to rediscover it.

If none of the three holds, record nothing. A run whose only outcome is a test result
changes no framework file and does not bump `process/VERSION`.

When a change does qualify, it goes where its kind belongs:

| The change | Where it goes |
|---|---|
| The pipeline's shape, the harness code, the CLI | `harness/`, then `ebb selfcheck` |
| A host fact that cannot be inferred — a mandatory flag, a proxy, a filesystem boundary | `process/knowledge/environment.md` |
| An Electron behaviour that cannot be inferred and changes what is observable | `process/knowledge/electron-blackbox.md` |
| A way to write a better test script | `process/knowledge/scenario-authoring.md` |
| A build/launch failure whose cause is *not* the repository under test | `process/knowledge/failure-modes.md` |
| A script that works for **any** Electron app | `harness/scenarios/` |
| Anything true of **one** application — routes, selectors, channels, preconditions, pre-existing noise | `projects/<owner>__<repo>/NOTES.md` |
| A test script for **one** application | `projects/<owner>__<repo>/scenarios/` |

**Bump `process/VERSION` and add a `process/CHANGELOG.md` entry only for a framework
change** — harness code, a generic `harness/scenarios/` script, or a
`process/knowledge/` change. A project record stops at `projects/<owner>__<repo>/`: no
VERSION bump, no CHANGELOG entry, no `process/knowledge/` change. A change that is
readily inferable, or that merely describes a revision's current state, is not worth
recording anywhere in the framework — prefer the specific over the general, and the
non-inferable over the merely observed.

Rules for evolving safely:
- **Never weaken a probe to make a run pass.** Fix the probe or record the limitation.
- **Keep project-specific material out of the framework.** Anything that names one
  app's routes, selectors, dialogs, channels or reply strings belongs under
  `projects/<owner>__<repo>/`, never in `process/knowledge/`, `harness/scenarios/`, or
  the `process/CHANGELOG.md` / `process/VERSION` evolution record. A commit hash, a PR
  number or an app name in the CHANGELOG is a leak. The framework must stay usable for
  the next repository. `ebb selfcheck` enforces this.
- **Do not add dependencies beyond `playwright-core`.** The harness must still *work*
  when `node_modules` is absent: everything except the Playwright driver keeps
  running, and `ebb doctor` / `ebb acquire` / `ebb selfcheck` report that the driver
  is missing rather than crashing. Adding a second dependency erodes that.
- **Keep both drivers in step.** `ebb selfcheck` asserts that the Playwright driver
  and the DevTools Protocol fallback expose the same page methods; a probe must never
  silently depend on Playwright-only behaviour.
- **Re-run the previous case after a harness change** to confirm you did not regress
  the process itself.

Verify with:

```bash
node harness/bin/ebb.mjs selfcheck
```

---

## 6. Boundaries

- This process **observes** the app; it does not change application behaviour. It
  never edits application source.
- The **only** permitted modification to the repository under test is a *declared
  build adaptation* (`harness/src/adapt.mjs`), applied inside the run's disposable
  worktree to make the app observable at all — re-enabling the Node inspector that
  Playwright attaches to, which a packaging fuse otherwise removes. The cached clone and the user's repository
  are never touched, the change is written to `adaptations-<side>.diff`, and every
  report that used one says so in a dedicated section. Pass `--no-adapt` to test the
  repository's shipped packaging configuration instead — and expect Playwright to be
  unable to attach, in which case the run falls back to the CDP driver.
- It runs the real Electron binary. A change that only fails in a *packaged*,
  code-signed, auto-updating production build may not be visible here; say so in
  the report's limitations rather than implying full coverage.
- It cannot judge intent. A behavioural change may be exactly what the PR wanted.
  Report the delta and let the human decide.
