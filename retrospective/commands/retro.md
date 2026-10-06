---
description: Run an evidence-first retrospective over a date window — collect git/prompts/CI/plans, consolidate, interview, then commit 2-3 actions
argument-hint: "<start YYYY-MM-DD> <end YYYY-MM-DD> [--slug name]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Workflow
  - AskUserQuestion
---

# retrospective:retro

Run a retrospective over `$ARGUMENTS` — a half-open window `[start, end)`, local dates.

A retrospective is a structured look backwards that ends in a small number of owned, dated changes.
On a solo project where an agent writes the code, its real job is narrower and more useful: **find the
corrections you keep making by hand, and turn them into rules, tools or hooks so you stop making
them.** A correction issued once is noise. The same correction three times is a missing mechanism.

## Before anything else

Read these, in order. They carry the judgment; this command is only the sequence.

1. `${CLAUDE_PLUGIN_ROOT}/references/process.md` — the five stages and what each is for
2. `${CLAUDE_PLUGIN_ROOT}/references/facilitation.md` — **evidence-first ordering; why the interview comes last**
3. `${CLAUDE_PLUGIN_ROOT}/references/taxonomy.md` — how prompts are tagged, and the one distinction that carries the headline metric
4. `${CLAUDE_PLUGIN_ROOT}/references/anti-patterns.md` — including the ones this method itself falls into

Then read the project profile at `<retro-root>/profile.md` if it exists. If it does not, **stop and
run `/retrospective:setup` first** — without it you will collect the wrong sources.

