# The correction taxonomy

How a user prompt is tagged during stage-2 extraction. One tag per prompt — the dominant one.

The taxonomy exists to answer one question: **which corrections are structural?** A correction issued
once is noise; the same correction three times is a missing rule, a missing skill, or a missing hook.

## Tags

| Tag | Means | Example |
|---|---|---|
| `technique` | **Deliberate working method**, not a correction. The user driving the agent the way they intend to | *"analyze and propose a fix, do not start implementing"* · *"only list the pending items"* · *"i am away from keyboard, go with your strongest recommendation"* |
| `process` | Instructs on **how to work** rather than what to build, because the default was wrong | *"run it locally first"* · *"commit and push, wait for green CI"* · *"pause for input"* |
| `constrain` | Narrows an **over-broad** action the agent took or proposed | *"only upgrade the react package, not the others"* |
| `redirect` | Changes course mid-task | *"we reverse our decision"* |
| `reject` | Undoes or throws away what the agent produced | *"the change is broken"* · *"remove it completely"* |
| `repeat` | The same instruction re-issued because it was not followed | near-identical prompts inside one session |
| `clarify` | Supplies context or answers a question the agent needed | |
| `frustration` | Explicit annoyance or an interruption | *"why dont you fix the lint issues"* |
| `design` | **Product or UX specification** — deciding what the thing should look like or how it should behave. Not a correction: a perfectly-behaving agent still has to be told | *"make the button secondary, no icon"* · *"move the filter above the list"* · a screenshot pasted as the spec · *"increase contrast, dark text on a light accent"* |
| `none` | Ordinary task instruction, no corrective content | |

## Why `technique` exists — and it is not a nicety

**Without it, extraction misreads deliberate technique as friction** — and it does so every window.
Two illustrative misreadings:

- Repeated *"pause for input"* alongside *"continue, do not wait for approvals"* read as the user
  flip-flopping on autonomy. It was one coherent workflow for someone who leaves the keyboard once
  implementation starts.
- *"only list the pending items, and let me approve them"* read as tightening autonomy. It was a
  **mid-feature stocktake** — a progress readout, not a mode change.

Misreadings like these are usually caught only by the interview. Without the `technique` tag the same
mistake recurs, and worse: **every technique prompt inflates the headline correction rate**, which is
the metric the whole series is trying to move. A window measured before the tag existed is overstated,
and is not comparable to a window measured after.

## Deciding between `technique` and `process`

They look alike and the distinction carries the metric, so apply this test:

> **Would the user issue this prompt to a perfectly-behaving agent?**
>
> - **Yes** → `technique`. It is how they choose to work. A stocktake, a plan-before-implement request,
>   an away-from-keyboard delegation.
> - **No** → `process`. It exists because the agent did the wrong thing, or would have.

*"Commit after every phase"* is `technique` — a standing preference. *"You did not commit, commit
now"* is `process`.

### The test has two halves — ask them separately

The question above conflates **how a prompt is worded** with **why it was sent**, and a habitual
wording attached to a corrective moment breaks it. Split it:

> 1. **Is the *wording* habitual?** Does the user always phrase this kind of intervention this way?
> 2. **Was the *moment* corrective?** Would this prompt have been sent to an agent that was doing the
>    right thing at that instant?

**The moment decides the tag. The wording only decides whether you can read the tag off the text.**

| Wording | Moment | Tag |
|---|---|---|
| habitual | not corrective | `technique` — a stocktake, a plan-first request, an away-from-keyboard handoff |
| habitual | **corrective** | **`process`** — and the wording will fool you every window unless it is in the profile's technique table with a note saying *the phrase is habit, the moment is not* |
| ad hoc | corrective | `process` — the easy case |
| ad hoc | not corrective | ordinary instruction, `none` |

The row that matters is the second. An illustrative example: a user who habitually sends a bare
*"pause for input"* instead of pressing Esc, so the agent finishes its current step and waits. The
wording is a standing habit; the moment is a genuine brake. It is easy to read the phrase as an
autonomy setting, or to file it as `technique`. It is `process` — a real interrupt — and it is **never** evidence of a mode change,
tightened autonomy, or flip-flopping.

