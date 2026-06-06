# Fan-out workflow: design notes & gotchas

These notes capture what was learned running this skill on a 237-file sweep, so
future runs don't relearn them the hard way.

## Why one agent per file

Comment cleanup is judgment-heavy: each comment needs a keep/kill/trim decision
against the rubric. Grinding through hundreds of files in a single context is
slow and drifts — later files get a different bar than earlier ones. One fresh
agent per file, each handed the *identical* policy, keeps judgment consistent
and runs the files concurrently (throttled by the harness concurrency cap; you
can hand it hundreds of files and they drain in batches).

Use `parallel()` — a barrier is fine here because there's no cross-file
dependency; each file is independent and you want all the summaries together to
report totals.

## Gotcha: don't pass the file list through `args`

A large JSON array passed as the Workflow `args` input does **not** round-trip
reliably — it can arrive stringified, so `args.map(...)` throws ("args must be a
non-empty array"). The generator therefore **embeds the file list as a literal
`FILES` const** in the script. The script still accepts `args` as an optional
override for small ad-hoc runs, but the embedded list is the source of truth.

## Gotcha: path resolution

Workflow agents resolve paths from the repo root, which may differ from your
Bash cwd (e.g. Bash sits in `apps/` while agents resolve from the repo root).
Avoid ambiguity by embedding the **absolute** repo root and having each agent
read `<REPO_ROOT>/<repo-relative-path>`. The generator does this for you via
`--repo-root`.

## Gotcha: agents occasionally wander

A small fraction of agents may make an off-task edit (in one run, an agent added
an unrelated build recipe to a `justfile`). After the sweep, check that every
changed file was actually a cleanup target and that the diff is comments-only
(Step 4 of SKILL.md). Revert anything that isn't.

## Structured output

Each agent returns `{ file, removed, trimmed, kept, notes }`. The `notes` field
is where it explains its notable keeps and any ambiguous calls — surface a few
of these to the user so they're reviewing *judgment*, not just counts. The
script aggregates totals and returns a `perFile` breakdown for files that
actually changed.

## Resuming

Every Workflow invocation persists its script and returns a `runId`. If you edit
the generated script and relaunch with `{ scriptPath, resumeFromRunId }`,
unchanged agent calls return cached results — so a partial failure or a tweak
doesn't re-run the whole sweep.
