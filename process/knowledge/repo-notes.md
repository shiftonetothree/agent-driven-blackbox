# Repository notes

**This file is an index, not a store.** Per-repository findings live with the
repository they describe, under `projects/<owner>__<repo>/NOTES.md`.

## Why they are not kept here

Anything that names a route, a selector, a dialog or an IPC channel belongs to one
application and is meaningless for any other. Keeping it in `process/knowledge/`
would slowly turn the framework into a pile of one project's trivia — the same reason
project-specific *scripts* live in `projects/` rather than `harness/scenarios/`.

`process/knowledge/` holds only what is true of Electron, of Windows, or of this
host — things the next repository will need too.

## The rule

| Kind of knowledge | Where it goes |
|---|---|
| True of any Electron app | `process/knowledge/electron-blackbox.md` |
| True of this host (flags, proxy, TLS, caches) | `process/knowledge/environment.md` |
| A failure mode and its fix | `process/knowledge/failure-modes.md` |
| True of one application | `projects/<owner>__<repo>/NOTES.md` |
| A test script for one application | `projects/<owner>__<repo>/scenarios/` |
| A test script for any application | `harness/scenarios/` |

## Where per-repository findings live

Each tested repository gets its own notes at `projects/<owner>__<repo>/NOTES.md`
(next to its scenarios). That directory is **not committed**: this repo is generic, so
anything that names one application is kept out of the framework. `projects/` is
gitignored; `projects/README.md` documents the convention.

The `NOTES.md` template:

```
- Toolchain / package manager:
- Adapter used (and why not the default):
- Launch quirks (extra flags, env, startup dialogs):
- Selector vocabulary / entry points:
- Pre-existing noise on both revisions:
- Not covered (and why):
```