So: when the surrounding prompts do not settle it, **ask what the agent was doing when it arrived**,
not what the prompt says. If that is unrecoverable, prefer `process` and say so in the note.

## Known techniques come from the project profile

Extraction agents are handed the project's technique table from `<retro-root>/profile.md` so they
recognise these rather than re-deriving them. The table starts empty and grows: **whenever an
interview reveals that a prompt you filed as a correction was actually deliberate, add it.**

Illustrative examples of what belongs there:

| Technique | Looks like | Pattern |
|---|---|---|
| **Plan-without-plan-mode** | *"analyze and present plan to fix, do not fix it"* — a scoped plan without the plan-mode round trip, to save time and quota | |
| **Stocktake** | *"only list the pending items"* — a mid-feature progress readout, not a mode change | `only list the (?:pending\|open)` |
| **Run the phases** | *"continue, do not wait for any more approvals unless you have a blocker"* — a standing autonomy instruction | `continue.{0,80}do not wait` |
| **Away-from-keyboard delegation** | *"i am away from keyboard, for any decisions do thorough research and pick the strongest option"* | `away from (?:the )?keyboard` |
| **Functional handoff** | *"create a prompt detailing the issues functionally, let the new agent explore and propose"* | |
| **Local-first verification** | *"run it locally first"*, *"do not deploy from local, retrigger CI"* | |

The *Pattern* column is optional: a case-insensitive regex the collector matches when a technique's
phrasing varies too much for the quoted spans to catch. Phrasings are personal, so they live here,
not in the script.

A technique that is documented stops being counted as friction. A technique that is not gets
miscounted every single window, and the headline metric drifts further from the truth each time.

## Reporting

Extraction returns counts for **all** tags, and lists every non-`none` prompt with its verbatim quote.
Consolidation reports two rates:

- **Correction rate** — `process + constrain + redirect + reject + repeat + clarify + frustration`
  over total. This is the metric the series tracks.
- **Technique rate** — `technique` over total. Not friction. A rising technique rate with a falling
  correction rate is the shape of someone getting better at driving the tool.
- **Design share** — `design` over total. Not friction either. It measures how much of a window was
  *product decision-making* rather than engineering, which is otherwise invisible: a window can be
  half UI work and show nothing for it, because specifying a product is not correcting an agent.

### `design` — the second non-friction category

`technique` covers *how the user drives the agent*. `design` covers *what the user has decided the
product should be*. Neither is friction, and they fail differently: technique gets miscounted as a
correction, while **design gets buried in `none` and becomes invisible**.

The second is the more common failure. Picture a window where most UX-specification prompts sat in
`none` and only a handful leaked into correction tags: a fortnight in which UI was a large share of the
commits and the fix traffic produces **no measurable signal about product work at all**, and the retro
names its themes without one of them being UI.

**The test — is the agent's output wrong, or merely not yet specified?**

- *"make the button secondary, no icon"* → `design`. Nothing was broken; a choice was made.
- *"the button is still showing an icon"* → `process`/`repeat`. It was specified and not done.
- *"contrast is insufficient in light mode, use dark text on a light accent"* → `design`. A judgement
  the agent could not have derived.
- *"user-a's prefs load for user-b"* → **not design** — that is a defect report, whatever it looks
  like. Design specifies; bug reports describe something already wrong.

A prompt mixing a feature request with a placement note takes the dominant tag, usually `none`.

### Define the denominator, every time

*"Total"* is not self-evident, and an undefined denominator silently breaks the trend.

**Bare slash commands are not prompts.** `/model`, `/mcp`, `/clear`, `/doctor`, `/config`, `/rename`
are harness operations, not instructions to an agent. They can never be corrections, so every one of
them mechanically **depresses** the correction rate — and their share is not constant: one window can
run a fifth of its prompts as bare slash commands, the next far fewer.

Report the rate **over instructional prompts only** — total minus bare slash commands — and state
both numbers so an older window measured the other way can still be placed:

> Correction rate **16/36 = 44.4%** of instructional prompts (34.8% of all 46, of which 10 were bare
> slash commands). *(illustrative numbers)*

Any window whose denominator is unknown is **not comparable** to one whose denominator is defined.
Say so in `05-close.md` rather than drawing a trend line through them.
