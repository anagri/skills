# Default comment policy (overridable)

This is the built-in rubric. A project's own policy (CLAUDE.md, contributing
guide, or an explicit user instruction) **overrides** these defaults wherever
they conflict — these are the fallback, not the law.

The governing principle: **a comment must carry information the code itself
cannot express.** Code that is maintained partly by AI assistants makes this
sharper, not softer — redundant comments are noise that every future reader and
every future edit has to wade through, and they silently rot into lies when the
code drifts away from them. So comments have to earn their keep.

## KEEP — these justify a comment

- **A non-obvious constraint or invariant** a future reader would otherwise
  reverse-engineer (a byte-size cap, an ordering requirement, a "these two
  values must stay byte-identical" rule, a single-flight gate).
- **A workaround for a quirk or bug**, especially with an issue/PR reference —
  e.g. "miniflare drops queue-spawned Workflow writes (workers-sdk#10806)".
  The reference is load-bearing; never strip it.
- **A place where a library/API does NOT behave as advertised**, or where two
  APIs disagree — e.g. "the SDK builds redirectUri WITHOUT collapsing a
  trailing slash, while the router strips it — the two disagree". This is the
  single highest-value category; it is exactly the knowledge code can't show.
- **A discovered fact or a "why it is this way" decision** that isn't derivable
  from the code (why a tolerance is ±30s, why a fallback exists, why a field is
  nullable).
- **A critical caveat**: test-only code paths, security-sensitive ordering,
  data-shape assumptions ("epoch ms", "R2 key", "JSON-encoded").
- **Tooling directives** — these are not really comments, they change behavior:
  `eslint-disable`, `biome-ignore`, `@ts-expect-error`, `@ts-ignore`,
  `prettier-ignore`, `v8 ignore`, coverage pragmas, license headers. Never
  remove these.
- **Genuinely helpful navigation** in a large/complex file when the code alone
  is insufficient — but only when it adds insight, see the divider note below.

## REMOVE — noise, delete it

- **Restatement** of what the next line plainly says: `// increment counter`
  over `i++`; `// "/ui"` after `BASE_PATH.replace(/\/$/, '')`; `// Returns the
  user` over `getUser()` that returns a user.
- **Change/history narration**: `// added this`, `// now we also…`, `// moved
  from X`, `// re-track`, `// unchanged`.
- **Commented-out dead code** — delete it; that's what version control is for.
- **Decorative section dividers** that only echo the symbol names beneath them
  (`// ==== Section ====`, `// ---- Captions ----` directly above the captions
  symbols). BUT keep a divider if it conveys a non-obvious grouping *rationale*:
  `// shared corpus: public, api-key provenance` or `// existence-based fetch
  state` earn their place; `// ---- Captions ----` does not. When borderline in
  a large file, trim the divider down to its insight or drop it.
- **JSDoc / param / return blocks that merely echo types** TypeScript (or the
  signature) already enforces.

## TRIM — don't always delete wholesale

If a comment is half-useful, cut it down to *only* the non-obvious part. Shorter
is better, and the insight survives. Preserve meaning, references (issue
numbers, URLs), and the exact wording of any caveat you keep.

Worked example (from a real run):

Before:
```
// A fixed pixel width (main = flex:1 takes the rest). Collapse animates
// width → 0; a pixel width transitions cleanly where a percentage/flex-grow
// does not. overflow-hidden clips the content as it narrows; the left border
// drops when collapsed so no hairline lingers. Honors reduced motion.
```
After:
```
// Pixel width transitions to 0 cleanly on collapse where a percentage/flex-grow does not.
```
The kept line is the one fact a reader couldn't guess from the CSS; the rest the
classes already show.

## Hard rules

- **Never change code** — only comments. Don't touch logic, strings, or JSX
  text. (Collapsing an empty `} catch {\n}` to `} catch {}` after removing its
  comment is fine — that's formatting, not logic.)
- In **test/spec files**: keep comments explaining a non-obvious test setup, a
  timing/clock invariant, or *why* an assertion exists; remove `// arrange / //
  act / // assert` scaffolding and step narration the test structure already
  shows.
- Keep doc comments on **exported public API** only if they add non-obvious
  usage info beyond the signature.
- When in **genuine doubt** about a comment that looks like a hard-won finding,
  **keep it.** A surviving useful comment is cheap; a deleted one is gone.

## Language note

The examples are TypeScript/JSX (`//`, `/* */`, `{/* */}`), but the policy is
language-agnostic. For Python/Ruby/shell, the same judgment applies to `#`
comments and docstrings: drop docstrings that only restate the signature; keep
those documenting non-obvious behavior, units, or raised exceptions.
