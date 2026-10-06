# The process — five stages

The canonical structure is Esther Derby and Diana Larsen's five stages, from *Agile Retrospectives:
Making Good Teams Great*. Each stage has exactly one job. That separation is the whole point: it is
what keeps a retrospective from collapsing into an unstructured complaint session, and it is why
stage 2 (facts) is deliberately walled off from stage 3 (interpretation).

| # | Stage | Its one job | Share of a 60-min retro |
|---|---|---|---|
| 1 | **Set the stage** | Get everyone oriented, and get every voice used **once**, early | 5 min |
| 2 | **Gather data** | Collect what *happened* — events, artifacts, metrics. No opinions yet | 15 min |
| 3 | **Generate insights** | Cluster the data, find patterns, dig for root cause | 20 min |
| 4 | **Decide what to do** | Pick 2–3 changes. Specific, owned, dated | 15 min |
| 5 | **Close** | Restate the decisions, appreciate the work, retro the retro | 5 min |

## 1. Set the stage

Two things happen here, and skipping either one degrades everything downstream.

**Establish safety.** Read the Prime Directive (below) aloud, or its equivalent. State the ground
rules: assume positive intent, criticize ideas not people, everyone participates, listen without
interrupting, what is said here stays here.

**Get everyone speaking.** A person who has not spoken in the first five minutes is markedly less
likely to speak at all. A single word each — "how did this sprint feel, in one word?" — is enough to
break the seal. It is a mechanism, not a warm-up ritual.

Then state the scope: what period, what milestone, who is here, what notable events happened.

### The Prime Directive

Norm Kerth's Prime Directive, read at the start of the retro:

> Regardless of what we discover, we understand and truly believe that everyone did the best job they
> could, given what they knew at the time, their skills and abilities, the resources available, and
> the situation at hand.

This is not a politeness. It is the precondition for anyone volunteering the information that makes a
retro worth holding — nobody surfaces their own mistake in a room where mistakes are charged to the
person who made them. It is equally load-bearing in a solo retro, where the person being judged is
the one writing the document.

## 2. Gather data

Facts only. What shipped, what broke, what was abandoned, what the numbers did. Pull from artifacts
rather than memory — memory is recency-biased and reconstructs the sprint around whatever happened
last. See [`evidence-sources.md`](./evidence-sources.md#the-sources) for the sources and what
each one alone can tell you.

Include the emotional data too — where energy was high, where it drained — but record it as an
observation ("the third login bug in a row felt like whack-a-mole"), not yet as a diagnosis.

**Guard the boundary.** The moment someone says "and that happened *because*…", that is stage 3.
Park it and keep collecting. Interpretation offered early anchors the group and quietly ends the
search for data that would contradict it.

## 3. Generate insights

Now interpret. Three moves, in order:

**Cluster.** Group related items. Ask "are these the same thing?" Themes emerge from the grouping —
you do not need to name them in advance.

**Explore root cause.** Ask *why* repeatedly (five times is the folk rule; the real rule is: until
the answer stops being a restatement of the symptom). Useful facilitation questions:

- Can you help us understand what happened?
- Why do you think this happened?
- What would have had to be true for this to go differently?
- How would we prevent this class of thing, not this instance?
- What would success actually look like?

**Prioritize.** You cannot fix everything, and trying is the most common way retros fail. Vote (dot
voting works) or discuss down to the **top 2–3** items. Everything else goes to the parking lot,
which is a real section of the document, not a euphemism for the bin.

## 4. Decide what to do

Convert the top items into actions. The bar for each one is in
[`action-items.md`](./action-items.md): specific, measurable, owned by a named person, dated,
and landed in the place where work actually gets tracked.

Two or three actions completed beats ten recorded. Deliberately underfill.

## 5. Close

Restate what was decided and who owns each action — out loud, so nobody leaves with a different
version of the outcome. Appreciate the work and the honesty; naming a specific contribution beats a
generic thank-you.

Then **retro the retro**: was this format useful, was the length right, what should be different next
time? This is the cheapest possible defense against format rot, which is a documented anti-pattern.

## Timed agenda (60 minutes)

| Segment | Time | Activities |
|---|---|---|
| Opening | 5 min | Welcome and goals · Prime Directive and ground rules · explain the format · one word each |
| Data gathering | 15 min | Silent individual reflection (5) · silent brainstorm onto the board (10) |
| Discussion | 20 min | Cluster similar items · discuss themes · ask clarifying and root-cause questions |
| Improvement planning | 15 min | Vote on priorities · write actions · assign owners and dates |
| Closing | 5 min | Summarize decisions · commit · appreciate · retro the retro |

Scale proportionally for a 30- or 90-minute session. The proportions matter more than the absolute
numbers: roughly a quarter of the time on collecting, a third on understanding, a quarter on
deciding.
