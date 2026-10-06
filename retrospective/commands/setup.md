---
description: Create the retrospective profile for this project — which evidence sources exist, where retros land, and the known working techniques
argument-hint: "[--root docs/retrospectives]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Glob
  - Grep
  - AskUserQuestion
---

# retrospective:setup

Create `<retro-root>/profile.md` — the small file that makes the generic retro process fit **this**
project. Run once per project. `/retrospective:retro` refuses to run without it, because a retro that
collects the wrong sources produces confident findings about nothing.

Default root: `docs/retrospectives/` in the repo. Use `--root` to place it elsewhere (outside the repo
if retro documents should not be committed).

## Detect before you ask

Establish what is actually there, then confirm rather than interrogate:

```bash
git rev-parse --show-toplevel && git remote get-url origin
git log --oneline | wc -l && git log -1 --pretty=%ad --date=short
ls .github/workflows/ 2>/dev/null
ls ~/.claude/projects/ | grep -i "$(basename "$(git rev-parse --show-toplevel)")"
ls docs/claude-plans docs/plans 2>/dev/null | head
grep -rl 'posthog\|amplitude\|mixpanel' --include='*.ts' --include='*.tsx' -i . 2>/dev/null | head -3
```

Check transcript retention, because it silently decides what a retro of an old window can even see:

```bash
grep cleanupPeriodDays ~/.claude/settings.json || echo "unset — defaults to 30 days"
```

**If it is unset or low, say so plainly and offer to raise it.** Claude Code deletes transcripts after
that many days; `~/.claude/history.jsonl` keeps *user prompts* far longer. A retro run more than a
month after the fact will have your prompts but not the agent's replies — workable, but you should
know before you plan the series, not after.

## Write the profile

```markdown
# Retrospective profile — <project>

## Shape
- Solo / team: <>
- Branching: <trunk-based | PRs>
- Who writes the code: <agent | human | mixed>   ← changes what a "correction" means
- Stack notes: <anything that shapes the evidence, e.g. Cloudflare Workers + D1>

## Evidence sources
| Source | Available? | Where |
|---|---|---|
| git commits | yes | this repo |
| prompt history | yes | ~/.claude/history.jsonl, project marker `<marker>` |
| full transcripts | <yes/no> | retention: <N> days |
| CI | <yes/no> | `<workflows>` via `gh api repos/<slug>/actions/runs` |
| plans | <yes/no> | `<docs/claude-plans>` |
| product analytics | <yes/no> | <PostHog project / none> |
| changelog / techdebt docs | <yes/no> | <paths> |

## Retro root
`<path>` — sessions in `sessions/`, accumulating practices in `outputs/`.

## Known techniques
Deliberate ways of working that must NOT be counted as corrections. See
`${CLAUDE_PLUGIN_ROOT}/references/taxonomy.md`. Start empty; add one whenever an interview reveals it.
Quoted *"phrases"* in *Looks like* are string-matched against prompts; *Pattern* is an optional
case-insensitive regex in backticks for phrasings that vary (escape `|` as `\|`).

| Technique | Looks like | Pattern |
|---|---|---|
```

## Then

Create `<retro-root>/sessions/README.md` with an empty index table, and `<retro-root>/outputs/` with
an empty `process.md` and `tasks.md`.

Tell the user what you found — especially anything **missing**, since an absent source is a blind spot
they should choose knowingly rather than discover in the middle of a retro.
