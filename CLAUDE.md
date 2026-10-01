# CLAUDE.md

This project's agent instructions live in **[AGENTS.md](./AGENTS.md)** — read that
first. It is the single canonical entry point, kept framework-neutral on purpose so
the same process works from Claude Code, Codex, Cursor, DSH or anything else that
can run a shell command.

Nothing here is Claude-specific. The short version:

```bash
node harness/bin/ebb.mjs doctor --smoke                       # can this host test Electron?
node harness/bin/ebb.mjs acquire --repo <url> --pr 85         # what exactly changed?
node harness/bin/ebb.mjs run     --repo <url> --pr 85         # test it, write the report
```

Ask the human which **pull request** or **commit range** to test before starting;
never guess. Then read `runs/<runId>/report.md` and lead with the verdict.

Also discoverable as the skill `.agents/skills/electron-blackbox/SKILL.md`.
