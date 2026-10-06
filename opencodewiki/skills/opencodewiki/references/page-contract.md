# Page contract

What a page must contain to be worth its place. The two chambers have different jobs, so they have
different shapes — writing an architecture page in the functional shape is the most common way to
produce something that reads fine and helps nobody.

## Universal

Every page opens with OKF v0.2 front matter (see `okf-frontmatter.md`) and a single `#` heading.

**Substantive** means a reader can act on it. A passing mention, a directory listing, a source-map
row, or a paragraph of overview is *not* coverage. If everything on the page could have been
written by someone who only read the README, it fails.

Three things are always true:

- **Verify every claim before writing it.** On an architecture page, cite the module that establishes
  it. On a functional page, cite nothing — but confirm the capability is real in the product first.
  An unverified claim is a guess, and an agent cannot tell the difference. A capability the reader
  cannot actually perform is the worst thing either chamber can contain.
- **State gaps explicitly.** "The retry limit is not configurable" is useful; silence is not. Say it
  in the register of the chamber — an architecture page names what hard-codes it, a functional page
  says only that a person cannot change it.
- **One canonical home per concept.** Link to it from elsewhere rather than restating it.
  Duplicated prose drifts into contradictory prose, and then neither copy can be trusted.

## Functional pages

**Job:** describe the product, not the system. A functional page explains **what a person can do and
the value they get from doing it** — so that anyone, including someone who has never read the code,
understands what this product actually offers.

This chamber is a **capability map**, not developer documentation. Its unit is a user capability, not
a module, a screen, or a subsystem. If a page is named after a piece of machinery, it is already
wrong.

**The one test, applied to every sentence:**

> Would this sentence make sense to someone who has never seen the code, and does it describe
> something a person can do or experience?

If it only makes sense to someone who has read the source, cut it. "A worker drains a job queue" is
not a capability — nobody has ever wanted a job drained. "Your report is ready within moments, and
you can watch its progress" is the same fact told as the thing a person experiences.

**Research:** start from the user, not the tree. Work out who the audiences are and what each is
trying to accomplish, then find every capability the product actually offers them — from the screens
and actions it exposes, from what it promises publicly, and from what the plans record it setting out
to build. Verify each one is real before writing it down; an imagined capability is worse than a
missing one.

**Write in the user's language.** No file names, no function names, no endpoints, no table names, no
framework or vendor names, no code blocks. A person does not care that something is a queue.

### Budgets — hard, and mechanically enforced

| Budget | Value |
|---|---|
| Lines per page | **≤ 150**; front matter is not counted |
| Code references | **≤ 5 total**, counting front matter and prose **together** |
| Reference granularity | app, package or folder — **never a file, never a function** |
| `opencodewiki.symbols` | **absent — the key must not appear** |
| Code blocks | **none** |
| Diagrams | **≤ 1**, and only if it helps a person understand their own journey |

There is deliberately **no floor** on code references. A page that never mentions an implementation
at all is good functional writing. Plan sources do not count toward the five — they record why the
product behaves this way, which is not a pointer to code.

Shape:

```markdown
# <Capability, named as a person would say it>

**As a <who>, I want to <do X>, so that <value Y>.**

One paragraph: what this part of the product is for, in plain language.

## What you can do

The things a person can actually do here — each one an action they take, not a
feature the system has. Three to eight of them. If you cannot phrase it as
something someone does, it does not belong.

## What to expect

The rules and limits a person notices: what happens when something is slow,
empty, unavailable, or refused. What the product promises, and what it
deliberately does not do. Say the limits plainly rather than hiding them.

## Where this sits

How this connects to the rest of the product from the user's point of view —
what they were doing before they got here, and where they go next.
```

**Name pages the way a user would.** "Finding a past order", not "search subsystem".
"Exporting your data", not "export pipeline".

**A capability that does not exist gets no page and no mention.** Do not document an intended
feature, a planned one, or one you could not confirm. If a page would describe something nobody can
do, delete the page.

**Mark any internal-only area visibly** — operator or admin capabilities are real, but a reader must
never mistake them for something a customer can reach.


## Architecture pages

**Job:** let an agent place new work correctly. Given "add an X", this chamber says what kind of
thing X is, where it goes, what it reuses, what it must not do, and which existing thing to copy —
so the system stays architecturally consistent. It is about **modules and components: their
responsibilities and their interactions**, not about what the code currently does.

**The one test, applied to every sentence before you write it:**

> Could a parser reading HEAD tonight produce this sentence? If yes, delete it.

A code-graph tool answers where a symbol is defined, what calls what, what a module imports, and the
call sequence of a request. Writing those down buys nothing and guarantees drift. Write only what a
human decided, why, and what it cost — an AST records what was built, never what was considered.

**Research:** breadth. A convention is a claim about *many* files, so read enough call sites to know
it is a convention and not an accident — then state the **conclusion**, never the arithmetic. Write
"handlers live in `routes/`, without exception" and name the exceptions. A count is a claim about
HEAD that nothing will update; the exception list is the durable half, because it is what tells an
agent whether a deviation may be followed.

