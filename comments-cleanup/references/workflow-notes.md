# Fan-out workflow: design notes & gotchas

These notes capture what was learned running this skill on large sweeps, so
future runs don't relearn them the hard way.

## Why batch by folder instead of one agent per file

The earlier design spun up one agent per file. That kept judgment fresh but paid
the per-agent context/setup cost hundreds of times over — and comment cleanup is
*cheap per comment*, so that overhead dominated. The current design batches files
that share a folder into one agent (target ~30, range 20–50).

Two wins:
- **Token efficiency.** One agent reads a batch of related files in a single
  context instead of N agents each re-establishing project context.
- **Locality = consistency.** Files in the same directory tend to share
  conventions, so judging them together keeps the keep/kill bar consistent
  *within* a directory — which is where consistency matters most to a reader.

Use `parallel()` — a barrier is fine because batches are independent and you want
them all to finish before the comments-only verification in the SKILL's Step 4.

## How the batcher groups files (`build_workflow.py`)

1. Bucket files by their immediate parent folder.
2. Any folder larger than the ceiling (`--max`, default 50) is split into
   ~`--target`-sized chunks. Locality is fully preserved — every chunk is from
   the same folder.
3. Folders at/under the ceiling are merged with siblings under a shared ancestor
   (deepest-first) until each merged batch reaches the floor (`--min`, default
   20), or there's nothing left to merge with (a small project just becomes one
   under-floor batch — that's fine).

The result is batches of mostly-20–50 files, each drawn from a coherent part of
the tree. Tune with `--target/--min/--max` only if a specific repo needs it.

## Auto-detecting code files

Targets are discovered, not user-specified: detect the languages present and
collect source files that contain comments (SKILL Step 2). Docs/data files
(`.md`, `.txt`, `.json`, `.yaml`) are excluded up front because their "comments"
are usually real content. As a belt-and-suspenders measure, each cleanup agent
re-checks per file and skips anything that turns out to be a docs/data file —
so a stray path in the list can't cause content to be mangled.

## Gotcha: don't pass the batches through `args`

A large JSON array passed as the Workflow `args` input does **not** round-trip
reliably — it can arrive stringified, so `args.map(...)` throws. The generator
therefore **embeds the batches as a literal `BATCHES` const** in the script. The
script still accepts `args` as an optional override for small ad-hoc runs, but
the embedded list is the source of truth.

## Gotcha: path resolution

Workflow agents resolve paths from the repo root, which may differ from your Bash
cwd (e.g. Bash sits in `apps/` while agents resolve from the repo root). Avoid
ambiguity by embedding the **absolute** repo root and having each agent read
`<REPO_ROOT>/<repo-relative-path>`. The generator does this for you via
`--repo-root`.

## Gotcha: agents occasionally wander

A small fraction of agents may make an off-task edit (in one run, an agent added
an unrelated build recipe to a `justfile`). After the sweep, check that every
changed file was actually a cleanup target and that the diff is comments-only
(Step 4 of SKILL.md). Revert anything that isn't. Batching slightly raises the
stakes per agent (more files in one context), so the comments-only diff check is
not optional.

## Output

The script returns only `{ batches, batchesCompleted, batchesFailed, totalFiles }`
— enough to confirm the run and flag failures, nothing more. The deliverable is
the cleaned code, so report stays minimal (SKILL Step 6). If a batch fails, you
can resume rather than re-run the whole sweep (below).

## Resuming

Every Workflow invocation persists its script and returns a `runId`. If you edit
the generated script and relaunch with `{ scriptPath, resumeFromRunId }`,
unchanged agent calls return cached results — so a partial failure or a tweak
doesn't re-run the whole sweep.
