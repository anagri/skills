# Data layer

Covers SKILL.md rules 13–17: ownership, derived stores, schema and migrations, D1 as the control
plane, latency and cost, platform limits, R2, DO SQLite, and user-data deletion. For D1, R2 and DO
APIs, see the `cloudflare` and `durable-objects` skills. This file covers where data lives, who
writes it, and how to keep it correct on a database you cannot reset.

Running example: **acme** ingests documents, enriches them and indexes them for search. The
primary D1 is `{env}-acme-db` (binding `DB`). The derived search D1 is `{env}-acme-search`
(binding `SEARCH_DB`). R2 holds blobs.

## 1. Ownership: choose a model and write it down

Every project picks one model per database and records it in the root `AGENTS.md`, along with the
test that enforces it.

**Option A: one schema owner plus tenant workers.** One deployable (`w-app`) owns the schema: its
binding is the only one that sets `migrations_dir`. Other workers (`w-admin`, `q-consumer-enrich`,
`cron-reaper`) bind the same database as tenants. They read and write through the shared `core`
storage module and never run DDL.

**Option B: a database per service.** Each service owns its own D1 and its own migrations. Data
crosses service boundaries only through id-only queue events, which feed local projections, or
through RPC (`WorkerEntrypoint`). There are no cross-database joins.

| Criterion | Favors A (shared owner) | Favors B (per service) |
|---|---|---|
| Team / deploy cadence | one team, deploys together | separate teams, independent release trains |
| Reads need joins across domains | yes, and they are frequent | rarely; projections are acceptable |
| Consistency needs | one transaction or `batch()` across domains | eventual is fine |
| Size / contention | well under the per-DB size cap; write load is modest | one domain's writes would starve the others (a D1 database runs queries one at a time) |
| Blast radius | a bad migration hurting every worker is acceptable | it must stay isolated |
| Ops overhead | one migration chain | N chains, N backfill suites, N consistency tests |

Default to **A** for one team shipping one product. Move a domain to B when it hits a contention or
blast-radius trigger. The same pressures drive a worker split (see topology).

### Option A invariants

- **Rule:** exactly one wrangler config sets `migrations_dir` for each database.
  Why: two owners produce two migration ledgers for one schema.
  Check: `grep -l '"migrations_dir"' apps/*/wrangler.jsonc` returns one file per database.
