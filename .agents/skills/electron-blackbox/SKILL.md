---
name: electron-blackbox
description: Black-box test an Electron application for a pull request or commit range. Use when asked to test, verify, review or regression-check an Electron/desktop app change, when given a repository URL plus a PR number or commit range, or when asked whether a change broke the app at runtime. Builds both revisions, launches the real Electron binary, observes it over the DevTools Protocol, and writes a verdict report.
whenToUse: The user gives a repository URL for an Electron app and asks to test a PR or a range of commits; or asks whether a change broke runtime behaviour, startup, windows, UI, IPC or packaging.
---

# Electron black-box test operator

This directory **is** the test process. Nothing here depends on a particular agent
framework: the whole process is three shell commands, and this file is only guidance
for whichever agent is driving them.

All paths below are relative to this directory (the one containing `AGENTS.md`).

## Do this, in this order

1. **Ask what to test — never guess.** Use whatever question tool the framework
   provides, or just ask in the reply:

   ```
   要测试哪个改动？请二选一：
     1) Pull Request 编号，例如 85
     2) 一段 git commit 范围，例如 v1.2.0..v1.3.0 或 abc123..def456

   Which change should I test? Pick one:
     1) A pull request number, e.g. 85
     2) A git commit range, e.g. v1.2.0..v1.3.0 or abc123..def456
   ```

   Then, once, ask whether to compare against the base revision (finds regressions)
   or test only the head revision (about twice as fast). Nothing else needs asking.

2. **Capability check, before any blame.**
   `node harness/bin/ebb.mjs doctor --smoke`
   A `FAIL` here means the *host* cannot test Electron. Stop and report that — never
   turn an environment failure into a finding about the repository.

3. **Resolve the change cheaply, then show it.**
   `node harness/bin/ebb.mjs acquire --repo <url> --pr <n>`
   (or `--range <A..B>`). Confirm the base branch and diff size before spending
   minutes on builds.

4. **Write a test script for this change — do not skip this.**
   The built-in probes only prove the app still starts and renders. Testing what the
   change *does* requires a script aimed at it:

   ```bash
   node harness/bin/ebb.mjs scenario <runId>              # scaffold aimed at the diff
   node harness/bin/ebb.mjs explore  <runId> --side head  # map real selectors + IPC channels
   #   ...edit projects/<owner>__<repo>/scenarios/<file>.json...
   node harness/bin/ebb.mjs play <runId> --scenario <file>            # iterate in seconds
   node harness/bin/ebb.mjs play <runId> --side base --scenario <file>
   ```

   `explore` first, always — it reports the app's durable selectors, open dialogs,
   routes and IPC channels, so you never invent a selector. Full method:
   `process/knowledge/scenario-authoring.md`.

5. **Run it differentially.**
   `node harness/bin/ebb.mjs run --repo <url> --pr <n> --scenario projects/<owner>__<repo>/scenarios/<file>.json`
   Without `--scenario` this is a smoke test, and the report will say so.

6. **Report** `runs/<runId>/report.md`, leading with the verdict. `INCONCLUSIVE` is
   not a pass — say so plainly and attach the launch evidence. If no script was
   written, say that too; the report carries a coverage caveat. Then write
   `runs/<runId>/report.zh-CN.md`, a Chinese translation of the same report, and
   deliver both.

7. **Evolve the process.** Record anything new (environment quirk, failure mode,
   technique, authoring lesson) under `process/knowledge/`, bump `process/VERSION`,
   add a `process/CHANGELOG.md` entry, and run `node harness/bin/ebb.mjs selfcheck`
   until it is green.

## Using this from any agent framework

- **Any tool that can run a shell command can use this process.** No SDK, no MCP
  server, no framework plugin is required. `node harness/bin/ebb.mjs <command>`.
- **Non-interactive and machine-readable.** `--json` where it helps; a report is
  always written to `runs/<runId>/report.json` as well as `report.md`.
- **Gateable.** Exit code `1` means regression or failure.
- **Instruction files.** `AGENTS.md` is the canonical entry point (read by most
  coding agents); `CLAUDE.md` points at it for Claude Code; `.agents/skills/` and
  `AGENTS.md` between them cover tools that discover skills from a directory.
  If your framework uses something else, point it at `AGENTS.md` — that is the whole
  contract.

## Rules

- **Write the script.** A verdict from the generated smoke script does not cover the
  change, and the report says so. Do not present it as a clean result.
- Never report a run as passing when a revision never launched, or when no probe ran.
- Never weaken a probe to make a run pass. Fix it or record the limitation.
- Never invent a selector. Run `explore` against the live app first.
- **Keep project-specific material out of the framework.** Scripts and notes that name
  one app's routes, selectors or dialogs belong under `projects/<owner>__<repo>/`, never
  in `harness/scenarios/` or `process/knowledge/`. `ebb selfcheck` enforces this.
- Never edit application source. The single permitted change is a *declared build
  adaptation* (`harness/src/adapt.mjs`) applied inside the run's disposable worktree
  so the packaged app can be observed at all — recorded in `adaptations-<side>.diff`
  and stated in every report that uses one. `--no-adapt` disables it.
- Always state what was **not** tested (skipped probes, dev-server instead of the
  packaged artifact, one side only, adapted packaging, no change-specific script).
- The harness depends on `playwright-core` and nothing else, on purpose. Everything
  except the Playwright driver still works when `node_modules` is absent.

## Read next

- `process/PROCESS.md` — the detailed playbook and the reasoning behind each step.
- `process/knowledge/scenario-authoring.md` — how to write the script. Read this
  before authoring.
- `process/knowledge/environment.md` — mandatory launch flags, proxy and TLS setup.
  Read this before debugging any launch failure.
- `process/knowledge/failure-modes.md` — symptom → diagnosis → remedy.
- `process/knowledge/electron-blackbox.md` — what is observable from outside Electron,
  and which observations are trustworthy.
- `projects/<owner>__<repo>/NOTES.md` — this app's quirks, selectors and pre-existing
  noise. Read it before writing a script for a repository already tested.
