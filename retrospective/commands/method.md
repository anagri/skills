---
description: Retro the retro — inspect the last retrospective run for defects in the method itself and fix them
argument-hint: "[session-dir]"
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Glob
  - Grep
---

# retrospective:method

Retro the retrospective. Scope is **the method**, not the period. Run it while the pass is fresh —
method defects are visible for about an hour and then become invisible.

Write to `<session-dir>/retro-the-retro.md`.

## Why this exists

A retro process silently degrades. It keeps producing plausible documents while measuring the wrong
thing, sampling a fraction of the corpus, or repeating a misreading. Nothing in the output looks
wrong — that is exactly the problem. The only defence is a deliberate pass at the machinery.

## What to check

**Did any agent disagree with another?** Cross-batch disagreement on a count means a census was
delegated to an LLM that could only see a slice. Move it into the collector or into a grep.

**Did any zero go uninvestigated?** Zero bytes, zero runs, zero commits. Each is a claim. Confirm it.

**Did any subset get reported as a whole?** An API that paginates, a query that caps, a directory read
non-recursively. Every collected subset must print *n of total*.

**Did the interview overturn a conclusion?** Record which one and why the evidence pointed the wrong
way. If the same *kind* of misreading appears twice, it is a defect in the taxonomy or the prompts,
not bad luck — fix it there.

**Did a provisional finding reach `outputs/` before the interview?** If so, that is how a wrong
conclusion becomes durable. Tighten the ordering.

**Did an action get committed that no longer bites?** Historical windows can surface solved problems.

**Was the window the right size?** Too small and trends are invisible; too large and extraction
strains. Note what the volume actually was.

## What to do with what you find

Fix it in the artifact that caused it, not in prose:

| Defect | Fix belongs in |
|---|---|
| Agents disagreeing on counts | `scripts/collect_window.py` |
| A source silently truncated | `scripts/collect_window.py` |
| The same misreading twice | `references/taxonomy.md` |
| Prompts inviting speculation | `scripts/build_workflow.py` |
| Wrong ordering | `references/facilitation.md` and the `/retro` command |

Then say, in one line, what changes for the next run — and whether any past window's numbers are now
**not comparable**, so a later trend is not read off a redefined metric.
