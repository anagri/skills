# Evidence — stage 2 (raw)

> **Facts only.** Collect everything here *before* forming any opinion about it. The moment a file in
> this folder says "because", it has crossed into stage 3 — move that line to
> [`../03-insights.md`](../03-insights.md).
>
> **Order: artifacts first, then the interview.** Collect the mechanical sources, then take
> [`user-input.md`](./user-input.md) with the evidence in hand — a person shown the actual commit log
> recalls far more, and more accurately, than one asked to remember cold. Taking an unprimed account
> first is optional: it preserves the remembered-versus-recorded gap, which is worth having while a
> period is fresh and rarely worth the effort once it is months old.

## Sources

| File | Source | Answers |
|---|---|---|
| [`git-commits.md`](./git-commits.md) | `git log` | What actually shipped, in what order, at what granularity |
| [`github-ci.md`](./github-ci.md) | `gh run list` | Whether the loop was green, how flaky, how slow |
| [`claude-sessions.md`](./claude-sessions.md) | Claude Code transcripts | Where time went; what was re-derived, abandoned, or re-learned |
| [`analytics.md`](./analytics.md) | Product analytics | Whether the shipped thing changed user behaviour |
| [`repo-docs.md`](./repo-docs.md) | `CHANGELOG.md`, `docs/techdebt/`, `docs/claude-plans/` | The intended narrative, the deferred debt, and plan-vs-shipped drift |
| [`user-input.md`](./user-input.md) | The human, interviewed with the evidence in hand | What the artifacts cannot hold: what it cost, why a call was made, what was abandoned and never committed |

Collection commands for each are in `references/evidence-sources.md` → *The sources*.

## Coverage

Say what was **not** collected and why — an unread source is a known blind spot, and silently
skipping one makes the retro look better-founded than it is.

| Source | Collected? | Note |
|---|---|---|
| git-commits | ☐ | |
| github-ci | ☐ | |
| claude-sessions | ☐ | |
| analytics | ☐ | |
| repo-docs | ☐ | |
| user-input (interview) | ☐ | |
