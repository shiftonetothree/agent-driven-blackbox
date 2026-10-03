# Writing a test script for a specific change

The generic probes answer one question: *does the app still start, render and stay
quiet?* They cannot answer the question a reviewer actually has: *does this change
work?* That requires a script written against the change.

**This step is mandatory, not optional.** A `NO_REGRESSION` verdict from the generated
smoke script is weak evidence, and the report says so in a coverage caveat so nobody
mistakes one for the other.

---

## Where scripts live

| | |
|---|---|
| `harness/scenarios/` | App-agnostic. Works against any Electron app. Framework-owned; keep it tiny. |
| `projects/<owner>__<repo>/scenarios/` | Knows *this* app's routes, selectors, dialogs and IPC. Written on the spot; meaningless anywhere else. |

`ebb scenario <runId>` writes to the project folder by default. `--global` writes into
the harness and warns you. `ebb selfcheck` fails if a repository-specific-looking
script appears in `harness/scenarios/`.

If a script would need editing before it could run against a different app, it belongs
under `projects/`.

---

## The loop

```bash
ebb run     --repo <url> --pr 85            # build both revisions, generic probes
ebb scenario <runId>                        # scaffold aimed at this diff's risk areas
ebb explore  <runId> --side head            # what the app ACTUALLY exposes
#   ...edit the script...
ebb play     <runId> --scenario <file>      # seconds per attempt
ebb play     <runId> --side base --scenario <file>   # same script, base revision
ebb run      --repo <url> --pr 85 --scenario <file>  # final differential run
```

`explore` and `play` reuse the packaged build a previous run already produced, so the
whole loop above costs seconds per turn instead of minutes.

---

## Step 1 — look before writing

**Never invent a selector.** Run `ebb explore` first. It reports, from the live app:
durable selectors (`data-testid`, `id`, stable attributes) separated from fragile
structural paths, headings and landmarks, forms, dialogs open right now, reachable
routes, and — for Electron specifically — every registered IPC channel and the
application menu.

Two things this reliably catches that a hand-written script does not:

- **A blocking first-run modal.** A fresh profile often opens a welcome or onboarding
  dialog over everything, and the generic probes then report a healthy page that is
  entirely modal text. Every scenario has to dismiss it before it can measure anything.
- **The real API surface.** `explore` lists the IPC channels the app actually registers
  — including the one the change just added, which a guessed name would never have hit.

## Step 2 — pick the load-bearing assertion

Ask: *what must be true if this change works, and false if it does not?* Prefer
something a differential can decide:

| Change touches | Strong assertion |
|---|---|
| A new preload/bridge method | `assertEval` that its `typeof` is `function` |
| A new IPC channel | presence in the main process's channel list |
| A new route or page | navigate there; `assertSelector` for its container; `assertText` for distinctive copy |
| A changed API response | `eval` the call and `assertEval` on the shape |
| A UI change | `waitForSelector` the new element, then `assertText` |
| A fixed bug | assert the *absence* of the old symptom |

Assert on **observable consequences**, not on "the page did not crash". A script that
only checks `body` exists will pass on a completely broken feature.

## Step 3 — one script per question

**The most important authoring rule.** A blocker assertion that the new API exists
*fails on the base revision by design*, and a failing non-optional step stops the
script. Everything after it is skipped, so one script cannot both prove the feature
exists and compare downstream behaviour.

Split them:

- **The feature test** asserts that the new API exists, and nothing else. It fails on
  base by design, so the differential classifies it `FIXED` — which is itself a result:
  it proves the change delivers what it claims.
- **The health test** asserts nothing about the feature, so it completes on both
  revisions and can be compared. Anything the feature disturbed shows up here.

The split is what separates a regression from pre-existing noise. A single-sided run
attributes every console error on the changed page to the change; only a both-sides
health test can show the errors were already there.

## Step 4 — iterate with `play`

`ebb play` runs only the console and scenario probes against one revision and prints
each step: `PASS` with its value, `FAIL` with the error, and `SKIP` for everything the
failure prevented from running. Edit, play, repeat.

