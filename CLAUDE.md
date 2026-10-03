# CLAUDE.md

This project's agent instructions live in **[AGENTS.md](./AGENTS.md)** — read that first.
It is the single canonical entry point: the procedure and its order, the full command
list, the verdict semantics, and the rules for evolving the process. It is kept
framework-neutral on purpose, so the same process works from Claude Code, Codex, Cursor,
DSH or anything else that can run a shell command.

Nothing in this project is Claude-specific, and this file deliberately carries no
guidance of its own — two copies of a procedure is how they drift apart.

Also discoverable as the skill `.agents/skills/electron-blackbox/SKILL.md`.
