# Governance for agent-maintained repos

Rules 27–29 in SKILL.md. A Cloudflare monorepo with several deployables is mostly maintained by
coding agents. Agents follow what they read and skip what nothing enforces, so governance here
means two things: **instruction files that stay true**, and **gates that run on every change,
locally**. Every principle below has a check you can run.

## 1. One canonical instruction file, read by every agent

**Rule.** `AGENTS.md` at the repo root is canonical. `CLAUDE.md` is a one-line import (or a
symlink), so Claude Code, Codex, Cursor and others all read the same rules.

```md
<!-- CLAUDE.md, the whole file -->
@AGENTS.md
```

Or `ln -s AGENTS.md CLAUDE.md`. Use the import when Claude-only additions might be needed later.

**Why.** When there are two hand-kept files, one of them ends up holding the rules. Every other
CLI then works with none of the migration, single-writer or trunk rules. In one production repo,
`AGENTS.md` held only a block about a tool that was never wired up.

**How to check.**
```sh
test "$(cat CLAUDE.md)" = "@AGENTS.md" || test -L CLAUDE.md
find . -name CLAUDE.md -not -path ./node_modules/\* | while read f; do
  d=$(dirname "$f"); test -f "$d/AGENTS.md" || echo "orphan $f"; done
```

### Scoped files only where a directory has its own traps

**Rule.** Add `apps/<x>/AGENTS.md` or `packages/<x>/AGENTS.md` only if an agent working in that
directory would otherwise break something it cannot see from the code. Typical cases:
- the schema source is paired with migrations
- a module is written only by one consumer
- an app is archived and must not be deleted or rewired
- an e2e harness has a non-obvious recipe