- **Rule:** every tenant has a **no-DDL test**. It boots the deployed configuration against an
  empty database and asserts that no table was created. Put each in its own test file, because
  module-level memoized init can make a second assertion in the same file vacuous.
  Why: a tenant that "helpfully" creates its schema at boot puts DDL on a request path in
  production (see §4 and [bindings-and-config §8](bindings-and-config.md#8-no-io-before-routing-bounded-success-only-init-rule-12)).
  Check: every app that binds `DB` without `migrations_dir` has a `no-ddl.test.ts`. Cover every
  tenant, not only the obvious ones.
- **Rule:** keep a per-table **write-ownership map**. A tenant writes only the tables it owns
  (`admin_*` for `w-admin`). It forwards privileged writes on owner tables (delete a user, purge
  content) to the owner over RPC, and both sides authorize.
  Why: two access styles writing one table drift apart in validation and side effects (index
  events, footprint lists).
  Check: grep tenant code for `INSERT|UPDATE|DELETE` against table names outside its prefix.
- **Rule:** keep privacy in the schema. Tables for anonymous or demo traffic have no `user_id`
  column, so no query can join them to an account.
  Why: a privacy promise held only by query discipline breaks with the first careless join.
  Check: the footprint completeness test (§10) lists these tables as exempt with that reason.

## 2. Derived stores: single writer, rebuildable, no triggers

A derived store is anything computable from the source of truth: a search index, aggregates,
caches, rollups.

- **Rule:** each derived store has exactly **one writer**, normally a `q-consumer-*`. Producers
  emit id-only events. The writer re-reads the source row by id before writing, so a stale payload
  can never be indexed.
  Why: two writers race and diverge; a payload-carrying event indexes whatever was true at send time.
  Check: only the writer's wrangler config binds the derived DB (or only it holds write access);
  grep producers for the derived table names returns nothing.
- **Rule:** never maintain a derived store with a DB trigger, and never put an FTS or index table
  in the primary database. Why: triggers tie the store's engine to SQLite, slow every source write,
  and route around the port. A trigger-maintained FTS table in the primary DB had to be moved back
  behind the queue.
  Check: the migrations test fails on `CREATE VIRTUAL TABLE … fts`, and on any trigger that writes
  to an index table, in a primary-DB migration. Strip comments before matching.
- **Triggers are allowed for materialized columns**, such as `sources.document_count` or
  `sources.last_published_at`. Those are data: they live in the same DB, move with it, and replace
  a correlated `COUNT(*)` on a hot read.
- **Rule:** every derived *table* has a rebuild command (`pnpm reindex:documents`,
  `pnpm reindex:sources`) that re-emits events through the same queue. Why: a project had a
  rebuild for one of its two indexes. A lost DB, an FTS column change (an FTS5 table cannot add or
  drop columns) or an engine swap would have left the other index empty.
  Check: list every table in the derived DB, then confirm each has a rebuild script.
- **Rule:** the derived DB's schema evolves through a recorded mechanism: its own
  `migrations_dir`, or an idempotent `init()` run **only by its single writer** that stamps a
  `schema_version` row. Never rely on one-off SQL recorded in a commit message.
  Why: an unrecorded schema change cannot be replayed on a rebuilt or new-environment DB.
  Check: every DDL statement for the derived DB lives in its migrations dir or its `init()`.
- **Reads take two steps:** the index returns ranked candidate ids, and the primary DB filters them
  by visibility. A corpus-wide index makes that second step the privacy boundary, so test it.

The event is the id-only `IndexMessage` union declared once in `contracts`
([packages-and-contracts §3](packages-and-contracts.md#3-wire-types-one-home-id-only-evolved-safely-rule-6)).

## 3. Schema tooling: Drizzle by default

```ts
// apps/w-app/drizzle.config.ts: the config sits with the schema owner (full file: example-layout §8)
import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "../../packages/core/src/storage/schema.ts", // schema code lives in core, imported by every tenant
  out: "./migrations",                                  // == the owner's migrations_dir
});
```

```jsonc
// apps/w-app/wrangler.jsonc (repeat in every env: d1_databases is non-inheritable)
"d1_databases": [{
  "binding": "DB", "database_name": "prod-acme-db", "database_id": "<uuid>",
  "migrations_dir": "migrations"
  // if your drizzle-kit writes one folder per migration (NNNN_name/migration.sql):
  // "migrations_pattern": "migrations/*/migration.sql"
}]
```

Flow: edit `schema.ts`, run `drizzle-kit generate`, review the SQL, then
`wrangler d1 migrations apply <db> --local` (or `--remote --env <env>`). Wrangler records applied
migrations **by name** (path relative to `migrations_dir`) in `d1_migrations`, never by content.
`migrations_pattern` is a glob relative to the wrangler config and defaults to
`${migrations_dir}/*.sql`; set it when your drizzle-kit version emits one folder per migration
(recent versions name those folders by timestamp, not by ordinal). Check the layout your version
emits before choosing.

- **Hand-written SQL goes in a custom migration** (`drizzle-kit generate --custom --name=…`):
  backfills, materialized-column triggers, and anything drizzle's DSL cannot express.
- **There is one schema source.** Tests build fresh DBs by **applying the migration chain**, never
  from a second "current schema" DDL. (In the Workers Vitest integration: `readD1Migrations` in the config and
  `applyD1Migrations(env.DB, env.TEST_MIGRATIONS)` in a setup file. In Node: replay the files in order.)
  If a project keeps a second fresh-DB builder anyway, a drift test must diff `sqlite_master`
  object by object against the replayed chain.
- **Drop to raw SQL for perf-critical shapes:** hot list queries, `EXISTS` scoping, FTS, anything
  whose query plan you pin (§6). Keep it inside `core/storage`, behind the same port, and give it a
  plan test. D1 bills for rows read, so SQL on hot paths is a cost surface.
- `drizzle-kit generate` output is a derived artifact. `check` reruns `drizzle-kit generate` and
  fails if `git status --porcelain apps/w-app/migrations` is non-empty (a schema edit with no
  committed migration produces a new, untracked file that `git diff` alone misses).

## 4. Migration rules

Production data is never reset. `dev` and local databases are disposable rehearsals: wipe them and
re-seed when a migration misbehaves there, so that prod never sees the misbehavior.

| Rule | Why (failure prevented) | How to check |
|---|---|---|
| **Append-only, comments included.** Never edit an applied migration; add the next number. | An edited file never re-runs, so prod and fresh DBs diverge silently. A rule with no carve-out is easier to keep than one with an exception to argue about. | `git diff --diff-filter=MDR --name-only <last-pushed-main> -- '*/migrations/*'` is empty; run it in the local `check` |
| **Unique ordering prefixes** (ordinal or timestamp). | Ordering is by name, and a duplicate prefix makes order and `from`/`to` bounds ambiguous. | Lint in the migrations test. Grandfather existing duplicates by full name, not by a threshold. |
| **Destructive DDL carries a marker.** `DROP TABLE` / `DROP COLUMN` / table rebuilds need `-- ALLOW-DROP: <reason>`. | Irreversible prod DDL needs a written justification in the diff. | Lint: every destructive statement has a marker in the same file. |
| **Backfill every column a read depends on.** | `ADD COLUMN` leaves existing rows NULL. A read that filters or sorts on the column is correct on fresh DBs and wrong in prod. | Review: every new column a read uses has an `UPDATE` in the same or the next migration. |
| **Backfill test from the previous schema.** | It proves the backfill reaches rows that already exist. | Apply migrations `{ to: N-1 }`, insert prod-shaped rows, apply `{ from: N }`, assert the values. |
| **Write-path test for every new column.** | A migration once added a column that nothing ever wrote. | Run the production write path, then assert the column is non-NULL. |
| **Values SQL cannot compute: mark stale and refetch.** | Only the upstream API knows the value, and inventing a default is lying. | The migration sets `metadata_version = 0`. The app re-enriches rows below `CURRENT_VERSION`. A test asserts the marker. |
| **No test-only tables in the chain.** | A fixture table reached production because fresh-DB init ran everything. | Fixtures live behind the fake layer or in seed code, never in migrations. |
| **Migrate persisted local DBs before boot.** | A persisted local D1 is an existing database: a new pull plus `vite dev` fails with `no such column`. | The `dev` script runs `wrangler d1 migrations apply --local` explicitly, not through a skippable `predev` hook. |
| **No schema work on a request path in deployed envs.** | A request-path `init()` queued DDL behind a long writer, its memoized promise never settled, and about half of production's API hung. | A test asserts zero D1 calls before routing (rule 12). |

**Stale world-claims kill migrations.** A doc that said "no production data yet" led an agent to
change only the fresh-DB DDL (`CREATE TABLE IF NOT EXISTS`), which does nothing to an existing
table. Date every world-claim ("checked 2026-10-03"), and re-verify the release stage before any
schema change.

## 5. D1 as the control plane

State, locks, budgets and status live in rows. Queues are disposable work lists of ids. The UI reads
rows.

**Single-flight is one conditional write.** Do not read then write, and do not rely on Workflow
instance ids alone. Instance-id dedupe is only a secondary guard.

```ts
// core/storage/fetch-jobs.ts: claim, or take over a stale claim, in one statement.
// The fetch_jobs row is created at ingestion (state 'idle'); a missing row means "not claimable".
export async function tryBeginFetch(db: D1Like, docId: string, now: number, staleBefore: number) {
  const row = await db
    .prepare(
      `UPDATE fetch_jobs SET state = 'running', started_at = ?1
       WHERE doc_id = ?2
         AND (state IN ('idle','done','failed') OR (state = 'running' AND started_at < ?3))
       RETURNING doc_id`)
    .bind(now, docId, staleBefore)
    .first<{ doc_id: string }>();
  return row !== null; // false → someone else holds it; ack and return
}
```

- **Status rows:** one row per unit of in-flight work (`queued|running|done|failed`, `updated_at`).
  The UI polls them only while work is in flight. Every "in progress" state has a reaper
  (`cron-reaper`) or the stale takeover shown above.
- **Ledgers:** budgets and credits are append-only rows in **integer micro-units**, never floats.
  The balance is `SUM(amount)`. A debit is a guarded insert, so it cannot overdraw under a race:

```sql
INSERT INTO budget_ledger (account_id, amount, reason, created_at)
SELECT ?1, -?2, ?3, ?4
WHERE (SELECT COALESCE(SUM(amount),0) FROM budget_ledger WHERE account_id = ?1) >= ?2;
-- meta.changes === 1 → debited; 0 → insufficient
```

Read `meta.changes` only on tables without triggers (see §7).

## 6. Latency and cost model

- **Serial round trips dominate.** The primary sits in one region, and a Worker far from it pays a
  full network hop per sequential query. Model latency as `base + hop × serialWaves`. Measure your
  own hop cost; do not guess it.
  - Issue independent reads together: `Promise.all`, or one `db.batch([...])`, which is a single
    round trip.
  - Never write on a read path. Defer bookkeeping writes with `ctx.waitUntil` (short writes only)
    or a queue.
  - Edge-cache anonymous reads. Read replication (the Sessions API) is a separate decision; see the
    `cloudflare` skill.
- **Assert round-trip counts, not timings.** Wrap the driver to count *waves*: concurrent statements
  count as one wave, and a `batch()` counts as one. Pin the count per endpoint and per consumer
  batch.

```ts
it("GET /api/state costs one D1 wave", async () => {
  const db = tracedD1(memoryD1());
  await handleState(deps({ db }), userId);
  expect(db.stats.waves).toBe(1);
});
```

  Log `db_waves`, `rows_read` and `rows_written` per request and per consumer batch. D1 returns
  rows read and written in result `meta`.
- **Cost is rows read, not rows returned.** A query that scans 10k rows to return 1 is billed for
  10k.
- **Pin query plans.** Record the SQL the storage layer actually issues and assert
  `EXPLAIN QUERY PLAN`: the intended index is used, there is no `SCAN` of large or membership
  tables, and no `USE TEMP B-TREE` appears on hot sorts. Plans depend on schema shape, which an
  in-memory SQLite reproduces. Name the cost each pin protects (a 60s poll, a cron tick).
- **FTS5:** address rows by integer rowid, keeping a `doc_id → rowid` map table. A delete keyed on
  an `UNINDEXED` column scans the whole virtual table on every write.

## 7. Limits the local drivers do not enforce

`better-sqlite3`-backed fakes, and partly Miniflare, accept queries that real D1 rejects. Each row
below is a limit that real projects have hit only after deploy. Values are from the D1 limits page
as of 2026-10. **Re-check current limits.**

| Limit (real D1) | Value | Guard |
|---|---|---|
| Bound parameters per statement | 100 | Chunk helper with a **required** `reservedBinds` argument. Test the binds of the issued SQL. |
| `LIKE` / `GLOB` pattern length | 50 bytes | Use `instr(lower(col), lower(?))` for substring search, and put a `.max()` on every search input schema. |
| SQL statement length | 100 KB | Never inline large values; bind them, or move them to R2. |
| Row / string / BLOB size | 2 MB | Cap text bytes in D1 and archive the full payload to R2 (§8). |
| Queries per Worker invocation | 1000 on paid, 50 on free | Count waves and statements per consumer batch. |
| `meta.changes` | Observed to include rows touched by triggers | Do not use `changes` as the single-flight signal on a table that has triggers. Use `RETURNING`. |

- **Rule:** the test driver enforces what it can (bind count, `LIKE` length, statement bytes) and
  throws D1's error text. Keep a written list of the limits it still misses, each with an
  assertion. Why: a 100-id chunk plus one extra bind made 101 parameters, which passed locally and
  broke a broad search in production.
- Log the error `cause`. ORM wrappers ("Failed query") hide the D1 message that names the limit.

## 8. R2: blobs in R2, keys in D1

- **Rule:** anything unbounded (payloads, archives, media) goes to R2. D1 stores the **key**, plus a
  byte-capped prefix only if a read needs it. Readers build URLs from the key
  (`${PUBLIC_MEDIA_URL}/${key}`).
  Why: a multi-MB value in one D1 cell failed every write, and deterministic job ordering then
  served the same failing item first every time, blocking the queue behind it.
- **Ship the reader with the archive.** When D1 holds a truncated prefix, store `truncated = 1` and
  `archive_key`. The read path rebuilds from R2 when the flag is set and degrades to
  `complete: false` if the object is missing. An archive nothing read went unnoticed for weeks.
  Check: a test truncates a row, writes the archive, and asserts the read returns the full value.
- **Mirror external media at ingestion,** with stable keys (`sources/{id}`, `documents/{id}`). Never
  fall back to third-party URLs on read. Log mirror failures with a reason, because a swallowed
  `catch` makes a quota problem look the same as a transient one.
  Check: grep read paths and DTO mappers for third-party media hosts; there should be none.
- **Decide the GC policy when you create the bucket:** R2 lifecycle rules for prefixes that expire,
  or a reaper that deletes objects whose keys no row references. "Never deleted" must be a recorded
  decision, not a default.
  Check: every bucket in wrangler config has a GC line (lifecycle rule or reaper) in `AGENTS.md`.
- In local and e2e there is no public R2 host, so serve keys through a Worker route that is enabled
  only in local/test.

## 9. DO SQLite for hot per-entity state

- **Rule:** pick the store by contention profile. Large, frequently rewritten, per-entity state
  (chat transcripts, collaborative docs, per-user agent state) goes in Durable Object SQLite. Each
  object has its own database, so it never contends with the shared D1, which serves every other
  read.
- D1 keeps a small **index row** per object (`agent_sessions(id, user_id, message_count,
  updated_at)`), so the app can enumerate objects and the reaper or account deletion can reach each
  one and call `deleteAll()`.
  Why: a DO with no D1 index row is unreachable by deletion and invisible to the app.
  Check: the code path that first writes to a DO also upserts its index row; the footprint test
  covers the index table.
- For DO class migrations and storage APIs, see the `durable-objects` skill.

## 10. User footprint and deletion

When the schema has no FKs, or has FKs without cascades, "everything belonging to a user" is a
list.

```ts
// core/storage/footprint.ts: purge order (children first)
export const USER_FOOTPRINT_TABLES = [
  "document_annotations", "saved_searches", "budget_ledger",
  "agent_sessions", "sessions", "oauth_tokens", "users",
] as const;
export const FOOTPRINT_EXEMPT: Record<string, string> = {
  login_states: "PKCE handshakes; expire in 10 min, purged by cron-reaper",
};
```

- **Rule:** one list drives both the deletion preview and the purge. Tenants forward deletion to the
  owner over RPC and never reimplement it. DO storage and R2 objects are purged through their D1
  index rows.
- **Rule:** a **completeness test** introspects the schema. Every table with a user-key column
  (`user_id`, `owner_id`, …) is either in `USER_FOOTPRINT_TABLES` or in `FOOTPRINT_EXEMPT` with a
  reason. Why: a test that derives its expectations from the list itself cannot catch a table
  missing from that list, and one user-keyed table was missing in exactly that way.

```ts
it("every user-keyed table is purged or explicitly exempt", async () => {
  const db = await freshDbFromMigrations();
  const tables = await userKeyedTables(db); // sqlite_master + pragma_table_info, col IN ('user_id', ...)
  const covered = new Set([...USER_FOOTPRINT_TABLES, ...Object.keys(FOOTPRINT_EXEMPT)]);
  expect(tables.filter((t) => !covered.has(t))).toEqual([]);
});
```

- Every new table or column adds to this list or to the exemption list (see SKILL.md, *Adding X*).
