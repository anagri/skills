# Refactor and migration playbooks

Covers the **Refactoring / migrating** mode in SKILL.md. Each playbook is a sequence of phases.
Every phase ends in a **gate**: the local `check` plus the tests named for that phase, run green
before you commit. For product APIs, see the `cloudflare`, `wrangler` and `workers-best-practices`
skills. This file covers the order of moves and the invariants that keep each move safe.

Running example: **acme** ingests documents, enriches them and indexes them for search. Deployables:
`w-app` (SPA + API), `w-admin`, `q-consumer-enrich`, `q-consumer-index`, `q-consumer-analytics`,
`wf-vendorx-fetch`, `cron-reaper`, `pages-website`. Packages: `contracts`, `core`, `api-client`,
`test-utils`.

## Rules that apply to every playbook

| Rule | Why | How to check |
|---|---|---|
| **Pin behavior before you move it.** Write or locate a test that fails if the moved code changes behavior, and confirm it is red against a deliberately broken version. | A refactor with no pin is a rewrite you cannot verify. | The phase's commit message names the pinning test; break the code under it once locally and watch it go red. |
| **One topology change per commit.** Adding a deployable, moving a consumer registration and deleting a branch are separate commits. | A deployable deleted inside a "fix(lint)" commit is invisible to review and to `git log --grep`. | `git show --stat HEAD` touches one `wrangler.jsonc` topology concern. |
| **Zero-behavior-change first, improvements after.** A move commit changes no SQL, no wire shape, no response body. | Mixed commits make a regression unbisectable. | The sorted set of SQL-bearing lines is identical before and after: `diff <(git grep -hE 'SELECT\|INSERT\|UPDATE\|DELETE' HEAD~1 -- packages apps \| sort) <(git grep -hE 'SELECT\|INSERT\|UPDATE\|DELETE' HEAD -- packages apps \| sort)` is empty. |
| **Copy topology, not internals.** When a new deployable mirrors an existing one, copy its shape (entrypoint shell, composition root, wrangler envs, test layout), not its private code. | Copied internals drift within one cycle; boot-time DDL got copied into two split-out workers this way. | The new app imports logic from `core`; it has no file > ~150 lines. |
| **No test-only twin.** The old code path is deleted, not kept "for the integration harness". | A twin wired by hand drifts from the deployed one and keeps passing. | `grep` the old branch name across `apps/`: zero hits after the final phase. |
| **Deploy through the one scripted release path, never ad hoc mid-migration.** That path orders migrations → owner worker → tenants. | A half-deployed topology (producer moved, consumer not) drops or double-processes messages. | Each phase is deployable on its own, and the deploy script's order is unchanged (or changed in that phase's commit). |

A cached green typecheck is not evidence after a file move. Run the gate cold (`turbo run check
--force`) at the end of every phase that moves files.

---

## 1. Split a consumer, cron or Workflow out of the main worker

Trigger: a [split trigger](topology.md#split-triggers) fired (CPU/time, blast radius, secret or
spend isolation, deploy cadence, single-writer rule, vendor dependency). Example: move the `INDEX`
queue consumer out of `w-app` into `q-consumer-index`.

**Preconditions**
- The handler is already a module over `core` (split-ready monolith). If it is inline in
  `index.ts`, do playbook 2 first.
- The message type lives in `contracts` and both sides import it.
- An integration test drives the handler through the real `queue()` entrypoint.

**Phases**
1. **Pin.** In `core`, test the handler against in-memory D1 and the real derived-store adapter:
   upsert, delete, idempotent replay. Gate.
2. **Create the shell.** `apps/q-consumer-index/` with a thin entrypoint, its composition root and
   `wrangler.jsonc`. Copy the topology of the nearest existing consumer.
   ```ts
   // apps/q-consumer-index/src/index.ts
   export default {
     async queue(batch, env, ctx) {
       const deps = compose(env);                      // composition root: parseConfig + adapters
       await handleIndexBatch(batch.messages, deps);  // core; failure helper inside
     },
   } satisfies ExportedHandler<Env, IndexMessage>;
   ```
   In every named env, repeat the non-inheritable keys: every binding, `vars`, and the `queues`
   block (the `consumers` entry with `max_retries`, `dead_letter_queue` and `retry_delay`). Keep
   `observability` identical to the sibling workers. Use the **env-qualified** queue names
   (`prod-acme-index`), never the top-level name.
   ```jsonc
   "env": { "prod": {
     "d1_databases": [{ "binding": "DB", "database_name": "prod-acme-db", "database_id": "<id>" }],
     "queues": { "consumers": [{ "queue": "prod-acme-index", "max_retries": 5,
                                 "retry_delay": 30, "dead_letter_queue": "prod-acme-index-dlq" }] }
   } }
   ```
