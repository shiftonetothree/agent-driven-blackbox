# Electron black-box technique

What can actually be observed about an Electron app from the outside, and which
observations are worth trusting.

---

## The two observation channels

Electron exposes its renderer and its main process through separate channels. Use both.

| Channel | How | Gives you |
|---|---|---|
| Renderer | Playwright `electronApp.firstWindow()` → `page` | DOM, console, network, screenshots, **real user input** with auto-waiting |
| Main process | Playwright `electronApp.evaluate(({ app, BrowserWindow }) => …)` | Window list, security preferences, app paths, engine versions |
| Renderer (fallback) | `--remote-debugging-port=<p>` + `/json/list` + CDP over WebSocket | The same DOM/console/network/screenshot surface, without actionability checks |
| Main process (fallback) | `--inspect=<p>` + V8 inspector | The same main-process state, via a `require('electron')` shim |

The harness implements the first two as the *Playwright driver* and the last two as
the *CDP driver*, behind one page interface. Reaching the main process this way is
what makes Electron-specific assertions possible **without patching the app** — no
preload injection, no test hooks, no source changes. That is what keeps the test
honest as a black-box test.

Whether Playwright or the fallback did the work is recorded in the report
(`windows.metrics.driver` and `scenario.metrics.usedRealInput`), so a reader always
knows how much to trust an interaction result.

`--inspect` (not `--inspect-brk`) matters for the fallback: the app must not pause at
startup.

---

## What is worth asserting

Ordered by how often it has actually caught something.

1. **Did a window ever appear, and how long did it take?** The single most common
   real regression. `windows` probe.
2. **Uncaught exceptions and console errors.** Cheap, high signal. Compare the
   *count* between revisions: 0 → 3 is a regression even if the app still looks fine.
3. **Blank or half-rendered surfaces.** Tiny screenshot **and** no DOM text. Neither
   signal alone is trustworthy.
4. **Failed network requests.** Catches a moved endpoint, a broken asset path, a CORS
   regression, an offline-mode mistake.
5. **Window security preferences drift.** `contextIsolation: false` or
   `nodeIntegration: true` appearing in a diff-adjacent window is a security
   regression that no UI test would notice.
6. **Reload stability.** A renderer that works once but throws on reload hides a
   missing-cleanup bug.
7. **Main-process versions and app metadata.** Confirms the build under test is
   actually the revision you think it is.

---

## Traps

**The default user-data directory is shared state.** Every run gets its own
`--user-data-dir`. Without this, the second run inherits the first run's profile and the
two revisions are not comparable — quite apart from crashing outright on this host.

**Dev-server builds are not what ships.** `electron-forge start` / `vite dev` serve
the renderer over HTTP with hot reload. The packaged app loads from `file://`. Some
regressions (asset paths, `base` URLs, CSP, `file://` fetch restrictions) exist only
in the packaged form. Prefer the packaged adapter; when you cannot, say so in the
report's limitations.

**Renderer crashes are not process exits.** `render-process-gone` can leave the
main process alive. Only the main-process channel sees this.

**Screenshots are not a diffing tool.** Antialiasing, font fallback and animation
phase make pixel comparison flaky. Compare *structural* facts (DOM fingerprint, text
hash, element counts) and use screenshots as human-readable evidence. The probe
records SHA-1s so a human can tell whether two runs were visually identical, but no
verdict depends on pixel equality.

**`app.commandLine.appendSwitch` can override your flags.** If the app forces
`--disable-gpu` or rewrites argv, flags passed on the command line may lose. Check
`main-process` → `commandLineSwitches` in the report before concluding a flag did
nothing.

**`requestSingleInstanceLock()` is scoped to the user-data directory, not the machine.**
This is easy to get backwards, and it matters twice over:

- A black-box harness gives each run its own `--user-data-dir` for isolation. That also
  gives each run its own single-instance *namespace*, so **the lock does not stop two
  test instances from running at once**. Measured: an app holding the lock still put
  two windows on screen when launched with two different `--user-data-dir` values.
