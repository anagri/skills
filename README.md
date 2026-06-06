# skills

Personal collection of [Agent Skills](https://docs.claude.com/en/docs/claude-code/skills)
for Claude Code.

Each skill lives in its own directory with a `SKILL.md` (the entry point) plus
any bundled `references/`, `scripts/`, or `assets/`.

## Skills

| Skill | What it does |
|-------|--------------|
| [`comments-cleanup`](comments-cleanup/) | Sweep a codebase and remove comment noise while preserving the comments that earn their place (quirks, findings, non-obvious constraints, tooling directives). Reads the project's own comment policy and lets it override built-in defaults; fans out a parallel Workflow for large sweeps. |

## Installing

Skills are discovered from a few locations. Pick whichever fits:

- **Per-project:** copy or symlink a skill dir into the project's `.claude/skills/`.
- **User-wide:** copy or symlink into `~/.claude/skills/`.
- **As a plugin:** point a marketplace/plugin config at this repo.

For example, to make every skill here available user-wide:

```bash
ln -s "$(pwd)/comments-cleanup" ~/.claude/skills/comments-cleanup
```

Claude consults a skill based on its `description`, so you don't invoke it
manually — just describe the task (e.g. "clean up the redundant comments across
`src/`") and the relevant skill triggers.
