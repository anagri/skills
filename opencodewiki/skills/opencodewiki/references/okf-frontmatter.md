# OKF v0.2 front matter

Spec: <https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md>

The CLI repairs and canonicalises this, so you cannot make a page *invalid*. What you can do is
make it *uninformative* — and that is the failure that matters, because these fields are how an
agent finds the right page without reading every page.

## Only `type` is required

Everything else is optional and a page carrying just `type` is fully conformant. That is exactly
why the optional fields need deliberate attention: nothing will complain if you skip them.

## The fields

```yaml
---
type: Feature                    # required — a descriptive concept kind
title: Order history            # human-readable display name
description: >-                  # one or two sentences, optimised for retrieval
  How order history is scoped to the signed-in account, and how the same
  endpoint serves both the UI and the API.
tags: [orders, access-control]          # cross-cutting facets, kept in English

sources:                         # what this page was derived from
  - resource: /packages/core/src/orders/   # module-granular on architecture pages
    id: orders-core
    kind: code
  - resource: /apps/api/test/orders.test.ts
    kind: test
  - resource: /docs/claude-plans/20260101-order-history-pagination.md
    id: orders-plan
    kind: plan
    title: Cursor pagination

generated: { by: opencodewiki/opus-5, at: 2026-08-14T09:00:00Z }
verified:                        # trust tier is DERIVED from this, never asserted
  - { by: process:opencodewiki-qa, at: 2026-08-14T09:30:00Z }

status: stable                   # draft | stable | deprecated
stale_after: 2026-11-14          # absolute date, not a TTL

opencodewiki:                    # producer extension: agent routing metadata
  chamber: functional            # functional | architecture
  symbols: [Orders.listForAccount, accountScope]
  invariants:
    - Account scoping is applied in the query, so no caller can read another account's orders.
  validation_commands: [pnpm --filter app test]
  change_kinds: [feature, access-control]
---
```

## The ones people get wrong

**`type`** — the spec says choose a short, descriptive kind and explicitly does *not* restrict you
to a list. Use `Feature`, `Subsystem`, `Convention`, `Data Model`, `API Surface`, `Runbook`.

A measured failure worth avoiding: on a real generated wiki, every page carried
`type: Concept`. The field was present, valid, and completely useless — every page looked identical
to a retriever. If your wiki has one distinct `type`, you have wasted the field.

**`description`** — this is what a retriever matches against, so it does more work than any other
field. Say what the page answers, not what it is about. "How order history is scoped to one account"
beats "Documentation about orders".

**`sources`** — the evidence trail. `kind` distinguishes a source file (behaviour) from a plan
(intent), which matters because they carry different weight. Cite a specific plan with a footnote
keyed to `sources[].id` when the body leans on it:

Granularity is chamber-dependent and enforced. A **functional** page cites the files it used. An
**architecture** page cites at most **ten modules** — a package root, a source subtree with a
trailing slash, a root artifact that is its own boundary, or a plan file — and never an individual
source file. `opencodewiki okf validate` rejects a file-level `resource` on an architecture page, so
this is a rule the authoring hook will enforce while you write, not a style preference.

```markdown
Cursor pagination was chosen over offset pagination.[^orders-plan]

[^orders-plan]: Cursor pagination plan
```

**`verified`** — do not write this by hand to claim a page is trustworthy. Trust tiers are
*derived*: no key means `unverified`, non-human actors mean `machine-confirmed`, and any
`human:<id>` means `human-reviewed`. The QA pass writes the machine entry; a human review writes the
human one. Asserting it yourself makes the signal worthless.

**`stale_after`** — an absolute date, so staleness is a plain comparison. Set it where a page
depends on something that drifts (an external API, a pricing table). Leave it off where the page
tracks source that the update run already reconciles.

**`opencodewiki.invariants`** — externally observable contracts, phrased so a violation is
checkable. "Account scoping is applied in the query" is an invariant. "Order history is fast" is not. On an
**architecture** page, at most three, and each must survive a rewrite of the implementing module, be
owned by this page's boundary, and constrain code that does not exist yet. A tunable constant is not
an invariant.

**`opencodewiki.symbols`** — **functional pages only.** An architecture page must omit the key
entirely: a symbol catalogue is precisely what a code-graph tool recomputes from HEAD on demand, so
storing one is duplication that drifts. Name 2–4 load-bearing symbols in the body instead.

**`opencodewiki.chamber`** — `functional` or `architecture`. Set it. Tooling derives the chamber from
the page's path when the key is missing, so an omission is not fatal, but a page that declares it is
self-describing to any consumer that has the file without the tree.

## Never

- Hand-write front matter in `index.md` or `log.md`. They are reserved documents, generated
  deterministically.
- Put a secret, credential, or a command that would print one into any field.
- Delete a key you do not recognise. Unknown producer keys must survive round trips, and the CLI
  preserves them — do not undo that by rewriting a block from scratch.
- Leave `opencodewiki_generated: true` on a page you have grounded. That marker means "synthesized,
  still needs real metadata", and it is how the repair queue finds work. Clear it by writing a real
  `type`, `title` and `description`.
