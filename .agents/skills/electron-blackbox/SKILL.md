---
name: electron-blackbox
description: Black-box test an Electron application for a pull request or commit range. Use when asked to test, verify, review or regression-check an Electron/desktop app change, when given a repository URL plus a PR number or commit range, or when asked whether a change broke the app at runtime. Builds both revisions, launches the real Electron binary, observes it over the DevTools Protocol, and writes a verdict report.
whenToUse: The user gives a repository URL or a path to a local checkout of an Electron app and asks to test a PR or a range of commits; or asks whether a change broke runtime behaviour, startup, windows, UI, IPC or packaging.
---

# Electron black-box test operator

This directory **is** the test process. Nothing here depends on a particular agent
framework: the whole process is a handful of shell commands.

**`AGENTS.md` is the contract — read it first.** It carries the procedure and its order,
the commands, the verdict semantics, and the rules for evolving the process. This file
adds only what is specific to arriving here through skill discovery, so it deliberately
does not restate any of that.

All paths are relative to this directory (the one containing `AGENTS.md`).

## The four things an operator gets wrong

- **A `FAIL` from `doctor --smoke` is about the host, not the app.** The host cannot test
  Electron. Stop and report that; never turn an environment failure into a finding about
  the repository under test.
- **`explore` before writing any selector.** It reports the app's real durable selectors,
  open dialogs, routes and IPC channels, so nothing has to be invented.
- **`INCONCLUSIVE` is not a pass.** If a revision never launched, the launch evidence is
  the result — say so plainly rather than implying coverage.
- **Every report ships in two languages.** `runs/<runId>/report.md`, then
  `runs/<runId>/report.zh-CN.md`, a full rendering of the same report — headings, labels
  and prose translated, identifiers left verbatim.

## Using this from any agent framework

- **Any tool that can run a shell command can use this process.** No SDK, no MCP server,
  no framework plugin is required. `node harness/bin/ebb.mjs <command>`.
- **Non-interactive and machine-readable.** `--json` where it helps; a report is always
  written to `runs/<runId>/report.json` as well as `report.md`.
- **Gateable.** Exit code `1` means regression or failure.
- **Entry points.** `AGENTS.md` is canonical (the convention most coding agents read);
  `CLAUDE.md` points at it for Claude Code. For any other framework, point it at
  `AGENTS.md` — that is the whole contract, and adding a pointer is a one-line file.

## Read next

- `AGENTS.md` — the contract: procedure, commands, verdicts, how to evolve the process.
- `process/PROCESS.md` — the detailed playbook and the reasoning behind each step.
- `process/knowledge/scenario-authoring.md` — how to write the test script. Read before
  authoring.
- `process/knowledge/environment.md` — mandatory launch flags, proxy and TLS setup. Read
  before debugging any launch failure.
- `process/knowledge/electron-blackbox.md` — what is observable from outside Electron,
  and which observations are trustworthy.
- `process/knowledge/failure-modes.md` — a build or launch failure that is not the
  repository's fault.
- `projects/<owner>__<repo>/NOTES.md` — this app's quirks, selectors and pre-existing
  noise. Read before scripting against a repository that was tested before.
