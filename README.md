# skills

Personal collection of [Agent Skills](https://docs.claude.com/en/docs/claude-code/skills)
for Claude Code.

Each skill lives in its own directory with a `SKILL.md` (the entry point) plus
any bundled `references/`, `scripts/`, or `assets/`.

## Skills

| Skill | What it does |
|-------|--------------|
| [`retrospective`](retrospective/) | Run an evidence-first retrospective over a date window on a solo, agent-assisted project. Collects git, prompt history, CI and plans deterministically (counts in the script, never in a model), fans out extraction agents, consolidates, then interviews you against the record. Commands: `/retrospective:setup`, `/retrospective:retro`, `/retrospective:method`. |
| [`cloudflare-platform-architecture`](cloudflare-platform-architecture/) | Architecture and project organization for complex Cloudflare apps in a pnpm/turbo monorepo — multiple Workers, SPA+API apps, Queues, Workflows, crons, D1/R2 shared across deployables. Opinionated rules with runnable checks, an adding-X table, an audit checklist, refactor playbooks and anonymized production lessons. Supplements the official Cloudflare skills. |
| [`opencodewiki`](opencodewiki/) | Generate and maintain a repository wiki that a coding agent reads before planning a change: what each feature does today, and the patterns the codebase already follows. Source-grounded, OKF v0.2, git-native. Plugin with commands; requires the `opencodewiki` CLI ([`opencodewiki-cli/`](opencodewiki-cli/)). |
| [`comments-cleanup`](comments-cleanup/) | Sweep a codebase and remove comment noise while preserving the comments that earn their place (quirks, findings, non-obvious constraints, tooling directives). Reads the project's own comment policy and lets it override built-in defaults; fans out a parallel Workflow for large sweeps. |

## Installing

Every skill is its own Claude Code plugin, so you can install exactly the ones you want:

| Skill | `npx skills add` | Claude Code `/plugin` |
|-------|------------------|-----------------------|
| `cloudflare-platform-architecture` | yes | yes |
| `comments-cleanup` | yes | yes |
| `opencodewiki` | skill only, without the `/opencodewiki:*` commands | yes (full workflow) |
| `retrospective` | no (commands only, no `SKILL.md`) | yes |

With the [`skills`](https://github.com/vercel-labs/skills) CLI (Claude Code, Codex, Cursor and
other agents):

```bash
npx skills add anagri/skills --list   # see what's available
npx skills add anagri/skills --skill cloudflare-platform-architecture
```

With Claude Code's plugin marketplace:

```bash
/plugin marketplace add anagri/skills
/plugin install cloudflare-platform-architecture@anagri-skills
/plugin install comments-cleanup@anagri-skills
/plugin install opencodewiki@anagri-skills
/plugin install retrospective@anagri-skills
```

`opencodewiki` needs its CLI (`npm i -g opencodewiki`). The skill installs it on first use if it is
missing.

Or manually — skills are discovered from a few locations. Pick whichever fits:

- **Per-project:** copy or symlink a skill dir into the project's `.claude/skills/`.
- **User-wide:** copy or symlink into `~/.claude/skills/`.

For example, to make one skill available user-wide:

```bash
ln -s "$(pwd)/comments-cleanup" ~/.claude/skills/comments-cleanup
```

Claude consults a skill based on its `description`, so you don't invoke it
manually — just describe the task (e.g. "clean up the redundant comments across
`src/`") and the relevant skill triggers.