It exits non-zero when the script fails, so it is also usable as a quick gate.

## Step 5 — run it differentially

```bash
ebb run --repo <url> --pr <n> --scenario projects/<slug>/scenarios/<file>.json
```

The report then shows the script under **section 4**, per-step results per side, and
the scenario probe classified like any other — `FIXED`, `REGRESSION`, `CHANGED`. The
coverage caveat disappears, because the run now actually tested something.

---

## Sandboxing external state with `--env`

The side-effect assessment (see `PROCESS.md`) decides whether two runs may overlap. It
does not make a side-effecting feature *testable* — for that you need somewhere safe
for it to act on.

Many Electron features are file-based: they read a config, back it up, and write a new
one. Point them at your real profile and the test modifies your machine; point them at
nothing and you are not testing the feature.

`--env KEY=VALUE` (repeatable) sets environment variables on the launched application:

```bash
node harness/bin/ebb.mjs run --repo <url> --pr <n> \
  --env USERPROFILE=projects/<slug>/fixtures/<fixture-name> \
  --env <APP_SPECIFIC_DIR>=projects/<slug>/fixtures/<fixture-name>
```

The app now reads and writes inside the fixture tree, so the real read / backup / write
code runs against disposable files. `--env` works on `run`, `explore` and `play`.

Keep hand-authored inputs in `projects/<slug>/fixtures/` and gitignore everything the
app writes there — a redirected `USERPROFILE` also collects Chromium and GPU caches,
which are byproducts rather than fixtures. See that directory's `README.md`.

Every run that used `--env` records it in the report's launch notes and in the
reproduce command, because a reader reproducing it has to recreate the sandbox first.

---

## Actions

| Action | Fields | Notes |
|---|---|---|
| `wait` | `ms` | Settle time |
| `waitForSelector` | `selector`, `timeout` | Waits for visible; fails on timeout |
| `click` | `selector`, `timeout` | Real Playwright click; scrolls into view, actionability-checked |
| `type` / `fill` | `selector`, `text` | Fires `input` **and** `change`, so React/Vue state updates |
| `press` | `selector`, `key` | Keyboard events on the focused element |
| `eval` | `expression` | Records the value; never fails. Use for discovery and comparison |
| `assertEval` | `expression`, `equals` \| `notEquals` \| `contains` \| `matches` | **Assertion form of `eval`** — this is what turns "the feature is present" into a pass/fail |
| `assertText` | `selector`, `contains` \| `matches` | Text assertion |
| `assertSelector` | `selector` | Present in the DOM |
| `assertVisible` | `selector` | Present *and* visible |
| `assertNoConsoleErrors` / `assertNoPageErrors` | — | Fails on anything logged so far |
| `screenshot` | `name` | Written into the run's artifacts |

Every step accepts `severity` (`blocker` / `major` / `minor`) and `optional: true`. A
failing non-optional step stops the script; the failure is the finding.

Use `$comment` on a step to record *why* it is there. The scaffold uses this, and it is
what makes a script reviewable months later.

---

## Judging a selector

Prefer, in order: `data-testid` → `id` → a stable attribute (`name`, `aria-label`,
`href`) → text content (`button:has-text('…')`) → structural path. `ebb explore` marks
the first three as durable and lists the rest separately as fragile, because a
`:nth-of-type` chain breaks the moment someone reorders a layout.

`click` uses Playwright, so actionability checks and auto-waiting apply. When the
*timing* is the thing under test, assert on DOM state directly instead — auto-waiting
can make a late success look like an on-time one.

---

## Common mistakes

- **Guessing selectors.** Run `explore` first.
- **Forgetting the startup modal.** It silently becomes the thing you are measuring.
- **Only asserting the app did not crash.** It proves nothing about the change.
- **One script for every question.** A blocker that fails on base skips the rest.
- **Asserting on raw text hashes** when the app renders a version or revision string —
  it will differ for reasons unrelated to the change.
- **Leaving the script in `harness/scenarios/`.** Run `ebb selfcheck`; it checks.
- **Recording a step as `eval` when you meant to assert.** Use `assertEval`.