A scoped file states its traps and then defers to the root ("Everything else follows the root
AGENTS.md"). It never restates the root.

**Why.** A scoped file that copies the root drifts away from it. In one cleanup pass, the root file
was restating two guides in more depth than the guides themselves. Removing the duplicated lines
made it shorter *and* more complete.

**How to check.** No scoped file repeats a root heading:
`git ls-files '*AGENTS.md' | xargs grep -h '^## ' | sort | uniq -d` prints nothing.

### Template: root `AGENTS.md`

```md
# acme — working agreements

## Commands
pnpm check        # THE gate: lint, typecheck, every regen-and-diff, every check:deploy
pnpm test:unit    # node + workerd tests
pnpm test:e2e     # Playwright; sequential (fixed ports)
pnpm dev          # one vite dev: w-app + auxiliary workers
Local `pnpm check` + relevant tests is the gate. CI re-runs `pnpm check`; it adds nothing.

## Repo map (derived — `pnpm repo-map`; do not hand-edit between the markers)
<!-- repo-map:start --> …generated table of apps/* and packages/* with one-line descriptions… <!-- repo-map:end -->

## Release stage — last checked 2026-10-01 (re-check before relying on it)
Production is live with real user data. Schema changes ship as migrations + backfill.

## Rules (each names its guard)
- Migrations are append-only, comments included. Guard: `migrations.test.ts` (ordinals, schema parity).
- Only q-consumer-index writes SEARCH_DB; never index with a DB trigger. Guard: `migrations.test.ts` (no FTS objects/triggers in primary DB).
- Core never imports `cloudflare:*`, Hono, or reads `env`. Guard: biome `noRestrictedImports`.
- Test seams never reach a deployed env. Guard: `deployed-config.test.ts`.
- Trunk-based: small green commits to main. Guard: none yet (convention; promote per §9 if it slips).

## Docs
guides/ how we build · reference/ what is (code is truth) · registers/ debt + deliberate violations · archive/ frozen.
```

The order matters. Commands and the gate come first, because an agent needs them before anything
else. World-claims are fenced off and dated. Every rule names the test that fails when the rule is
broken.

## 2. Every rule names its guard

**Rule.** Write each rule in the form "*X. Guard: `<test or lint>`*". If a rule has no guard, it
is a candidate for one (§9). Write the guard's failure message for the agent that will read it:
say what drifted, why it matters, and how to fix it.

```ts
expect(freshSchema, [
  "SCHEMA (fresh-DB builder) and migrations disagree.",
  "A column added only to the fresh-DB schema never reaches production.",
  "Fix: add migrations/NNNN_<what>.sql with the same change, plus a backfill if a read depends on it.",
].join("\n")).toEqual(migratedSchema);
```

**Why.** An invariant that lived only in a source comment ("this port keeps the search engine
swappable") did not stop an agent from shipping trigger-maintained FTS tables in the primary DB.
The rule stuck once three things existed together:
- a section in the instruction file with a one-line reason
- a guard test
- a reference doc that explains how to extend the code correctly

**How to check.** `grep -c 'Guard:' AGENTS.md` should come close to the number of rules. When you
review a rule, run its guard against a deliberate violation.

## 3. Rules don't expire; world-claims do

Keep two kinds of statement apart:

| Kind | Example | Lifetime | Form |
|---|---|---|---|
| Rule | "Migrations are append-only" | permanent until the agreement changes | imperative + guard |
| World-claim | "Prod is live", "CI is off", "9 packages", the deployable list | true until the world moves | **derived**, or **dated** with a re-check instruction |

**Rule.** Derive a world-claim if you can. If you can't, date it and write the expiry condition
into the text: "*last checked 2026-10-01; a claim nothing has re-verified in months is not a rule.
Re-check it.*" A temporary note says when to delete it: "*Delete this paragraph when CI runs
again.*"

**Why.** An instruction file still said "no production release, no live data" a month after
launch. Acting on it, an agent added columns only to the fresh-DB schema builder
(`CREATE TABLE IF NOT EXISTS`). That is a no-op on the live database. The next deploy would have
thrown `no such column` across production. Dating claims helps, but it is not enough. A dated
"8 packages" line went wrong when a ninth landed. The next agent to edit the file, for an
unrelated reason, did not re-check the dated section beside its edit. **Enumerations must be
derived, not dated.**

**How to check.**
```sh
# warn on any "last checked" stamp older than 45 days
git ls-files '*AGENTS.md' | xargs grep -ohE 'last checked [0-9]{4}-[0-9]{2}-[0-9]{2}' | cut -d' ' -f3 |
  while read d; do [ "$d" \< "$(date -v-45d +%F 2>/dev/null || date -d '45 days ago' +%F)" ] && echo "stale: $d"; done
# no hand-written counts of workspace members
grep -nE '\b(one|two|three|four|five|six|seven|eight|nine|ten|[0-9]+) (packages|apps|workers)\b' AGENTS.md docs/
```

## 4. Derive instead of maintain

**Rule.** Generate every enumeration that can be computed from the repo: repo map, package list,
deployable inventory, plan index, worker list for gates. Then diff-check it in `check`. Write
generated regions between markers.

```ts
// scripts/repo-map.ts: rewrites the block between <!-- repo-map:start/end --> in AGENTS.md
for (const dir of ["apps", "packages"]) for (const name of readdirSync(dir)) {
  const pkg = JSON.parse(readFileSync(`${dir}/${name}/package.json`, "utf8"));
  rows.push(`| \`${dir}/${name}\` | ${pkg.description ?? "MISSING description"} |`);
}
```

**Why.** At agent throughput, a hand-kept per-artifact step does not slowly degrade. It stops.
Hand-dating plan files worked at low volume, then silently stopped once output
grew. A derived index plus a check gate fixed it for good. Every doc that rotted was a copied
enumeration.

**How to check.** `pnpm repo-map && git diff --exit-code AGENTS.md`. A new `apps/*` without a
`description` fails the gate.

## 5. Docs taxonomy

| Class | Holds | Changes | Rule |
|---|---|---|---|
| `docs/guides/` | how we build: conventions, recipes | slowly | must agree with root AGENTS.md; root wins |
| `docs/reference/` | what *is*: current system, per subsystem | in the same commit as the code | verified against code ("code is truth"); cite `file.ts` → `symbol()`, **never line numbers** |
| `docs/registers/` | `techdebt.md` (deferred work) and `policy-violations.md` (rules broken on purpose) | as decisions change | debt entry deleted when fixed; violation entry has a reversal cost + review trigger |
| `docs/archive/` | plans, specs, research, retros | frozen | never edited retroactively, never cited as current truth |

**Rules.**
- **Cite by symbol.** Line numbers rot on every edit, while symbols survive refactors and can be
  grepped. Check: `grep -rnE '\.(ts|tsx):[0-9]+' docs/guides docs/reference` returns nothing.
- **Root beats guide.** A guide said "tables self-apply at runtime, no migration step", which is
  the exact opposite of the root rule. A lower-precedence doc still overrides the root in the
  reader's head. When you change a root rule, grep the guides for the old wording.
- **Treat a docs sync as a review pass.** Checking reference docs against code found real
  defects: a credential written into logs, and an endpoint that never checked caller ownership.
  Schedule the sync after every major feature.
- **A register entry's exit condition must be something you can cause.** "Three green CI runs" on
  a repo whose CI is off waits forever. Write "blocked on X" with a link.
- **A plan has a lifecycle:** draft → in-flight (editable ledger) → frozen on completion. Say
  which state it is in at the top of the file.
- **Shared docs never cite per-machine state** (agent memory, local paths). Promote that content
  into `docs/` or drop the citation.

## 6. Regenerate-and-diff gates

**Rule.** Every committed derived artifact has a `check:*` script that regenerates it and fails on
`git diff --exit-code`. Wire them all into `check`.

| Artifact | Regenerate | Gate |
|---|---|---|
| OpenAPI spec + generated client types | `gen:openapi`: spec from the Hono app factory, `openapi-typescript` into `api-client` ([packages-and-contracts §4](packages-and-contracts.md#4-api-types-are-generated-never-hand-written-rule-7)) | `git diff --exit-code packages/api-client openapi.json` |
| Drizzle migrations | `drizzle-kit generate` (no new file expected) | `git diff --exit-code` + `git status --porcelain migrations/` empty; also `drizzle-kit check` for migration consistency |
| `worker-configuration.d.ts` | `wrangler types` | `wrangler types --check` (exits 1 when stale) |
| e2e seed fixtures | seed generator | `git diff --exit-code e2e/fixtures` |
| repo map / plan index | script | `git diff --exit-code AGENTS.md docs/archive/plans/index.md` |

```jsonc
// apps/w-app/package.json
"check:openapi": "pnpm gen:openapi && git diff --exit-code -- openapi.json ../../packages/api-client/src/schema.d.ts",
"check:types":   "wrangler types --check"
```

**Why.** These gates catch drift that nothing else catches. A stale client type typechecks
perfectly well against the wrong server.

**How to check.** Every committed generated path (`git ls-files | grep -E 'openapi.json|schema.d.ts|worker-configuration.d.ts|migrations/'`)
is covered by some `check:*` script; run `pnpm check` on a clean tree, then hand-edit one generated
file and confirm `check` fails.

## 7. Per-deployable gates discovered by convention

**Rule.** Each deployable declares its own gates as package scripts. Turbo runs them by name in
every package that defines them. No list of workers exists anywhere.

```jsonc
// apps/q-consumer-index/package.json (every app has the same shape)
"check:deploy": "wrangler deploy --dry-run --env prod --outdir .wrangler/dry"
```
```jsonc
// root package.json
"check": "biome check . && turbo run typecheck check:types check:openapi check:migrations check:seed check:deploy && pnpm check:repo-map"
```
Each task name must be declared once in `turbo.json` `tasks`; turbo then runs it in every package
that defines the script and skips the rest.

**Why.** CI used to list fleet workers by hand, and a new cron worker never got added. One of the
fleet's workers shipped ungated. The script already existed in the new worker, but nothing ran
it.

**How to check.** Adding `apps/<new>` should need **no** edit to CI or the root scripts. Test:
```sh
for d in apps/*/; do jq -e '.scripts["check:deploy"]' "$d/package.json" >/dev/null \
  || [ -f "$d/.no-deploy" ] || echo "ungated: $d"; done