## 1 · Scope and create the session

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/collect_window.py" --help
```

**First, check the window is not already covered.** `sessions/` is the authority, not memory. A
window that overlaps an existing session produces a confident duplicate that nobody notices, because
every finding in it is true.

```bash
ls <retro-root>/sessions/ && grep -h 'Period covered' <retro-root>/sessions/*/index.md
```

If the requested window overlaps one already retro'd, **stop and put it to the user** with the
alternatives priced — the next uncovered window, its volume, and what re-running would actually buy.
A re-run is occasionally right (a metric was redefined since), but it must be chosen, not stumbled
into. A request can arrive looking new and turn out to be almost entirely an existing session's
prompts.

Create the session folder from the template, then collect:

```bash
cp -r "${CLAUDE_PLUGIN_ROOT}/assets/session-template" <retro-root>/sessions/<start>-<slug>
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/collect_window.py" <start> <end> <session-dir> \
  --profile <retro-root>/profile.md
```

**Pass `--profile`.** It string-matches the profile's known-technique table against the prompts and
writes `_raw/technique-candidates.md`. **Recognising a documented technique is a lookup, not a
judgement**, and delegating it to a model fails reliably: extraction can report almost no technique
prompts while its own output quotes several verbatim table rows — with the two-question test live in
the prompt. The grep finds them all.

The collector is deterministic and does the counting. **Everything downstream cites `counts.json`
rather than tallying** — an agent asked to total across a batch boundary will disagree with itself,
which is a defect this process has already hit and fixed.

Read `_raw/sizing.md` before planning batches. Keep any single agent's input under ~100k tokens.

**Investigate every zero.** A file reporting 0 bytes has usually been renamed or deleted, not left
empty — the collector resolves those from history and gives you a `<sha>:<path>`. A zero taken at face
value is a silent sampling bias, and it can hide a large share of the planning corpus.

**And when you verify, use a command that could prove you wrong.** `--diff-filter=AD` hides renames, so
every rename reads as a deletion and the check "confirms" the error. Before trusting a verification,
say what it would have shown had the opposite been true.

**Check the window's last hours against the next window.** Anything reading as deferred, abandoned or
open at the boundary is the likeliest thing in the corpus to be already resolved —
`git log --since=<end> --until=<end+2d>`. See `references/anti-patterns.md` § The window boundary.

**A quiet day is not an empty day.** `_raw/other-projects.md` lists prompts sent to *other* projects on
the days this one shows nothing. On a solo timeline an inactive stretch is usually attention elsewhere,
and that is an answer rather than a gap — a stretch recorded as "no evidence at all" is often
explained in full by `history.jsonl`.

## 2 · Extract and consolidate

**If `_raw/sizing.md` totals under ~40k tokens, skip the workflow and do it in one pass.** The fan-out
exists to keep any single agent under ~100k tokens; below that it buys nothing and costs something
real — every slice is another chance at the census-by-slice defect, and a corpus one agent can hold
whole is a corpus where a contradiction between two sources is visible rather than distributed. A
window of a few dozen prompts and commits typically fits well under that, and consolidates in a single
pass with no slice-disagreement to reconcile.

The rules below apply either way; only the mechanism changes. Say in `05-close.md` which route you
took and what the corpus measured.

For anything larger, build and run the workflow:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/build_workflow.py" \
  --session <session-dir> \
  --profile <retro-root>/profile.md \
  --out /tmp/retro-workflow.js
```

Then invoke `Workflow` with that script. It fans out cheap extraction agents (one slice each: prompt
days, commit batches, plans, CI) and finishes with one strong consolidation agent that writes
`02-data.md`.

Two rules the workflow enforces, and you should not relax:

- **Extraction is facts only.** The moment an agent writes "because", it has crossed into stage 3.
- **A census is measured once, over the whole set, or mechanically.** Slices *describe*; they must not
  each count the same property and be averaged — slices measuring the same thing will return
  incompatible numbers.
- **The consolidator reconciles slice coverage against the collector's manifest.** An agent handed a
  sampling frame can state one and follow another: two plan agents declared an every-3rd frame whose
  positions did not match the files they opened, and some plans went unread with nothing flagging
  it. Which files an agent actually read is knowable only from its output, so diff the union of what
  the slices report against `_raw/plans.md` (and the commit batches) and **say what went unread**.

If `Workflow` is unavailable, run the same slices as sequential `Agent` calls; the shape matters, the
mechanism does not.

## 3 · Interview — the step that earns the retro

Present a **memory-jog recap** first: day by day, what shipped, what fought back, quoted verbatim.
Then ask about what the artifacts cannot explain.

This is not a formality. The interview routinely **overturns conclusions the evidence fully
supports** — a pause in CI that looks like test-suite collapse and was a deliberate cost decision;
refactors that look like thrash and were a learning curve; autonomy prompts that look like
flip-flopping and are deliberate technique.

Ask about: gaps in activity, anything that stopped and never resumed, work that looks reversed, days
whose shape is anomalous, and **what was thrown away before it was ever committed** — no other source
can see that.

**Then ask the open one: _what did you notice, reading this?_** Every other question is about the
record; this one is about *their* reading of it, and the attendee is the only participant who can see
the corpus and their own intent at once. It can surface a finding nothing else did — *"looks like a
lot of UI fixes"* turning out to be a block of design-specification prompts the taxonomy had no tag
for, in a window whose insight clusters said nothing about UI. It costs one line.

Write the answers to `01-evidence/user-input.md`, including a **Divergence** table: where the account
and the record disagree. Do not resolve the divergences; they are the most valuable rows in the retro.

**Then go back and revise stage 2.** Re-read `02-data.md`'s Contradictions and Observations, and strike
or amend anything the interview settled. A contradiction the interview resolved is no longer a
contradiction, and an observation the interview falsified is no longer evidence — leaving either in
place puts a refuted claim in the same document as the finding that refutes it, which has already
happened. This is the one point where stage 2 may be edited after the fact, and only in this direction:
removing what the human's answers disproved, never adding what they merely suggested.

## 4 · Insights, actions, close

Write `03-insights.md` (clusters → root causes → ranked priorities), then `04-actions.md`, then
`05-close.md`. Read `${CLAUDE_PLUGIN_ROOT}/references/action-items.md` first.

**At most 2–3 actions, and fewer for a small window.** Teams complete 40–50% of retro actions; the cap
is the single highest-leverage countermeasure — but it is a ceiling, not a target. One real action from
a quiet fortnight is a correct outcome. Each action is specific, owned, dated, and **landed somewhere outside the retro
folder** — an action that lives only in the retro is already dead.

**If the window is historical**, every action must additionally pass *does this still bite today?* A
window months old can surface a problem that time already solved.

**Nothing is written to `<retro-root>/outputs/` until after the interview.** During extraction and
consolidation, candidate practices stay in `03-insights.md` where they are understood to be
provisional. `outputs/` is for what survived contact with the human — a wrong finding that reaches it
becomes durable, quotable, and wrong.

## 5 · Land the outputs

- `<retro-root>/outputs/process.md` — practices, tagged with the window that produced them. Once a
  practice recurs across windows it is a candidate for a rule, a skill or a hook.
- `<retro-root>/outputs/tasks.md` — everything named but not committed as an action.
- Update `<retro-root>/sessions/README.md` with the session's index row.
- Update the known-techniques table in `profile.md` if the interview revealed a new one.

## 6 · Then retro the retro

Run `/retrospective:method` while the run is fresh. The method has its own defects, and they are only
visible right after a pass.
