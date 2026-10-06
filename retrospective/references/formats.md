# Formats

A format is an interchangeable container for stages 2 and 3 — it shapes *how* data gets collected and
clustered. It does not change the five-stage spine in [`process.md`](./process.md).

**Vary the format deliberately.** Running the same one forever is an anti-pattern in its own right
(see [`anti-patterns.md`](./anti-patterns.md)): the prompts stop provoking anything new and
people fill them in on autopilot. Rotating the format is the cheapest way to surface a different
slice of the same period.

## The catalog

| Format | Prompts | Best for | Typical length |
|---|---|---|---|
| **Start / Stop / Continue** | What should we start doing? Stop? Keep doing? | Process changes. The most direct route to actions — the prompts *are* actions | 45 min |
| **Went Well / To Improve** | What went well? What could be better? | The general default; safe when there is no specific angle to take | 45 min |
| **4Ls** | Liked · Learned · Lacked · Longed for | Learning-heavy periods — new tech, new domain, a spike | 45–60 min |
| **Mad / Sad / Glad** | What made you mad? Sad? Glad? | Morale and friction; when the team dynamic feels off but nobody has named why | 45 min |
| **Sailboat** | Wind (pushing us forward) · Anchor (holding us back) · Rocks (risks ahead) | Blockers and enablers, and the only common format that looks *forward* at risk | 60 min |
| **Timeline** | Walk the period chronologically, marking events high/low | Complex periods, incidents, or anything where sequence and causation matter | 60 min |

## Choosing

Pick from what the period actually was, not from a rotation schedule:

- **A messy period, an outage, or a bug that took several attempts** → **Timeline**. Causation is the
  question, and causation is visible in sequence. Nothing else surfaces "we broke it here and did not
  notice until three days later."
- **Process feels wrong, output feels fine** → **Start / Stop / Continue**.
- **New territory — a library, a platform, an unfamiliar domain** → **4Ls**. "Lacked" and "Longed
  for" are the prompts that surface missing tooling and missing docs.
- **Something is off and nobody can name it** → **Mad / Sad / Glad**. Emotional data is data.
- **About to enter a risky stretch** → **Sailboat**, for the rocks.
- **Nothing in particular; regular cadence** → **Went Well / To Improve**, and consider whether the
  cadence itself is producing anything.

## Solo adaptation

Every format works solo; what disappears is the *social* machinery around it, not the prompts. Dot
voting becomes ranking. Silent brainstorming becomes writing before reading the evidence back. The
prompts themselves keep working because their job is to make you look at the period from an angle you
would not have picked. See [`evidence-sources.md`](./evidence-sources.md).
