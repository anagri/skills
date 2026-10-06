---
description: Prepare a repository for opencodewiki — wiki directory, brief, run state, and the plan check-in convention
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
---

# opencodewiki:setup

Prepare this repository. Idempotent — safe to re-run.

## 1. Preconditions

```bash
opencodewiki --version || echo "MISSING"
```

If missing, install it and check again before continuing:

```bash
npm i -g opencodewiki                  # exact mermaid validation
# npm i -g opencodewiki --omit=optional  # 1.5 MB, heuristic mermaid validation
opencodewiki --version
```

If the install fails, stop and show the user the command and the error.

## 2. Scaffold

```bash
opencodewiki setup --json
```

This creates `opencodewiki/`, an `INSTRUCTIONS.md` brief stub, and `.state.json`; and when a plans
directory is configured, writes the plan check-in convention into `CLAUDE.md` (and `AGENTS.md` if
present) between `OPENCODEWIKI:START/END` markers. Report what it created, updated, or left
unchanged.

## 3. Plans directory

The command's JSON reports `plansDir`. If it is `null`, Claude Code plans are not being captured in
this repo. Offer — do not silently apply — adding to `.claude/settings.json`:

```json
{ "plansDirectory": "./docs/claude-plans/" }
```

Merge into the existing file rather than overwriting: read it, add the one key, write it back.
Never clobber `permissions`, `hooks`, `env`, or anything else already there.

Explain why it is worth it: plans record *why* the code looks the way it does — intent, decisions
taken, and alternatives rejected. Rejected code is not in the repository, so a plan is the only
place that reasoning survives. Without it, the architecture chamber can describe what the patterns
*are* but not what they were chosen *over*.

If the user declines, continue. Plans are optional and everything else works without them.

## 4. The brief

Read `opencodewiki/INSTRUCTIONS.md`. If it is still the stub, invite the user to say — in a few
sentences — what this wiki should emphasise: which parts of the product matter, what is changing,
what is out of scope.

Be clear about what the brief does and does not control. It steers **emphasis**, not **structure**:
the `functional/` and `architecture/` chambers exist either way. A good brief says "the ingestion
pipeline is where most changes land, and the admin console is legacy"; it does not need to propose
a page layout.

Do not write the brief for them beyond the stub. It is the one file opencodewiki never generates,
and its value comes from being the user's own words.

## 5. Report

State plainly: where the wiki will live, whether plans are wired up, whether the brief is still a
stub, and that `/opencodewiki:init` is the next step.