### Budgets — hard

| Budget | Value |
|---|---|
| Lines per page, including front matter | **≤ 180**; target 90–150 |
| Pages in the chamber | **≤ 8** |
| `sources` entries | **≤ 10**, module-granular, at least 2 of `kind: plan` |
| `opencodewiki.symbols` | **absent — the key must not appear** |
| `opencodewiki.invariants` | **≤ 3** |
| Diagrams | **≤ 1** per page |
| Inline code references | **8–12 — a floor as well as a ceiling** |

These are enforced mechanically by `opencodewiki okf validate`, which the authoring hook runs on
every write. If your page will not fit in 180 lines you have written a reference, not an architecture
page: cut the enumerations rather than requesting an exemption.

The floor matters as much as the ceiling. A page that says "there is a facade seam" without naming
`src/adapters/` sends the reader back to grep and has negative value. You are not banned from
referencing code — you are banned from *reproducing* and *enumerating* it.

Shape:

```markdown
# <Boundary>

One paragraph: what shape this part of the system has, and what that shape is for.

## The pattern

The rule an agent should follow, stated so it applies to code that does not exist
yet. Layering, dependency direction, what may write what. No counts.

## Why it is shaped this way

The reasoning, the constraint that forced it, the cost that was accepted. This is
the section the chamber exists for. If it is shorter than "The pattern", the page
is documenting the implementation instead of the decision.

## Where new work goes

By precedent: a new X lands here and registers there. Point at ONE existing
example to copy. Do not enumerate the other twelve.

## Exceptions

Places that break the pattern, and whether that is legacy or deliberate. That
distinction is what tells an agent whether the exception may be followed.

## Alternatives already rejected

Only where a plan or commit states the rejection explicitly. Never inferred
from source disagreement — an abandoned attempt and a deliberate rejection are
indistinguishable from the outside, and inventing the rationale is worse than
omitting it.

**Validation:** `<one command>`
```

Every page must carry at least one explicitly rejected alternative **or** one trade-off with a named
cost. A page with neither contains nothing a graph tool could not produce, and belongs merged into
one that does.

### Ownership — where a fact lives

A fact belongs to the one page that would have to change if the fact changed. That page states it in
full. Every other page gets **one sentence and a link** — never a bare link, never a re-derivation.

Before writing a paragraph about a module that is not this page's subject: stop. One sentence plus a
link, or delete it. "Describes another page's module" is a defect, not thoroughness.

### Forbidden constructs — check before writing the file

- [ ] No number describing the current repository: no "N of M", no "at HEAD", no occurrence counts,
      no file counts, no git-history statistics.
- [ ] No reproduced source: no interface blocks, no SQL, no config blocks, no pseudo-code.
- [ ] No table whose rows are files, symbols, handlers, endpoints, bindings, or secrets.
- [ ] No enumeration of four or more sibling symbols, in prose, list, or table.
- [ ] No line numbers.
- [ ] No product-tunable constant.
- [ ] No sequence diagram, and no diagram whose labels are functions or steps.
- [ ] No paragraph explaining a module this page does not own.

## quickstart.md

The entrypoint, written **last** because it can only route to pages that exist.

- A short orientation: what this system is, in a few sentences.
- Links to every major page — this is the navigation spine.
- The task-routing table, which is the highest-value artifact in the wiki:

| Change intent | Page | Source entry points | Key symbols | Focused tests | Minimal validation |
|---|---|---|---|---|---|

Route real change categories the repository's own history supports, not hypothetical ones. Every
cell must resolve: pages that exist, paths that exist at HEAD, commands that run.

- A `## Backlog` section for anything deliberately deferred, each entry with a source anchor and a
  one-line reason. An empty backlog is fine; a silent one is not.

## Anti-patterns

| Do not | Because |
|---|---|
| Mirror the directory tree | The tree is already navigable; this adds nothing and goes stale |
| Write a page per file | Pages are concepts, not files |
| Restate what a function does line by line | The source does that better and never drifts |
| Tabulate handlers, endpoints, symbols, bindings or files | Row-wise restatement is the same defect as line-wise; a graph tool answers it live |
| State a count of anything in the repository | Guaranteed wrong on the next commit, and nothing updates it |
| Reproduce an interface, SQL statement or config block | Two copies of one truth, one of which is already drifting |
| Document a currently-broken state or a refactor TODO | A wiki is not an issue tracker; it will outlive the fix and mislead |
| Explain a module this page does not own | Duplication multiplies edit sites and invites contradiction — link instead |
| Include line numbers | They rot on the next edit; use stable paths and symbol names |
| Create a directory for one thin page | Fold it into its parent until it earns separation |
| Hedge with "appears to", "seems to", "likely" | Either verify it or state the gap; hedged claims are unusable |
