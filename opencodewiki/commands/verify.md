---
description: Check wiki health — conformance, links, diagrams, coverage — with no model cost
allowed-tools:
  - Bash
  - Read
---

# opencodewiki:verify

A health check that costs nothing but a subprocess. No model work, no fan-out. Run it freely —
after an init, after editing a page by hand, or before trusting the wiki for a piece of planning.

```bash
opencodewiki report --json
```

Exit codes: `0` clean, `1` tool or usage error, `2` findings, `3` nothing to do.

## Reading the report

Some fields are pass/fail; others are quality signals that no linter can fix for you. Both matter.

| Field | What it tells you |
|---|---|
| `okf.invalidCount` | Conformance failures. Should be `0` — `opencodewiki fmt` repairs most. |
| `okf.needsGrounding` | Pages whose front matter the tool synthesized. Each needs a real `type`, `title` and `description` written from the page body. |
| `okf.distinctTypes` | **A quality signal.** One value across the whole wiki means `type` carries no information and every page looks alike to a retriever. |
| `okf.trust` | unverified / machine-confirmed / human-reviewed, derived from `verified`. A wiki that has never been verified is all `unverified`. |
| `okf.stale` | Pages past their `stale_after` date. |
| `links` | Broken internal links and heading anchors, including links into repository source — a page citing a file that no longer exists is a stale claim. |
| `mermaid` | Invalid fences, plus which validator ran. `heuristic` means the optional mermaid package is absent and the check is weaker than it looks. |

## Reporting to the user

Lead with what they would act on. A clean report is one line — do not pad it into a table.

When there are findings, separate the two kinds, because they need different responses:

- **Mechanical** (conformance, links, diagram syntax) — offer `opencodewiki finalize`, which repairs
  what can be repaired deterministically.
- **Substantive** (pages needing grounding, one distinct type, everything unverified) — these need
  `/opencodewiki:update` or a QA pass. Say so rather than implying `finalize` will fix them.

If `mermaid.parser` is `heuristic` and the wiki has diagrams, mention that the check is the
label-safety heuristic rather than the real grammar, and that `npm i -g opencodewiki` (without
`--omit=optional`) upgrades it.
