# User input — the interview

> Taken **with the evidence in hand**, after the mechanical sources are collected. A person shown the
> actual commit log recalls far more, and more accurately, than one asked to remember cold — and for
> a period more than a couple of weeks old, an unprimed account is usually too thin to be worth the
> loss in recall.
>
> The facilitator's job here is to *present*, then *ask*: show what the record says, and find out what
> it cannot hold — what a stretch cost, why a call was made, what was tried and abandoned before
> anything was committed.

## Optional — unprimed account

> Fill this **only** if the period is recent enough that the attendee genuinely remembers it, and
> only *before* they are shown any evidence. Skipping it is a normal choice, not a shortcut; say so
> below rather than deleting the section.

**Taken?** ☐ yes ☐ no — <if no, why: period too old, evidence already discussed, …>

- **The period in one word:** <word, and a sentence on why>
- **What I think happened:** <from memory, unchecked>
- **What frustrated me:** <feelings are data at this stage; the diagnosis comes later>

## Interview

Evidence presented: <which files were shown, and in what order>

### What the record shows — and what it misses

| What the evidence says | What actually happened around it |
|---|---|
| <e.g. "9 commits on Thursday, all checkout"> | <e.g. "two of those were the third attempt; the first design was thrown away uncommitted"> |

### Cost and friction

<Where the time actually went, and what felt expensive. Artifacts record output, never effort — a
one-line commit can be a two-hour fight and the log will never say so.>

### Decisions and their reasons

<Calls made in the period whose *why* exists nowhere in the repo. These are the entries most worth
promoting into a doc, a `CLAUDE.md` rule, or agent memory — an unrecorded reason gets re-litigated.>

### Abandoned before it was committed

<Approaches tried and dropped with no artifact left behind. Invisible to every other source, and a
dead end nobody recorded will be walked again.>

### Direct asks

<Anything the attendee wants this retro to address, whether or not the evidence raises it.>

---

## Divergence from the record

> Where the account and the artifacts disagree. If an unprimed account was taken, this is the gap
> between it and the evidence; otherwise it is anywhere the interview contradicts what was collected.
> Do not resolve it here — a contradiction is raw material for stage 3.

| Remembered | Recorded | What the gap says |
|---|---|---|
