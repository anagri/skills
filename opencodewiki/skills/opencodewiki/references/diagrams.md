# Diagrams

A diagram earns its place when a relationship is genuinely easier to see than to read: a runtime
flow across components, a lifecycle, a data model, branching control flow. It does not earn its
place on a navigation page, a reference table, or a list of configuration.

## Density

Guidance that is routinely under-met: a repository wiki usually needs **several** diagrams, not one
overall. Two real generated wikis were measured and each contained exactly one diagram across the
whole wiki — the precise failure the instruction warns against.

The rule that avoids both failure modes: if a page documents a request flow, a call sequence, a
state machine, or a data model, it probably wants a diagram. Otherwise it probably does not. Do not
decorate every page to hit a number.

**That density guidance is for `functional/` pages.** The `architecture/` chamber is capped at one
diagram per page, and a call sequence is a reason *not* to draw one there — see the structural test
below.

## The structural test — architecture pages

Apply this to every node, participant and entity label:

> Does this thing exist when no code is running?

Tables, columns, deployables, datastores, queues, workspace packages and persisted lifecycle states
**pass** — they are structure. Functions, calls, steps, handlers, hooks and requests **fail** — they
are code flow, which a code-graph tool traces live and correctly, and which a snapshot in a wiki gets
wrong on the next refactor with nothing to catch it.

A diagram is allowed only if **every** label passes. In practice that permits `erDiagram` and a
topology `flowchart`; it bans `sequenceDiagram` outright, along with any `flowchart` whose nodes are
function names, files, or execution steps. A flowchart used as a reader decision tree is also banned
— that is a table.

## Choosing a type

| Type | For | Architecture chamber |
|---|---|---|
| `sequenceDiagram` | Request and runtime flows across components | **Banned** — code flow |
| `stateDiagram-v2` | Lifecycles and state machines | Allowed only if the states are persisted |
| `erDiagram` | The data model — entities and relationships | Allowed |
| `flowchart TD` | Branching control flow and decision logic | Allowed only for topology, never control flow |

Ground every participant, state, entity and relationship in inspected source. An invented
participant is an invented claim, and it is harder to spot in a diagram than in prose.

Give each diagram a one-line caption directly below it saying what it shows.

## Label safety

The CLI validates every fence and degrades a failing one to a plain `text` fence with the parser's
error attached. That keeps a broken diagram from rendering as an error block, but a degraded diagram
is still a quality failure. These rules prevent the breakages that actually happen:

- Never put a semicolon or pipe inside a node, message, or edge label.
- Never leave unescaped angle brackets in a label. Write `returns Promise of User`, not
  `returns Promise<User>`.
- In `flowchart`, quote any label containing parentheses, brackets, or punctuation:
  `A["calls foo(bar)"]`.
- In `flowchart`, never use bare `end` as a node id, and never start an id with `o` or `x` followed
  by a dash — both collide with edge-marker syntax.
- In `sequenceDiagram`, alias any participant name containing spaces or punctuation:
  `participant AS as Auth Service`.
- Never use a reserved word as a participant, alias, or node id: `note`, `end`, `loop`, `alt`,
  `opt`, `par`, `and`, `else`, `activate`, `deactivate`, `class`, `state`, `click`, `link`. A
  notification participant must be `Notifier`, not `Note`.
- Keep labels short. Explanation belongs in the caption or the surrounding prose.

When in doubt, rephrase the label. No diagram is worth a rendering failure.

## On update runs

A wrong diagram is a stale claim, not existing structure to preserve. If a source change makes a
diagram inaccurate, fix it in the same edit as the surrounding prose.

Do not regenerate a diagram that is still accurate — that is pure diff noise.

If you find a `text` fence preceded by a comment starting `opencodewiki: mermaid parse failed`, a
previous run degraded it. Repair the syntax using the error in the comment, restore the `mermaid`
fence, and delete the comment.