3. **Secrets and local dev.** Secrets do not travel with a moved consumer. List every secret the
   handler reads and provision each one per env for the new worker (`wrangler secret put X --env
   prod -c apps/q-consumer-index/wrangler.jsonc`). Add a `.dev.vars.example` next to the new
   config; local secrets are per worker, not inherited from the entry app. Add it to the entry
   app's `auxiliaryWorkers` (`{ configPath: "../q-consumer-index/wrangler.jsonc" }`) so one
   `vite dev` still drains the queue locally. `wrangler deploy` of the entry app ships only the
   entry worker: the new worker needs its own deploy step.
4. **Tenant guard.** If the new worker binds a database it does not own, add `no-ddl.test.ts` in its
   own file: boot the deployed config on an empty DB, run `queue()`, and assert that no table
   exists. Confirm it is red if you add an `init()` call.
5. **Move the registration.** In one commit: remove the `consumers` entry from `w-app` in **every**
   env and keep its producer binding. Add the deploy step (or rely on the convention-discovered
   `check:deploy`). A push queue accepts exactly one consumer Worker (publishing a second one
   errors), so the two registrations cannot coexist: deploy the old owner first, then the new one.
   Messages wait in the queue during the gap. Gate: `wrangler deploy --dry-run` for both.
6. **Delete the old branch.** Remove the `batch.queue === "...-index"` branch from `w-app`. Point
   the integration pool at the real consumer, either as an auxiliary worker in the pool config or
   with its own pool test. Never keep a copy for the harness. Gate: the full test suite, plus `grep`
   finds zero references to the old branch.

**Verification**
- Dry-run deploys of both workers succeed in every env.
- After deploy: the queue backlog drains, the DLQ is empty, and the new worker's per-batch log line
  appears.
- Resource names match across configs (a cross-config consistency test, if you have one).

**Rollback.** Revert the phase-5 commit, then deploy in reverse order: remove the consumer from
`q-consumer-index` first, then redeploy `w-app` with its registration. Do the phase-6 deletion only
after one clean production cycle; after that, rollback is a revert of the deletion commit too.

---

## 2. Extract a framework-free core from route handlers

Trigger: logic is trapped in Hono handlers or one giant storage file, and a second entrypoint
(consumer, Workflow, MCP tool, admin) needs it.

**Preconditions**
- The routes have integration tests at the HTTP layer (status + body).
- `contracts` exists with the structural ports (`D1Like`, `QueueLike`, `StepLike`).

**Phases**
1. **Pin the surface.** Snapshot the public shape: route response bodies, the storage port's key set
   (`expect(Object.keys(storage)).toHaveLength(N)`), and a `satisfies Storage` on the composed
   literal. Gate.
2. **Give private helpers homes first.** List every non-exported helper the target code calls.
   Split them by **what they do**: pure arithmetic and coercion (no db), projections and SQL
   fragments, and functions that take a db and run a query. Move them into named modules. Skipping
   this step creates cycles, because every slice would import back from the file you are emptying.
   Gate.
3. **Split into slices, zero behavior change.** Each slice is `Pick<Storage, ...>` over a `D1Like`.
   ```ts
   export const documentsSlice = (db: D1Like): Pick<Storage, "getDoc" | "upsertDocs"> => ({ ... });
   export const d1Storage = (db: D1Like) =>
     ({ ...documentsSlice(db), ...jobsSlice(db) }) satisfies Storage;
   ```
   `Pick` keeps contextual typing. Without it, a method moved out of the `satisfies` literal
   silently types its parameters as `any`. Spread composition defeats excess-property checks, so
   keep the runtime key-count pin. Gate: the sorted SQL-line set is unchanged (shared rules table)
   and the pins pass.
4. **Lift handlers.** Each route becomes `parse → core.fn(deps, input) → serialize`. `core` takes
   deps, never `c.env` or `Context`. Gate: route snapshots are unchanged.
5. **Enforce the boundary.** Add Biome `noRestrictedImports` for `packages/core` banning `hono` and
   `cloudflare:*`, plus a grep test for `env.` and runtime types (`D1Database`, `Queue<`,
   `WorkflowStep`). Gate: each fails on a planted violation.

**Verification.** The pins are unchanged, the boundary lint is green, and `core` has a Node-only test
run (no workerd).

