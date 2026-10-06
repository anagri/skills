---
description: Build the repository wiki from scratch — map the repo, digest plan intent, design the page skeleton and have it critiqued
argument-hint: "[--stop-after skeleton]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Workflow
  - Agent
---

# opencodewiki:init

Build the wiki. This phase runs the map → skeleton → critique pipeline and **stops before writing
prose**, so the plan can be judged before paying for the output.

Arguments: `$ARGUMENTS`

## 1. Preflight

```bash
opencodewiki --version || echo "MISSING"
opencodewiki state show --json
```

- CLI missing → run `npm i -g opencodewiki` and check `opencodewiki --version` again. If the install fails, stop and show the user the error.
- Not a git repository → stop. Everything downstream is git-native.
- No wiki yet → run `/opencodewiki:setup` first, then continue.
- A run already in progress → say so and ask whether to resume or restart, rather than trampling it.

Then open the run:

```bash
opencodewiki state begin --command init --phase map --json
```

## 2. Build the area inventory

The fan-out width comes from this, so spend a little care. Prefer real boundaries the repository
already declares over your own carving:

1. **Workspaces or packages** — `pnpm-workspace.yaml`, `package.json#workspaces`, `Cargo.toml`,
   `go.work`. Each member is an area.
2. **Otherwise, top-level source directories** — `src/*`, `app/*`, `lib/*`, plus `e2e/`, `tests/`,
   `infra/`, `scripts/` where they carry real weight.
3. **Split anything oversized.** An area whose implementation runs to many thousands of lines
   should become two or three areas by domain. One scout with too much ground covers it thinly, and
   thin coverage is the failure this whole design exists to avoid.
4. **Merge anything trivial.** A directory with two small files does not need its own scout.

Aim for **6–20 areas**. Write the list to `opencodewiki/.work/areas.json`:

```json
[{ "name": "worker-api", "paths": ["apps/api/worker"] }]
```

Skip vendored and generated trees entirely: `node_modules`, `dist`, `build`, `.next`, `target`,
`vendor`, and the wiki itself.

## 3. Index the plans

```bash
opencodewiki plans index --json --out opencodewiki/.work/plans.json
```

Exit 3 means no plans directory is configured — that is fine and common. Continue; the wiki is built
from source either way, and the architecture chamber simply loses the rejected-alternative material.

## 4. Generate and run the workflow

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/build_init_workflow.py" \
  --repo-root "$(pwd)" \
  --areas-from opencodewiki/.work/areas.json \
  --plans-from opencodewiki/.work/plans.json \
  --brief opencodewiki/INSTRUCTIONS.md \
  --out opencodewiki/.work/init.workflow.js
```

Then invoke the **Workflow** tool with `{ scriptPath: "opencodewiki/.work/init.workflow.js" }`.

The script owns sequencing and fan-out width deliberately. In openwiki this phase graph exists only
as prose inside one long-running agent, where nothing enforces the order and a failure loses the
whole run. Here each phase is a real boundary, the critic round limit is a counter rather than a
request, and a killed run resumes from cached results instead of starting over.

Tell the user roughly what it will cost before launching: one agent per area, one per plan batch,
then a small number of opus agents for the skeleton and critique.

## 5. Gate on the skeleton

When the workflow returns:

```bash
head -60 opencodewiki/.work/skeleton.json
```

Check these yourself, and say plainly if any fail — a skeleton that passes silently but is wrong
costs far more at the next phase:

- Both chambers are present and neither is a token gesture.
- Every area in `areas.json` has at least one page, or an explicit entry in `deferred` with a
  reason.
- Page purposes are specific enough to write from. "Documents the API" is not.
- Every page carries `source_paths`. A page with no evidence assigned cannot be written.
- Architecture pages cite breadth, not a single file. Conventions are claims about many files.
- `links` are stated with a reason, not just a list of neighbours.

Record where the run reached:

```bash
opencodewiki state stamp --status interrupted --phase skeleton --json
```

`interrupted` is honest here: the wiki does not exist yet, and a later `delta` should treat this as
unfinished work rather than a completed run.

## 6. Report

Show the user the page tree and the critic's verdict. Summarise:

- how many areas were mapped, and any that failed;
- how many plan batches were digested;
- whether the critic passed, and any unresolved requests;
- the proposed page count per chamber.

Then stop. Say explicitly that no pages have been written yet, and that reviewing the skeleton now
is much cheaper than reviewing dozens of written pages later. Ask whether to proceed with
`/opencodewiki:author`, adjust the skeleton first, or change the brief and re-run.

Do not roll straight into authoring. The skeleton gate exists precisely because a wrong page tree is
cheap to fix here and expensive to fix afterwards.
