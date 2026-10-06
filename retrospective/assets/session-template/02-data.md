# Data — stage 2 (processed)

> The consolidated view. Everything here traces back to a file in [`01-evidence/`](./01-evidence/index.md);
> nothing new is introduced. Still **facts** — the interpretation lives in
> [`03-insights.md`](./03-insights.md).

## Timeline

<The period as one sequence, merged across sources: commits, CI failures, deploys, sessions, and the
user's own account. Sequence is what makes causation visible — "we broke it here and did not notice
until three days later" only appears once the sources are on one line.>

| When | What happened | Source |
|---|---|---|
| YYYY-MM-DD | <event> | `01-evidence/git-commits.md` |

## Observations

Every observation carries its source. An observation nobody can trace is a memory, and memories are
already recorded in `01-evidence/user-input.md`.

| # | Observation | Source | Type |
|---|---|---|---|
| 1 | <fact> | `01-evidence/<file>.md` | positive / friction / neutral |

## By the numbers

| Metric | Value | Source |
|---|---|---|
| Commits (feat / fix / chore) | | `git-commits.md` |
| Reverts + same-area re-fixes | | `git-commits.md` |
| CI pass rate | | `github-ci.md` |
| Sessions in the period | | `claude-sessions.md` |
| <domain metric> | | `analytics.md` |

## Contradictions

<Where two sources disagree — the remembered account versus the log, the plan versus what shipped,
the changelog versus the commits. Do **not** resolve them here; a contradiction is raw material for
stage 3 and frequently the most productive thing in the retro.>

## Gaps

<What could not be established, and which source would have settled it. Feeds the coverage table in
`01-evidence/index.md`.>