**Rollback.** Each phase is a pure move, so revert commit by commit. Never "fix forward" a phase whose
SQL diff is non-empty.

---

## 3. Move indexing from DB triggers to a queue and a single-writer derived store

Trigger: an FTS or aggregate table is maintained by triggers in the primary DB. This locks the
engine, slows writes and is untestable outside SQLite.

**Preconditions**
- A `SearchIndex` port in `core` (upsert, delete, query by ids). Reads return ranked **ids**, and
  the primary DB intersects them with the caller's scope. That intersection is the privacy boundary.
- A separate derived store (`{env}-acme-search`, binding `SEARCH_DB`). It has no migrations ledger
  in the owner app.

**Phases**
1. **Port and adapter.** Implement the adapter against `SEARCH_DB`. Test it in `core`: upsert,
   delete, re-upsert with no duplicate, and delete by a key the engine indexes (an unindexed delete
   key scans the whole index).
2. **Id-only events.** Add the id-only `IndexMessage` union to `contracts`
   ([packages-and-contracts §3](packages-and-contracts.md#3-wire-types-one-home-id-only-evolved-safely-rule-6)). Emit after **every** searchable write, at the point where the row is committed.
   The emitter is a **required** dependency: an optional one compiles into a silent no-op.
3. **Single writer.** Create `q-consumer-index` (playbook 1). It re-reads current state by id and
   writes the index, and nothing else writes `SEARCH_DB`.
4. **Rebuild command.** `pnpm reindex --kind docs --env dev` enumerates the corpus in pages and
   enqueues id-only events. The derived store has **no SQL backfill**: the rebuild is the backfill.
   Run it on dev and compare counts.
5. **Cutover migration.** Add the next numbered migration that drops the triggers and the FTS table
   from the primary DB. Mark it with the destructive-DDL justification marker. Add a migrations lint
   that fails if any migration creates an FTS object or an indexing trigger in the primary DB.
   (Triggers that maintain a materialized **column** are allowed; that is data.)
6. **Deploy, rebuild, dedupe.** Deploy order: consumer → migration → producers. Then run the
   rebuild against prod. FTS tables have no unique constraint, so events that raced the rebuild can
   leave duplicate rows. Run a one-time dedupe and assert `count(index) == count(id map)` ==
   `count(source rows)`.

**Verification.** Index row counts equal source counts, a search e2e passes, the migrations lint is
green, and `grep -ri "create trigger" migrations/` shows only column-maintenance triggers.

**Rollback.** Before phase 5, the triggers still exist: stop emitting. After phase 5, rollback is
forward-only: re-run the rebuild. Search is eventually consistent from cutover onward, so state this
in the UI contract.

---

## 4. Introduce a binding facade in phases

Trigger: e2e needs Workflows and Queues to complete synchronously, or an env flag (`INLINE_INGEST=1`)
forks the pipeline. Use it only where the facade criteria hold (UI-visible durable work, paid
calls); a worker without them keeps plain adapters in its composition root. See
[bindings-and-config](bindings-and-config.md#4-the-binding-facade-live--fake-situational-rule-10).

**Phases**
1. **Wrap (Live only).** Add `cf/service.ts` (interface), `cf/live.ts` (a thin relocation of
   today's calls, including instance-id derivation and the "instance exists" swallow) and
   `cf/factory.ts`. Behavior is identical. Gate: unit + integration suites unchanged.
2. **Migrate callers.** Route every `env.X` access through `cf`. Composition root:
   `compose(env)` → `getCloudflareService(env, cfg)` → `createApp({ cf, cfg })`. Gate: a grep test that finds no
   binding access (`env\.[A-Z_]+` naming a binding) outside `cf/` and the config parser.
3. **Fake.** First extract any gate the real path uses (e.g. `shouldProcess(storage, msg)`) into a
   pure function that **both** Live and Fake call. Then add `cf/fake.ts`: D1 and R2 stay real, and
   Workflows and Queues write the **final** D1 outcome synchronously through production storage
   functions. A real Workflow `run()` always builds a Live service. Gate: fake-outcome unit tests
   plus a fake-vs-live equivalence test (same seed → same final rows).
4. **Enable in test only.** Set `USE_FAKE_CF="1"` in the e2e env (`env.test`) only, never in a deployed env, and
   add a test that asserts no deployed config enables it. Alias the fake out of the production build
   (`define`/`resolve.alias`) and assert the built bundle contains no fake symbol. The fake writes
   shared tables, so make e2e ids per-test unique.
5. **Delete the env-flag forks.** Prove the real pipeline in a layer-2 integration test (queue →
   Workflow → consumer → read), then delete the old flag, its var and every branch. Gate: `grep`
   finds zero references to the flag.

**Rollback.** Phases 1–2 are mechanical: revert. Phase 4 is a single var flip. Delete the old fork
only after the pool test has passed on the default branch.

---

## 5. Replace hand-written client types with generated OpenAPI types

Trigger: SPAs cast responses with `fetchJson<T>()` against hand-mirrored DTOs.

**Phases**
1. **Count the drift surface.** `grep -rn "fetchJson<" apps/*/src | wc -l` and list every
   hand-declared response interface. This list is your exit criterion.
2. **Code-first spec.** Convert routes to `@hono/zod-openapi` one router at a time. Tie each response
   schema to the domain type (`satisfies z.ZodType<Doc>`). Gate: route tests unchanged.
3. **Commit the spec.** A script emits `openapi.json` offline (no server boot). `check` regenerates
   and runs `git diff --exit-code`.
4. **Generate the client** into `packages/api-client` (browser-safe, no workerd types):
   `openapi-typescript openapi.json -o src/schema.d.ts`, with `openapi-fetch` on top. Add it to the
   same regenerate-and-diff gate.
5. **Migrate call sites** router by router, deleting each mirrored interface as its last user goes.
   Gate: the count from phase 1 strictly decreases. The final phase adds a grep test that bans
   `fetchJson<` and the hand-written response types.

**Fallback** when generation is impossible for a surface: a script copies the generated types into
`api-client`. They are still generated and never hand-edited.

**Rollback.** Per router: revert its call-site commit. The spec gate stays.

---

## 6. Move long `waitUntil` work into a Workflow

Trigger: `ctx.waitUntil(longWork())`. Platform fact: `waitUntil` extends execution for at most about
30 seconds after the response (check current limits), shared across all calls in the request, and
unsettled promises are cancelled with no retry. Symptom: a poll loop restarts work that never
finishes, so large inputs never reach `ready`.

**Phases**
1. **Status row first.** Add the status/lock row (migration + backfill). Implement single-flight as
   one conditional write: `UPDATE jobs SET state='running' WHERE id=? AND state='pending' RETURNING id`.
   Delete any "restart if stale after N seconds" hack later, in phase 4.
2. **Resumable core.** Split the work into `core` functions that each do one checkpointable unit
   and take a `StepLike` port. Steps return small, serializable results (the platform caps
   non-stream step output at 1 MiB; check current limits). Put large data in R2 or D1 and return keys.
3. **Workflow shell.** The Workflow class `run()` builds the composition root and calls the core
   with the shared step wrapper (deterministic names, `undefined → null`, timing). Expected
   external failures return an outcome instead of throwing, so they do not burn step retries.
   Gate: a layer-2 integration test with Workflow introspection (sleeps disabled, step results
   mocked) runs it to a terminal state.
4. **Switch the trigger.** The route does the conditional write, then
   `workflows.create({ id: deterministicId })`, and returns. Delete the `waitUntil` call and the
   stale-restart hack.
5. **Reaper.** Every non-terminal state gets a reaper or stale takeover in the owning domain's cron.
   It recovers to the state that keeps user controls available and never produces new work.

**Verification.** The introspection test passes, an e2e drives the UI to `ready` (via the fake if
you have one), and a seeded stuck row is recovered by the reaper test.

**Rollback.** Keep the route switch (phase 4) in its own commit: reverting it restores the old path,
while the status row and Workflow stay dormant.

---

## 7. Introduce migrations to a live database built from a fresh-schema script

Trigger: the schema is applied by a `CREATE TABLE IF NOT EXISTS` script at boot or in tests, and
production now holds real data. Failure this prevents: adding a column to the script is a **no-op**
on an existing table. The first read in prod throws `no such column`.

**Phases**
1. **Correct the world-claim.** If any doc says "no production data", fix it in this commit and date
   the claim. A stale note like that nearly shipped a no-op schema change.
2. **Baseline.** Dump prod's actual schema (`wrangler d1 export <db> --remote --no-data --output
   prod-schema.sql`). Write a
   baseline migration that reproduces it with `IF NOT EXISTS` everywhere: a no-op on prod, a full
   create on a new DB. Start numbering where your migration tool expects (check how it treats a
   `0000_` file). Set `migrations_dir` in the **owner** worker only. With Drizzle, run
   `drizzle-kit generate` into that dir. If your drizzle-kit writes nested
   `NNNN_name/migration.sql`, set `migrations_pattern` (`"migrations/*/migration.sql"`; it must
   start with `migrations_dir`). For an existing DB, derive the Drizzle schema with
   `drizzle-kit pull`, then adopt the baseline as the first migration rather than letting the tool
   diff from empty.
3. **Lockstep test.** Build one DB from the fresh-schema builder and one from the migration chain,
   and compare `sqlite_schema` (tables, columns, indexes, triggers). It fails on drift. Add lints:
   unique ordinals, no edits to applied files (comments included), and a justification marker on
   destructive DDL.
4. **Remove boot-time DDL from deployed workers.** Schema creation runs only from migrations in
   deployed envs. Local and test may migrate before the server boots. Add a test that asserts zero
   D1 round trips before routing, plus a `no-ddl` test per tenant worker.
5. **First real change.** The delta and its **backfill** go in the same migration. A new derived
   column, index-feeding table or watermark is empty for existing rows until backfilled. Values SQL
   cannot compute are marked stale for the app to refetch. Backfill test: apply migrations up to the
   previous one, insert legacy rows, apply the rest, then assert the read path.
6. **Pipeline order.** `wrangler d1 migrations apply <db> --env <env> --remote` runs before the owner
   worker deploys, and tenants deploy after it. Wrangler records applied files by **name** in
   `d1_migrations`, so editing an applied file is silently ignored on prod while fresh DBs diverge.

**Platform constraints to design around** (check current docs): SQLite (and so D1) rejects
`ALTER TABLE ADD COLUMN` for a `STORED` generated column. Use `VIRTUAL`, which is still indexable. Rebuilding a table means
create → copy → drop → rename inside one migration, with `PRAGMA defer_foreign_keys = true`.

**Rollback.** None backward. A bad migration is fixed by the **next** migration. Rehearse every
migration on a dev DB that is a recent copy of prod's shape. Dev and local DBs are disposable:
wipe and re-apply.

---

## 8. Adopt AGENTS.md governance in an existing repo

Trigger: rules live in scattered CLAUDE.md files, chat history or one person's head. Agents
repeat corrected mistakes.

**Phases**
1. **Inventory.** Collect every instruction file, guide and repeated review comment. For each
   statement, classify it as a **rule** (timeless), a **world-claim** (true as of a date) or a
   **reference fact** (derivable from code).
2. **Canonical file.** Create the root `AGENTS.md` (commands, a derived repo map, a dated release
   stage, rules, a docs index). Replace `CLAUDE.md` with a one-line `@AGENTS.md` import or a
   symlink. Add scoped `AGENTS.md` files only in directories with their own traps (e2e harness,
   archived apps). Template: [governance](governance.md#template-root-agentsmd).
3. **Name the guard for every rule.** For each rule, cite its test or lint. A rule with no guard
   becomes a task: add the guard, or record it in the deliberate-violations register. Promote any
   rule you have re-issued three times to a lint, test or script now.
4. **Date or derive world-claims.** Each claim carries "last checked YYYY-MM-DD". Hand-kept counts
   and inventories (package lists, worker lists, CI steps) are replaced by a generator plus a
   regenerate-and-diff gate.
5. **Split the docs.** Use `guides/` (how we build), `reference/` (what is: verified against code,
   cited by symbol, never by line), `registers/` (techdebt, deliberate violations) and `archive/`
   (frozen). Syncing reference docs against code finds real defects; file them, do not paper over
   them.
6. **Make the local gate a superset of CI.** Diff the commands CI runs against `check`. Move every
   CI-only gate into `check`, then reduce CI to `pnpm install && pnpm check && pnpm test`. A gate
   that runs only in CI runs nowhere when CI goes dark.

**Verification**
- `CLAUDE.md` resolves to `AGENTS.md`.
- Every rule line names a guard.
- A staleness test fails on stamps older than your window (for example, 45 days).
- `check` covers every command CI runs.

**Rollback.** Docs-only phases revert trivially. Keep each new guard test, even if you revert the
prose around it.

---

## Choosing the order when several apply

1. **7 before anything that touches schema.** You cannot backfill without migrations.
2. **2 before 1.** A consumer you cannot import from `core` cannot be split cleanly.
3. **4 before deleting any env-flag fork.** The fake and the pool test replace the flag.
4. **3 after 1.** The single writer is a split-out consumer.
5. **5 and 8 are independent.** Start 8 early, because it makes every other playbook's gates
   discoverable.
