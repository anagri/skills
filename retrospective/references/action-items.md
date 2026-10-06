# Action items

The only durable output of a retrospective. Everything upstream — the format, the clustering, the
discussion — exists to produce two or three of these, and the next retro exists partly to check them.

**The number to know:** teams typically complete only **40–50%** of their retrospective action items.
The failure is rarely in the insight; it is in the handoff between the retro and the actual work.

## The bar

Every action item must be **SMART**:

| Letter | Means | Test |
|---|---|---|
| **S**pecific | One concrete change, not a direction | Could someone else do it without asking you what you meant? |
| **M**easurable | You can tell whether it happened | What is the observable difference afterwards? |
| **A**chievable | Fits in the capacity that actually exists | Is there room for this alongside the real work? |
| **R**elevant | Traces back to a named finding in this retro | Which discussion item is this the fix for? |
| **T**ime-boxed | Has a date, not "soon" | When is it late? |

Plus two non-negotiables:

- **A named owner.** Not "the team", not "we". An item owned by everyone is owned by nobody — the
  single most cited cause of items silently expiring.
- **A home outside this document.** See [Landing them](#landing-them) below.

### Vague versus SMART

| ✗ Not an action | ✓ An action |
|---|---|
| Improve communication | Implement a daily 15-minute check-in for the next two weeks — Sarah — by Feb 1 |
| Be more agile | Cut sprint scope to 3 stories and measure carryover for 2 sprints — Dev — by Mar 15 |
| Write more tests | Add an e2e for the checkout-refresh path — Priya — before the next deploy |
| Fix the flaky CI | Quarantine the 3 specs that failed twice this week and file each with its failure log — Sam — by Friday |

The left column is a *sentiment*. Sentiments feel productive to write and are impossible to complete,
so they accumulate, and their accumulation is what teaches people that retro actions do not matter.

## How many

**At most two or three — and fewer when the window is small.** A low-activity window that yields one
real action is a correct outcome, not a thin one; three active days do not contain three problems
worth an owner and a date. Filling the cap to look thorough is how an action list stops being
believed, which costs more than the action you did not write. Generating too many action items is one of the most common ways
retrospectives fail: the list exceeds capacity, nothing gets finished, and the completion rate
collapses — which then makes the *next* retro's review feel like an indictment, so it gets skipped.

Deliberately underfill. Three finished actions is a working feedback loop; ten recorded actions with
four done is an action item graveyard with good intentions.

## Setting the due date

Anchor to the cadence, not the calendar:

| Priority | Due |
|---|---|
| High | Before the next cycle starts |
| Medium | Within the next cycle |
| Low | Within two cycles — or reconsider whether it is an action at all |

An action with no natural deadline inside two cycles is usually a *wish*. Move it to the parking lot
where it can be honest.

## Landing them

An action that exists only in the retrospective document is already dead. Put it where the work
actually lives — the issue tracker or backlog, `CHANGELOG.md`, or the project's tech-debt docs,
whichever `<retro-root>/profile.md` names.

The retro document then records the action *and where it landed*, so the next review can check the
real source rather than trusting the retro's own copy.

## Reviewing the previous retro

**This is the first agenda item of every retrospective**, before any new data is gathered. Skipping it
is how the loop breaks.

For each action from last time, record: done, in progress, blocked, or not started — and for anything
incomplete, *why*.

- **Celebrate what completed.** Specifically. This is the evidence that the ceremony pays, and it is
  the only thing that keeps people investing in the next one.
- **Diagnose what did not.** The reason is data about your process, and it is frequently more
  interesting than anything in the new period. Not started because it was never scheduled is a
  different problem from blocked on something external.
- **Carry over, or kill.** An item carried three times is not going to happen. Either something is
  blocking it that nobody has named — which is the real finding — or it does not matter enough. Say
  which, in writing, and close it.

## Tracking across retros

Keep a completion rate: *completed ÷ committed*, per retro. It is recorded twice on purpose — in the
session's `05-close.md` metrics table, and in the index row in
`<retro-root>/sessions/README.md`, so the trend is visible without opening any retro.

The rate is a diagnostic on the retrospective process itself. If it sits low across several sessions,
the topic of the next retro is the retro — you are producing insight the system cannot absorb, and
the fix is fewer or smaller actions, not more discipline.

Worth trending alongside it: cycle time, defect or regression rate, CI pass rate, and how often the
same theme recurs. Objective series make it possible to tell an improvement from a good mood.

## Historical windows

When a retro covers a period that closed weeks or months ago, two rules change.

**The previous retro's actions are not scored.** An action set last week is about how work happens
*now*; a window that predates it cannot evidence it either way, and a completion rate there measures
nothing. Record the inherited actions, state that they are carried unscored, and resume scoring when
the series reaches the present — then review everything accumulated in one pass.

**An inherited action may be wrong, not just incomplete.** Reviewing last time's actions asks
*done or not done* — but a historical window is also the first evidence that can say whether the
action was ever aimed at a real problem. When the window shows the premise was false, the move is
**supersede, not add**: write one action that replaces the old one, say in the new retro which action
it replaces and why the premise failed, and correct it at its landing place so the backlog does not
carry both. Two actions for one problem, one of them aimed at a phantom, is worse than either alone.

*Illustrative:* a retro reads the last prompt of its window — an instruction to leave the failing
e2e tests alone pending a relook at the whole e2e setup — as a deferral still standing weeks later,
and commits an action to it. The relook had happened the next morning. What needed an action was
what the relook did **not** fix (runtime and flake rate), which is a different action with a different
success test.

**Every action must pass: _does this still bite today?_** A window months old can surface a problem
that time, or a later window, already solved. One series prescribed *update tests before adding new
ones* — and the very next window already showed test modifications far outnumbering additions. The
fix was written for a problem that had already corrected itself.

Findings are still recorded in full. Only the **actions** are filtered this way — the point of an
action is to change what happens next, and a period that is over cannot be changed.
