---
description: Write every wiki page from the approved skeleton, then the entrypoint and routing table
argument-hint: "[--architecture-model opus] [--only path/to/page.md]"
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

# opencodewiki:author

Turn an approved skeleton into an actual wiki. Runs after `/opencodewiki:init`.

Arguments: `$ARGUMENTS`

## 1. Preflight

```bash
opencodewiki --version || echo "MISSING"
opencodewiki state show --json
test -f opencodewiki/.work/skeleton.json && echo "skeleton present" || echo "NO SKELETON"
```

CLI missing → run `npm i -g opencodewiki` and check `opencodewiki --version` again. If the install
fails, stop and show the user the error.

No skeleton → stop and say to run `/opencodewiki:init` first. There is nothing to write from, and
guessing a page tree here would waste the critique that init already paid for.

Open the run:

```bash
opencodewiki state begin --command init --phase author --json
```

## 2. Confirm before spending

This is the expensive phase — one agent per page. Before launching, tell the user the page count,
the split by chamber, and the model policy the builder reports. Give them a real chance to adjust
the skeleton first; changing a page's purpose now costs nothing, changing it after costs a rewrite.

## 3. Generate and run

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/build_author_workflow.py" \
  --repo-root "$(pwd)" \
  --skeleton opencodewiki/.work/skeleton.json \
  --brief opencodewiki/INSTRUCTIONS.md \
  --out opencodewiki/.work/author.workflow.js
```

Pass `--architecture-model opus` when the user asks for it. The default follows the shared model
policy: a small run goes entirely on the strong model, a larger one puts the per-page fan-out on the
fast model and keeps the strong one for the quickstart. Worth saying out loud when it applies —
architecture pages need breadth sampling across many files to tell a convention from an accident,
which is genuinely harder than the depth reading a functional page needs, so that is the one place
the cheaper default costs quality rather than just time.

Pass `--only <path>` (repeatable) to retry a subset without rewriting pages that are already good.

Then invoke the **Workflow** tool with
`{ scriptPath: "opencodewiki/.work/author.workflow.js" }`.

## 4. Finalize

The wiki is not finished when the last page is written — index files, front-matter canonicalisation,
diagram validation and link stamping are all still outstanding:

```bash
opencodewiki finalize
opencodewiki report --json
```

`finalize` runs `normalize → mermaid → index → links` in that order. Run it a second time and
confirm it reports no changes; that idempotence is the check that the wiki has actually settled.

## 5. Gate on the result

Read the report and judge it. Say plainly what is wrong rather than presenting the run as a success:

- `okf.invalidCount` should be `0`.
- `okf.distinctTypes` **greater than one**. A single distinct type across the whole wiki means the
  field carries no signal and every page looks alike to a retriever — a measured failure on a real
  generated wiki, not a hypothetical.
- `okf.needsGrounding` should be empty. Each entry is a page whose front matter was synthesized and
  still needs a real type, title and description.
- `links.issues` should be `0`.
- `mermaid.issues` should be `0`. If `mermaid.parser` is `heuristic`, say so — the check is weaker
  than it looks.
- Every page in `skeleton.json` exists on disk. The workflow names any it failed to write; do not
  let a partial wiki be reported as complete.

For anything that failed, re-run with `--only` for those pages rather than the whole set.

## 6. Record

```bash
opencodewiki state stamp --status complete --phase complete --json
opencodewiki log add --kind Creation "Initial wiki generated from the approved skeleton."
```

Stamp `complete` only when every page exists and the report is clean. Otherwise stamp `interrupted`
and say which pages are missing — a later `delta` needs to know this run did not finish.

## 7. Report

Give the user: pages written, any that failed, the finalize summary, the report numbers above, and
two or three concrete things the wiki now answers that were previously only in source. Point them at
`opencodewiki/quickstart.md` as the entrypoint.

Then say what is still missing: the QA loop (source-derived questions answered from the wiki alone)
is not implemented, so nothing has yet verified that these pages actually stand on their own.
