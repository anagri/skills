# Git commits

**Collected:** YYYY-MM-DD · **Range:** `<since>..<until>` or `<sha>..HEAD`

```bash
git log --since=<date> --oneline
git log --since=<date> --pretty='%ad %s' --date=short
git log --since=<date> --grep='^fix' --grep='^revert' --oneline   # where the first attempt failed
git log --since=<date> --shortstat --oneline | tail -40           # churn per commit
git log --since=<date> --name-only --pretty=format: | sort | uniq -c | sort -rn | head -20
```

## Volume and mix

| Type | Count | Share |
|---|---|---|
| `feat` | | |
| `fix` | | |
| `chore` / `docs` / `refactor` | | |
| `revert` | | |
| **Total** | | |

## Timeline

<Commit subjects in order, grouped by day. Conventional-commit subjects say what the behaviour now
is, so this reads as a narrative of the period without further processing.>

## Re-fixes and reverts

| Commit | Area | What it corrected | Days after the original |
|---|---|---|---|

<The highest-signal rows in this file. A fix landing days after its feature says the gap was not
covered by any check — that is a system finding waiting for stage 3.>

## Hot files

<Files touched most. Repeated churn in one file over a short period is either the feature under
construction or a design that keeps not fitting; the commit subjects usually say which.>

## Observations (facts only)

- <e.g. "6 of 31 commits were `fix`, all in the checkout path">
