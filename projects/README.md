# projects/ — per-repository test material

Everything here belongs to **one** repository. Nothing here is part of the framework.

```
projects/
  <owner>__<repo>/
    NOTES.md              What was learned about this app: launch quirks, selectors,
                          pre-existing noise, what is not covered.
    scenarios/*.json      Test scripts written for this app's actual UI.
```

## The rule

| | |
|---|---|
| **`harness/scenarios/`** | Scripts that work against *any* Electron app. Framework-owned. Keep it tiny — a generic smoke test and not much else. |
| **`projects/<slug>/scenarios/`** | Scripts that know *this* app's routes, selectors, dialogs and IPC channels. Meaningless anywhere else. |

If a script would need editing before it could run against a different application, it
belongs here, not in the harness.

## Why keep them at all

They are the reusable evidence for future changes to the same app: `pr85-targeted.json`
still asserts the same feature after the next release, and the pre-existing-noise list
stops the next run from re-reporting known problems as new ones.

## How a script gets here

`ebb scenario <runId>` writes to this folder by default, deriving the slug from the
run's change set. `--out <path>` overrides it; `--global` deliberately writes into
`harness/scenarios/` instead, and warns you that it did.

```bash
node harness/bin/ebb.mjs scenario <runId>                    # -> projects/<slug>/scenarios/<runId>.json
node harness/bin/ebb.mjs explore  <runId> --side head        # map real selectors first
node harness/bin/ebb.mjs play     <runId> --scenario projects/<slug>/scenarios/<file>.json
node harness/bin/ebb.mjs run --repo <url> --pr <n> --scenario projects/<slug>/scenarios/<file>.json
```
