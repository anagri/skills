---
name: comments-cleanup
description: >-
  Sweep a codebase and remove comment noise — obvious restatements, change
  narration, commented-out code, type-echoing JSDoc, and decorative section
  dividers — while preserving the comments that actually earn their place
  (library quirks, hard-won findings, non-obvious constraints, critical
  caveats, tooling directives). Use this whenever the user wants to clean up,
  prune, trim, audit, or "apply a comment policy" to comments across files or a
  whole project; whenever they complain comments are noisy / redundant / out of
  date / "written by an AI"; or whenever they ask to enforce a minimal-comment
  convention. For large sweeps (dozens+ of files) it fans out a parallel
  Workflow so every file is judged consistently. It reads the project's own
  comment policy (CLAUDE.md / contributing guides) and lets that override the
  built-in defaults, so it respects house style instead of imposing one.
---

# Comments Cleanup

Remove comments that don't earn their place; keep the ones that do. Comments
cost ongoing upkeep and become lies when code drifts — so the bar is: **a
comment must carry information the code itself cannot express.** Everything else
is noise.

This skill works equally well on one file or a whole monorepo. The judgment is
the same; only the *mechanics* scale (inline for a few files, a parallel
Workflow for a large sweep).

## The decision the whole skill turns on

For every comment, ask: *could a competent reader recover this fact from the
code alone?* If yes, delete it. If no — it's a quirk, a discovered fact, a
non-obvious constraint, a "why", or a tooling directive — keep it (and trim it
to just the part that isn't obvious).

The full, calibrated rubric with worked keep/kill examples lives in
`references/default-policy.md`. **Read it before editing anything** — it is the
heart of this skill and the examples are what make judgment consistent across
files and across agents.

## Step 1 — Discover the policy (defaults + project overrides)

The built-in rubric is a sensible default, **but the project's own convention
wins.** Before touching code:

1. Read `references/default-policy.md` (the default rubric).
2. Look for a project-specific comment policy and let it override the defaults
   where they conflict. Check, in order: `CLAUDE.md` / `AGENTS.md` /
   `.cursorrules` at the repo root and in the target dirs; any
   `docs/guides/**`, `CONTRIBUTING*`, or style-guide docs; and any
   `comments-cleanup` memory/preference the user has saved.
3. If the user stated a preference in their message ("keep all the TODOs",
   "be aggressive", "leave the test files alone"), that is the highest
   authority — fold it in.

Briefly tell the user which policy you're applying (e.g. "Using your CLAUDE.md
minimal-comment policy on top of the defaults") so they can correct you before a
large sweep runs.

## Step 2 — Survey the scale

Find the target files and gauge how many actually contain comments — there's no
point dispatching work for files with nothing to clean.

```bash
# adjust the root + extensions to the project
grep -rl -E '//|/\*|#' --include='*.ts' --include='*.tsx' --include='*.py' \
  <root> 2>/dev/null | grep -v node_modules | grep -v dist
```

Use the count to choose the mechanics in Step 3.

## Step 3 — Choose the mechanics by scale

**A few files (roughly < 8):** just do it inline yourself. Read each file,
apply the rubric with Edit, move on. No Workflow needed.

**A large sweep (dozens+ of files):** fan out a parallel Workflow — one agent
per file, each applying the *same* rubric. This is both faster and more
consistent than grinding through them in one context, because every file gets a
fresh, focused judgment against identical instructions.

Workflows spawn many agents and use significant tokens, so they require the
user's explicit opt-in. If the user already asked for the sweep ("clean up all
the comments in apps/"), that's your opt-in. If scale is large but the request
was vague, confirm first: tell them the file count and that you'll fan out a
Workflow, and let them approve.

To build the fan-out, use the bundled generator — it embeds the rubric and the
file list into a ready-to-run Workflow script so you don't hand-assemble it:

```bash
python3 scripts/build_workflow.py \
  --repo-root <abs repo root> \
  --policy <abs path to the merged policy text you assembled> \
  --files-from <file with one repo-relative path per line> \
  --out /tmp/comments-cleanup.workflow.js
```

Then launch it with the Workflow tool: `{ scriptPath: "/tmp/comments-cleanup.workflow.js" }`.
The script embeds the file list as a literal (do **not** rely on passing the
list through `args` — large arrays don't round-trip reliably), and each agent
returns a structured summary (`removed` / `trimmed` / `kept` / `notes`) so you
can report totals and notable keeps. See `references/workflow-notes.md` for the
design rationale and gotchas.

If Workflows aren't available in the environment, fall back to dispatching a
handful of parallel subagents over batches of files with the same rubric, or do
it inline — the rubric is what matters, not the harness.

## Step 4 — The hard rule: comments only

Whatever the mechanics, **only comments change.** No logic, strings, JSX text,
or formatting should move. After the edits, prove it:

```bash
# Every changed line should differ only in its comment portion.
git diff -U0 | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' \
  | grep -vE '^[+-]\s*(//|/\*|\*|\*/|\{/\*|#)' | grep -vE '^[+-]\s*$'
```

Inspect anything this surfaces. Trailing inline comments on code lines are
expected (the code half is identical on both sides); genuine code changes are
not — revert those. Also scan for any file the sweep touched that wasn't a
cleanup target (agents occasionally wander) and revert it.

## Step 5 — Verify and gate

Comments-only changes shouldn't break anything, but verify rather than assume —
an agent could clip a line. Run the project's gate (typecheck → lint/format →
tests). Report the real outcome. If the project follows a phase/gate ritual or
trunk-based workflow, honor it; **don't commit unless the user asks.**

## Step 6 — Report

Summarize: files processed, comments removed / trimmed / kept, and a few
*notable keeps* (the quirks/findings you deliberately preserved) so the user
can sanity-check your judgment, not just the counts. Note whether it was a
user-visible change (comment cleanup usually isn't, so usually no CHANGELOG
entry — but follow the project's convention).

## What "good" looks like

A successful run deletes the noise a reader would skip anyway, sharpens the
half-useful comments down to their insight, and leaves untouched the comments a
future maintainer (or AI) would have had to reverse-engineer the hard way. If
in genuine doubt about a comment that looks like a hard-won finding, keep it —
a surviving useful comment is cheap; a deleted one is gone.
