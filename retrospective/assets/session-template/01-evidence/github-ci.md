# GitHub / CI

**Collected:** YYYY-MM-DD · **Period:** <range>

```bash
gh run list --workflow=ci.yml --limit 50
gh run list --workflow=deploy.yml --limit 20
gh run list --workflow=ci.yml --status=failure --limit 20
gh run view <id> --log-failed
```

## Run summary

| Workflow | Runs | Passed | Failed | Pass rate | Median wall-clock |
|---|---|---|---|---|---|
| `ci.yml` | | | | | |
| `deploy.yml` | | | | | |
| `<workflow>.yml` | | | | | |

## Failures

| Run | Workflow | Step | Cause | Real bug or flake? |
|---|---|---|---|---|

<Classify every failure. A flake rate is a finding about the harness; a real-bug rate is a finding
about the checks that run before push.>

## Repeat offenders

<Specs or steps that failed more than once. Name them — quarantining a named spec is an action;
"fix the flaky CI" is not.>

## Observations (facts only)

- <e.g. "2 of 18 `ci.yml` runs red, both the same login e2e spec">
