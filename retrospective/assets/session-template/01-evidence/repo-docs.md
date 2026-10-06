# Repo docs — changelog, debt, plans

**Collected:** YYYY-MM-DD · **Period:** <range>

```bash
git log --since=<date> -p -- CHANGELOG.md | head -200
git log --since=<date> --oneline -- docs/techdebt/
ls -la docs/claude-plans/
```

## Changelog

<Entries added under `## [Unreleased]` in the period. Already written in behaviour-and-why form, so
they are the intended narrative — the useful question is where the log and the commit history
disagree about what this period was.>

| Entry | Section | Matches the commit record? |
|---|---|---|

**Unlogged, user-visible changes:** <anything that shipped and never got an entry. That is a process
finding, and a cheap one to fix.>

## Tech debt

| Item | Added / resolved / still open | Is the deferral still justified? |
|---|---|---|

<From the tech-debt docs (`docs/techdebt/*.md` or wherever the profile says). Debt accepted with a stated
condition is worth re-checking against that condition, not just re-listing.>

## Plan versus shipped

| Plan (the plans directory) | Planned | Shipped | Delta |
|---|---|---|---|

<The delta is the finding: scope that quietly grew, phases silently dropped, or an approach replaced
mid-flight without the plan being updated.>

## Docs drift

<Places where `docs/reference/` no longer matches the code, or `docs/guides/` no longer matches how
work is actually done. Code is truth; the drift is the finding.>

## Observations (facts only)

- <e.g. "2 user-visible changes shipped without a CHANGELOG entry">