```

## 8. Local gate ⊇ CI

**Rule.** There is one `check` command. CI runs `pnpm install && pnpm check && pnpm test`, and
nothing else that could fail. A gate that exists only in CI is a defect. Move it into `check`,
including any build it needs.

**Why.** When CI went dark, the repo moved to "local check is the gate". Tests moved over, but the
CI-only steps did not:
- the deploy dry-runs
- the build-output scan that kept test attributes, one of which once carried a bearer token into
  session replays, out of production bundles

Those steps ran nowhere for weeks, and the security-relevant one was among them. The gap went the
other way too: CI ran some regen gates for one package, while local `check` ran them for all.

**How to check.**
```sh
# every `run:` in CI must be pnpm install / pnpm check / pnpm test* (multi-line `run: |` blocks: read them)
grep -E '^[[:space:]]*-?[[:space:]]*run:' .github/workflows/*.yml | grep -vE 'pnpm (install|check|test)'
```
If a note says CI is off, it is a world-claim (§3). Give it a date and a deletion trigger, and
list every check it displaced.

## 9. Three strikes → tool

**Rule.** The third time you give the same correction ("no narrating comments", "no `env` in
core", "date that claim"), stop repeating it in prose. Turn it into one of:
- a lint (Biome rule, `noRestrictedImports`)
- a test (grep test, schema introspection)
- a script (cleanup audit, generator)
- a hook

Land the rule **in the same commit** as the sweep that fixes every existing instance.

**Why.** Prose rules that kept being re-issued kept failing, even with the rule written in the
instruction file. A sweep on its own buys one clean pass. A rule on its own leaves
counter-examples in the code for agents to copy. The symbol-citation rule landed together with
converting every existing line reference in one commit, and the grep check in §5 has kept it at zero.

**How to check.** In a retro, list corrections given more than once and the tool each one became.

## 10. Destructive operations carry an in-file justification

**Rule.** Irreversible migration DDL (`DROP TABLE`, `ALTER TABLE … DROP COLUMN`) needs a marker
comment, inside the migration file, that says why. Add the marker to the drizzle-generated SQL
before it is ever applied — never afterwards (append-only). A test enforces it.

```sql
-- ALLOW-DROP: legacy_tokens superseded by sessions in 0031; no reads since 0033
DROP TABLE legacy_tokens;
```
```ts
for (const m of migrations) {
  const body = stripSqlComments(m.sql);
  if (/\bDROP\s+(TABLE|COLUMN)\b/i.test(body)) expect(m.sql, m.name).toMatch(/^-- ALLOW-DROP: .{10,}/m);
}
```

**Why.** The reason sits next to the destructive step for a reviewer, or an agent reading
history. Data loss then becomes a visible, reviewable decision instead of a line in generated SQL.

**How to check.** The test above runs in `pnpm test:unit`; prove it by adding an unmarked
`DROP TABLE` to a scratch migration and watching it fail.

## 11. Commits and the CHANGELOG

- **Format:** `type(scope): lowercase subject`, with `!` for a breaking change. The subject says
  what the behaviour is **now**, not which files moved. Check:
  `git log --format=%s -50 | grep -vcE '^[a-z]+(\([a-z0-9-]+\))?!?: '` should be 0. Enforce it
  with a `commit-msg` hook in the repo.
- **The commit body is the decision record:** why, what was rejected, what still needs
  verification. Together with the plan archive and `git log -S`, this replaces an ADR folder.
- **Topology changes get their own commit:** a new or split deployable, a moved package, renamed
  bindings. Don't mix them with feature work. Bisects and reverts then stay clean.
- **A rule lands with its cleanup** (§9). Changes to instruction files go through the same
  convention as code. Human bulk commits that edit `AGENTS.md` without a reason erase the record.
- **CHANGELOG:** after every user-visible change, add an entry under `## [Unreleased]`
  (Added / Changed / Fixed / Removed) that describes the behaviour and the reason. **Cut
  `[Unreleased]` into a dated section on each production deploy.** An Unreleased section that
  never gets cut can't answer "what changed since the last deploy". Check: the newest dated
  heading is no older than the last prod deploy.

## 12. Checked-in agent config is portable

**Rule.** Anything committed under `.claude/`, `.cursor/`, `.codex/` or `.agents/`, and every git
hook, runs on a fresh clone and in a cloud session. That rules out:
- absolute personal paths
- binaries that are not in the repo's devDependencies
- dependence on gitignored or locally built artifacts (graphs, indexes, caches)

An optional local tool belongs in personal settings, not in shared hooks. A skills lockfile must
match the installed skills.

**Why.** In one production repo, a shared hook called a binary that existed only on one developer's
machine and pointed agents at a gitignored, stale local index. On a fresh clone
that is either a hard failure or a confident pointer to stale context. That is worse than no
hook.

**How to check.**
```sh
grep -rnE '/(Users|home)/[^/]+/' .claude .cursor .codex .agents .husky .githooks 2>/dev/null
git check-ignore $(grep -rhoE '[a-zA-Z0-9_./-]+\.(json|db|sqlite)' .claude/settings.json) 2>/dev/null
```

## Audit summary

| Check | Pass condition |
|---|---|
| Canonical file | `CLAUDE.md` is `@AGENTS.md` or a symlink; root `AGENTS.md` has Commands, gate, rules |
| Guards | every rule names a test, lint or script |
| World-claims | derived between markers, or dated with a re-check / delete trigger |
| Docs | the four classes; no `file:line` in guides/reference; registers have causable exits |
| Regen gates | OpenAPI + client, drizzle, `wrangler types --check`, seeds, indexes all in `check` |
| Convention gates | every `apps/*` has `check:deploy` (or an explicit opt-out); no worker list anywhere |
| Local ⊇ CI | CI runs only install / check / test |
| Three strikes | repeated corrections became tools; the rule landed with its sweep |
| Destructive DDL | marker + test |
| Portability | no personal paths or gitignored dependencies in checked-in agent config or hooks |
