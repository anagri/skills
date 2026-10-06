# Evidence sources

What a retro collects, and why each source is worth its cost. Which of these exist for a given project
is recorded in `<retro-root>/profile.md` — an absent source is a **declared blind spot**, not a silent
one.

Everything here is stage 2: **facts only**. The moment a note says "because", it belongs in insights.

## The sources

| Source | Command | What only it can tell you |
|---|---|---|
| **Commits** | `git log --since=<s> --until=<e> --pretty=... --shortstat --name-status` | What shipped, in what order, at what granularity. Conventional-commit types give the work mix for free |
| **Re-fixes and reverts** | `git log --grep='^fix' --grep='^revert'` | Where the first attempt did not hold — the highest-signal input to stage 3 |
| **Prompt history** | `~/.claude/history.jsonl`, filtered by project | **Every correction you made.** The single most valuable source for an agent-assisted project |
| **Full transcripts** | `~/.claude/projects/<slug>/*.jsonl` | What the agent actually *did* — the half that explains why it got corrected. Expires; see retention below |
| **CI** | `gh api repos/<slug>/actions/runs?created=<s>..<e>` | Whether the loop was green, how slow, and — often more telling — **when it stopped running** |
| **Plans** | added under the plans dir in-window | What was intended versus what shipped. The delta is a finding |
| **Changelog / debt docs** | `git log -p -- CHANGELOG.md` | The narrative already written in behaviour-and-why form |
| **Product analytics** | PostHog / equivalent | Whether any of it changed user behaviour. Everything else measures effort |
| **The human** | interviewed **last**, with evidence in hand | What it cost, why a call was made, and what was abandoned before anything was committed |

## Transcript retention decides what an old window can see

Claude Code deletes transcripts after `cleanupPeriodDays` — **30 by default**. `history.jsonl` keeps
*user prompts* far longer.

So a retro of a recent window sees both halves of the conversation; a retro of an old one sees only
yours. That is more workable than it sounds — **corrections live in the user's half** — but the agent's
reasoning is gone, so *why* it did the thing that got corrected cannot be recovered.

Two consequences worth acting on:

- **Raise the retention** before starting a series, not after. Discovering the limit mid-series means
  the windows you have not reached yet are still expiring.
- **Where transcripts survive, `claude --resume <uuid>` is available.** Reopening a session and reading
  what the agent actually did is the richest evidence this process has. Check ids against disk before
  promising it — a session id in `history.jsonl` does not mean the transcript still exists.

## Collection principles

**Metadata always, diffs never by default.** A window's commit metadata is a few thousand tokens; its
diffs are a million. Pull a diff only for the handful of commits the analysis actually turns on.

**Count in the script, not in the model.** Totals belong in `counts.json`. An agent that can only see
one batch cannot produce a window total, and will confidently try.

**Every subset reports *n of total*.** APIs paginate and queries cap. A collector that silently
truncates reads as complete coverage — a run can fetch half the CI runs and nothing says so.

**A zero is a claim.** Zero bytes usually means renamed or deleted, not empty; the content is still in
history. Resolve it and read the blob. An uninvestigated zero is a sampling bias that looks like data —
it can conceal a large share of the planning corpus, and a finding built on it has to be withdrawn.

**Interview last.** See [`facilitation.md`](./facilitation.md). Collect first, then show the person the
record and ask what it misses.
