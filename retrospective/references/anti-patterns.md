# Anti-patterns

The documented ways retrospectives fail. **Scan this list before closing a retro** — most of these
are cheap to catch in the moment and expensive to notice three sessions later.

## The failure modes

| Anti-pattern | What it looks like | Remedy |
|---|---|---|
| **Action item graveyard** | Items are agreed, then quietly buried once real work resumes. Nobody ever formally decides not to do them | Land every action in the actual backlog with an owner and a date; open the next retro by reviewing them |
| **UNSMART actions** | "Improve communication", "be more agile", "write more tests" — unmeasurable, so never demonstrably done | Apply the SMART test in [`action-items.md`](./action-items.md#the-bar). If you cannot say when it is late, it is not an action |
| **No owner** | The team collectively "accepts" an item; delivery belongs to nobody | One named person per action. Never "we" |
| **Too many actions** | Fifteen improvements from a 60-minute meeting | Cap at 2–3. Prioritize explicitly and park the rest |
| **Inaction → futility** | The same problems are named every cycle and nothing changes; people stop bringing real material | Fix *one* recurring item completely and visibly. Demonstrated follow-through is the only antidote |
| **Format rot** | Same format, same length, same venue, forever. Answers become autopilot | Rotate per [`formats.md`](./formats.md); retro the retro at every close |
| **Status meeting in disguise** | The retro is merged with a review or standup; reflection is crowded out by progress reporting | Keep it a separate ceremony. If it must share a slot, run reflection first while attention exists |
| **Blame session** | Findings attach to individuals rather than to the system that produced the outcome | Read the Prime Directive at the open; restate any person-shaped finding as a system-shaped one |
| **Dominant voice** | One person's frame sets the agenda; others confirm it | Silent writing before discussion — see [`facilitation.md`](./facilitation.md#silent-writing-before-discussion) |
| **Only what went wrong** | Nothing positive is collected; participation starts to feel like punishment | Collect both halves. What worked is reusable information, not a morale gesture |
| **Ignored patterns** | Nobody reads across past retros, so a recurring theme is re-discovered as new each time | Keep `<retro-root>/sessions/` and read the last three `03-insights.md` files before facilitating |
| **Ignored difficult feedback** | The uncomfortable item gets acknowledged and never actioned | If it is real, it becomes an action or an explicit, written decision not to act |
| **Held when everyone is spent** | Scheduled at the end of a brutal week or right after a late ship | Move it. A tired retro produces a shallow one, and shallow retros teach people the ceremony is theatre |
| **No follow-up at all** | The document is written and never opened again | The previous-actions review is a mandatory agenda item, not an optional one |

## The two that matter most

If you only guard against two:

1. **Actions without owners and dates** — the direct cause of the 40–50% completion rate.
2. **Never reviewing previous actions** — the thing that makes the first one invisible, and turns a
   feedback loop back into a meeting.

## Solo-specific traps

Running a retro alone removes the social failure modes and adds its own:

- **Confirmation of the story you already have.** Alone, there is no one to contradict your account —
  so the artifacts have to. Collect every mechanical source *before* interpreting, interview against
  what they show, and write down every place the account and the record disagree in the *Divergence*
  table — see [`evidence-sources.md`](./evidence-sources.md#the-sources).
- **Self-blame instead of system findings.** "I was sloppy" is not actionable. "There is no check
  that catches this before push" is. The Prime Directive applies to yourself.
- **Recency bias.** With no other memories in the room, the last three days dominate. The git log and
  the transcripts are the correction.
- **Skipping it because nothing feels wrong.** A period with no felt friction is exactly when the
  slow drift is invisible, and it is the cheapest retro you will ever run.

## The method's own anti-patterns

A retrospective process degrades silently: it keeps producing plausible documents while measuring the
wrong thing. These are the failure modes of *the retro itself*, all observed in practice.

| Anti-pattern | What it looks like | Remedy |
|---|---|---|
| **Technique counted as friction** | Deliberate ways of working — a stocktake, a plan-first request — tagged as corrections, inflating the headline metric | The `technique` tag and the project's technique table — [`taxonomy.md`](./taxonomy.md) |
| **Provisional finding made durable** | A conclusion reaches the accumulating outputs before the interview, then has to be withdrawn | Nothing enters `outputs/` until after the interview |
| **Census by slice** | Each agent counts the same property over its own slice and the numbers are averaged. Slices measuring the same thing return incompatible numbers | Measure once over the whole set, or measure with a grep. Slices describe; they do not count |
| **The uninvestigated zero** | A file reporting 0 bytes is treated as empty when it was renamed or deleted | Resolve from history; read the blob |
| **Silent truncation** | A paginated API returns the first page and the retro reports it as the whole | Every subset prints *n of total* |
| **Truncation that isn't** | `n < total` is read as truncation when the shortfall is an intentional filter — a date-granular API returning runs on the exclusive end date, for instance. The retro then raises a gap that does not exist | Establish *which* before calling it a gap. The collector reports `excluded_out_of_window` separately from `page_truncated` for exactly this reason |
| **Foreign data counted as ours** | A collector matches on time but not on project, and reports another project's files as this window's. The inverse of truncation: the number is too *large*, so every under-collection check passes | Filter every source by the project marker, not just by date. A run can report a handful of transcripts for a window with none — all from an unrelated project — and it reads as "the agent's half survives" |
| **A derived slice assignment** | An agent is told to take "position i of every N" and computes its own membership. It drifts, and nothing fails — plans go unread window after window | Assign each slice a literal list at build time. Membership that cannot be derived cannot drift |
| **A mechanical count that is wrong** | A census moved into code is cited without argument — which is exactly what makes a too-narrow pattern invisible. A narrow matcher can miss most of the real candidates | A mechanical count carries more authority than a model's guess, so its pattern needs the harder review. Check its recall against a deliberately wider grep before trusting it |
| **An override with nowhere to declare itself** | An agent is handed an authoritative list and told to justify any departure — then departs silently, because the output format has no field for the justification | Make the exception a **required** schema field. A silent override should not be expressible |
| **Boundary deferral** | A prompt or commit in the window's last hours reads as deferred, abandoned or open — and becomes a finding, or an action, without anyone checking whether it was resolved the next morning | `git log --since=<end> --until=<end+2d>` plus a prompt-history slice, **before** it becomes a finding. Skipping it produces wrong actions |
| **Verifying with the wrong flag** | A check appears to confirm a conclusion because the command excluded the case that would refute it — `--diff-filter=AD` hides renames, so every rename reads as a delete | State what the command would have shown if you were wrong. A verification that cannot fail is not one |
| **Prescribing a solved problem** | A historical window produces an action for something a later window already fixed | The *does this still bite today?* test |
| **The tidy story** | The evidence supports a coherent explanation that happens to be wrong — a pause in CI that reads as test-suite collapse and was a deliberate cost decision | The interview, always, and before conclusions harden |


## The window boundary

A retrospective's window is an artifact of scheduling. **The work does not know where it ends.**

Anything in the final hours of a window that reads as *deferred*, *abandoned*, *blocked* or *open* is
the most likely thing in the whole corpus to be already resolved — because the natural next move
happened the next morning, one day outside the frame.

Before such a thing becomes a finding, and certainly before it becomes an action:

```bash
git log --since=<window-end> --until=<window-end + 2 days> --oneline
```

plus the prompt-history slice for the same days. If the following window is already collected, read it.

Skipping this produces wrong actions: a relook prescribed long after it was completed, or a
test-discipline fix prescribed for a pattern that had already inverted. The correcting evidence is
typically one `git log` past the window edge.

The inverse holds too, and is worth the same check: something that reads as *finished* at the window's
close may have been reopened immediately after. **A window boundary is not a fact about the work.**