- Therefore the lock cannot be relied on to enforce exclusivity for you, and it must be
  treated as a *signal* instead: an app that takes the lock assumes it is alone on the
  machine, and very likely owns OS-level state — tray icon, global shortcuts, file
  associations, protocol handlers, a shared config file — that two overlapping runs
  would contend for.

The harness reads `app.hasSingleInstanceLock()` from the live main process and refuses
to exercise two revisions concurrently when it is true. See
`harness/src/sideeffects.mjs` and `process/PROCESS.md`.

**"Two windows appeared" and "the app holds a single-instance lock" are both true, and
not a contradiction.** Reach for the second explanation before assuming the app ignores
its own lock.

**A clean console is not a pass.** Many Electron apps swallow errors. Absence of
console output is weak evidence; the window inventory, DOM fingerprint and
scenario assertions carry the weight.

**`electronApp.evaluate` is handed the electron module, not a blank context.** The
callback receives `{ app, BrowserWindow, ipcMain, … }` as its first argument, so use
those bindings; `require` is *not* defined there. The CDP driver shims
`require('electron')` internally so the same callback shape works on both drivers.

**Playwright cannot launch a dev-server script.** If the app is started by
`electron-forge start` / `vite dev`, Playwright has no Electron executable to own.
That is a driver-selection problem, not a test failure — the harness routes
dev-script adapters to the CDP driver, which spawns the script and attaches instead.
Prefer a packaged adapter so Playwright can drive the app directly.

**Electron fuses can make a packaged app unobservable — and it looks like a hang.**
Electron Forge's `FusesPlugin` defaults to `EnableNodeCliInspectArguments: false`.
That is a *good* production default: it stops anyone attaching a debugger to a
shipped app. But it also removes the main-process Node inspector, which is precisely
the channel Playwright's `_electron.launch` uses. The symptom is nasty because it
does not look like a permissions or configuration problem:

- the packaged app starts perfectly, renders a real window, and behaves normally;
- `_electron.launch` simply never settles, and only fails at its timeout;
- nothing is printed by the app, because nothing is wrong with the app.

Diagnose it by checking whether the inspector endpoint is reachable when you pass
`--inspect` yourself (the harness does this: `main-process` probe reports
`skip`, and the run's attempts show `launch-failed: … Timeout`). Then either:

- apply a **declared build adaptation** to re-enable the fuse (what the harness does
  by default — see `harness/src/adapt.mjs`), which gives the full Playwright API; or
- drive the app over `chromium.connectOverCDP` instead, which needs only
  `--remote-debugging-port` and works regardless of the fuses (the harness's middle
  rung); or
- accept the CDP fallback and lose actionability checks and main-process access.

Electron's `--inspect` is a no-op in a packaged build when that fuse is off, so
"pass `--inspect` and hope" is not a workaround.

---

## Scenario authoring

Scenarios are the extension point for repo-specific coverage, and the only way to test
what a change actually *does*. The method — the authoring loop, the action reference, the
one-script-per-question rule and the common mistakes — lives in `scenario-authoring.md`.
Nothing about it is Electron-specific, except that `explore` also reports the app's
registered IPC channels and application menu, which is often exactly where the change is.

---

## Triage heuristics

The harness maps changed paths to risk areas (`harness/src/analyze.mjs`). Treat the
mapping as a prompt for your own judgement, not a verdict:

- `preload`/`bridge`/`contextBridge` → the renderer↔main contract; breakage shows up
  as a runtime exception, so the `console` probe is the fastest signal.
- `main`/`app`/`background` → startup and window lifecycle; watch time-to-ready.
- `ipc`/`channel`/`invoke` → both sides must be exercised; generic probes rarely
  cover it, so write a scenario.
- `forge.config`/`webpack`/`vite.config` → affects what ships; only the packaged
  adapter will see it.
- `.tsx`/`.css`/`.scss` → visual; screenshot plus DOM fingerprint.
- lockfiles → dependency drift; compare main-process versions and console output.
