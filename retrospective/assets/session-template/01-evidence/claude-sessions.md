# Claude Code sessions

**Collected:** YYYY-MM-DD · **Period:** <range>

Transcripts (one JSONL per session):

```
~/.claude/projects/<project-slug>/
```

```bash
P=~/.claude/projects/<project-slug>
ls -la "$P"/*.jsonl | awk '$6" "$7 >= "<Mon> <D>"'      # sessions in the period
grep -l '<keyword>' "$P"/*.jsonl                          # sessions touching a topic
```

**These files are large — grep them, never read them whole.** Search by keyword, then read a window
around the hits.

## Sessions in the period

| Session (id / date) | What it was about | Outcome |
|---|---|---|

## Where the time went

<Which sessions were productive, which were spent re-deriving something already known, which were
abandoned. This is the source no other artifact can replace: the commit log shows what landed, the
transcripts show what it cost.>

## Re-derived or re-learned

<Anything worked out from scratch that was already recorded in `CLAUDE.md`, `docs/`, or agent memory
(`memory/MEMORY.md`). Every entry here is a docs or memory finding, not a personal one — the record
existed and did not reach the point of use.>

## Abandoned approaches

| Approach | Why it was dropped | Was the reason recorded anywhere? |
|---|---|---|

<An unrecorded dead end will be walked again.>

## Observations (facts only)

- <e.g. "3 sessions re-derived the migration ordering rule already in CLAUDE.md">
