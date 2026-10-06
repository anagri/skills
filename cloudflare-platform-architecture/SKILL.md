---
name: cloudflare-platform-architecture
description: Architecture and project organization for complex Cloudflare applications built as a pnpm/turbo monorepo — multiple Workers, SPA+API apps, Queues and consumers, Workflows, cron jobs, Durable Objects, D1/R2 shared across deployables. Use when scaffolding a new Cloudflare monorepo; when adding a worker, queue, workflow, cron, database, package or app; when deciding where code, schema, bindings or wire types belong; when splitting a monolithic worker or extracting a shared core; or when auditing a Cloudflare codebase for drift and maintainability. Supplements the cloudflare, workers-best-practices and wrangler skills (APIs) with the organization layer they do not cover.
license: MIT
metadata:
  version: "0.1.0"
---

# Cloudflare platform architecture

How to organize a multi-deployable Cloudflare application so it stays maintainable as it grows.
This skill is about **where things go and which invariants hold them in place** — not about
product APIs (use the `cloudflare`, `workers-best-practices`, `wrangler`, `durable-objects`
skills or the Cloudflare docs for those), and not about provisioning or CI pipelines.

Every rule here exists because its absence caused a real failure: a shortcut that worked in-process
hit a platform limit, got extracted under pressure, and was then pinned with a test. Starting from
these rules lets a project skip that loop.

## Pick your mode

| You are... | Do this |
|---|---|
| **Scaffolding** a new project | Read [example-layout](references/example-layout.md), then [topology](references/topology.md) and [packages-and-contracts](references/packages-and-contracts.md). Create the split-ready layout and the `check` gate on day one. |
| **Adding a component** | Find the row in [Adding X](#adding-x) below and read its reference before writing code. |
| **Reviewing / auditing** | Run [audit-checklist](references/audit-checklist.md) and report findings by severity. |
| **Refactoring / migrating** | Use [playbooks](references/playbooks.md) (split a worker, extract a core, move indexing to a queue, introduce the facade). |

## The default stack (opinionated)

pnpm workspaces + turbo · TypeScript (packages consumed as source) · Hono · Zod + `@hono/zod-openapi`
· Drizzle (D1) · Biome · vitest + `@cloudflare/vitest-plugin` (formerly `vitest-pool-workers`) · Playwright ·
`@cloudflare/vite-plugin`. Swapping one piece is fine; keep the seams it sits behind.

## Core model

- **Deployables live in `apps/`, shared code in `packages/`.** A deployable is a thin shell; logic
  lives in packages.
- **Named `{platform}-{domain}-{role}`**: `w-` HTTP worker, `q-consumer-` queue consumer, `wf-`
  workflow host, `cron-` scheduled worker, `pages-` static site. Resource names are
  `{env}-{product}-{purpose}`; binding names are env-free and identical everywhere (`env.DB`).
- **Start as a split-ready monolith.** One main worker, but every queue/cron/workflow handler is its
  own module over the shared core, so splitting it out is a move, not a rewrite. Split when a
  [split trigger](references/topology.md#split-triggers) fires.
- **Ports and adapters, strictly.** The domain core imports no Cloudflare runtime types, no Hono,
  and never reads `env`. It takes structural ports from a zero-dependency contracts package.
  Tooling enforces this, not prose.
- **D1 is the control plane, queues are work lists.** State, locks, budgets and status live in
  rows; messages carry ids; the UI reads rows.
- **One writer per thing**: one schema owner per database, one writer per derived store, one
  consumer per queue, one producer per paid operation, one home per wire type.
- **Derive or gate; never hand-maintain.** Every enumeration (types, configs, inventories,
  indexes) is generated and diff-checked or discovered by convention.
- **The local `check` is a superset of CI.** A gate that runs only in CI is a defect.

## Rules

Each rule has a check an agent can run. Details and rationale live in the linked reference.

**Topology** — [topology](references/topology.md)
1. Split deployables by failure, cost and trigger domain — never one worker per queue by reflex.
   Cheap dispatch glue stays next to its orchestrator.
2. An app with a UI is one package = one worker serving SPA + API (`@cloudflare/vite-plugin`,
   `run_worker_first: ["/api/*"]`, mount path only on the router basename). One `vite dev` runs the
   whole fleet via `auxiliaryWorkers`.
3. Worker-to-worker privileged calls use RPC `WorkerEntrypoint` over a service binding, never
   public internal HTTP routes.
4. Entrypoints (`fetch`, `queue`, `scheduled`, Workflow `run`, DO constructor) are thin: build the
   composition root, delegate to core. Check: entrypoint files stay small and contain no SQL.

**Packages & contracts** — [packages-and-contracts](references/packages-and-contracts.md)
5. Three tiers: zero-dependency `contracts` → `core` (domain + storage + handlers) → `test-utils`
   (devDependency only). Check: `contracts` has no dependencies; `test-utils` never appears in
   `dependencies`.
6. Every wire shape (queue message, RPC method, DTO) has exactly one home that both sides import.
   Queue messages are id-only; new fields are optional and their absence is the safe default.
7. API types are never hand-written: the server generates OpenAPI, the client types are generated
   from it into a browser-safe package, and `check` regenerates and diffs.
8. Layering is enforced: Biome `noRestrictedImports` or a test bans `cloudflare:*`, Hono and `env`
   in core, and app→app imports.

**Bindings & config** — [bindings-and-config](references/bindings-and-config.md)
9. Each deployable has a composition root: `env → parseConfig → deps → core`. Parse `env` once into
   a typed config; core secrets fail fast; optional features stay closed when their config is
   missing.
10. Put a binding facade (Live/Fake) in front of bindings where local testing needs to swap them
    (UI-visible Workflows/Queues, paid or external calls). Fakes are constructible only in
    local/test.
11. Side-effecting collaborators (queue producers, emitters, workflow starters) are **required**
    parameters. An optional one compiles into a silent no-op.
12. A deployed worker does no I/O before routing. Any memoized init is time-bounded and caches only
    success.

**Data** — [data](references/data.md)
13. Choose an ownership model per project — one schema owner + tenant workers, or a database per
    service — and write it down. Either way, every derived store has exactly one writer, is fed by
    id-only queue events, has a rebuild command, and is never maintained by DB triggers.
14. Drizzle generates migrations into the wrangler `migrations_dir`. Migrations are append-only
    (comments included). Backfill every column a read depends on, and test the backfill starting
    from the previous schema. Production data is never reset.
15. Single-flight comes from one conditional write (`UPDATE … WHERE state = ? RETURNING`), not from
    read-then-write or Workflow instance ids alone.
16. Budget latency in serial D1 round trips and cost in rows read. Assert round-trip counts in
    tests, not timings.
17. Blobs go in R2 with only keys in D1. Choose DO SQLite for hot per-entity state.

**Async** — [async](references/async.md)
18. Never `waitUntil` long work: use a Workflow. Every step goes through one shared wrapper
    (deterministic names, small serializable results, timing).
19. One shared consumer failure helper: ack permanent (domain) errors, retry transient ones with
    `delaySeconds` backoff, retry per message (never the whole batch for one poison id). Every
    retrying queue has a DLQ that something consumes or alerts on.
20. Every lock or status row that work can abandon "in progress" has a reaper or a stale takeover.
21. Paid or external work goes through one producer that records intent (and debits budget) before
    enqueuing, persists the external job id inside the step that pays, and has a kill switch.

**Config & local dev** — [wrangler-and-local-dev](references/wrangler-and-local-dev.md)
22. One `wrangler.jsonc` per deployable, named envs only, non-inheritable keys repeated per env.
    Keep shared names, ids and `compatibility_date` consistent (a consistency test is cheap).
23. Migrations run before any dev server boots; local state is disposable.

**Testing** — [testing](references/testing.md)
24. Three layers by runtime: Node unit (in-memory SQLite D1), workerd integration
    (`@cloudflare/vitest-plugin`, real pipeline, deployed topology), Playwright e2e (fake durable layer,
    in-worker seeding, per-test tenancy).
25. Test seams (fakes, seed / login-as routes, `USE_FAKE_*` flags) never reach any deployed
    environment. Exclude them from the build and pin that with a test.

**Observability** — [observability](references/observability.md)
26. One logger that emits objects; one error taxonomy (domain vs transient) decides log level,
    retry and ack at every entrypoint kind; telemetry leaves the hot path through a queue.

**Governance** — [governance](references/governance.md)
27. `AGENTS.md` is canonical (root plus scoped dirs with their own traps); `CLAUDE.md` imports it.
    Every rule names the test that enforces it, and world-claims carry a date.
28. Regenerate-and-diff every committed derived artifact. Discover per-deployable gates by turbo
    convention, so adding a worker needs no CI edit. The local `check` runs all of it; CI only
    re-runs `check`.
29. A rule you have repeated three times becomes a lint, test or script.

## Adding X

| Adding | Where it goes | Must also add | Read |
|---|---|---|---|
| HTTP route | route module in the app, handler in `core` | request/response schema → regenerated OpenAPI + client types | packages-and-contracts |
| Queue | producer function in `core`, message type in `contracts`, consumer module (or `q-consumer-*`) | DLQ, failure helper, ack policy, wrangler entries in every env | async |
| Workflow | class in the owning worker (or `wf-*`), steps call `core` | step wrapper, status row + reaper, integration test with introspection | async, testing |
| Cron job | `scheduled` module in the owning domain's worker; `cron-*` only if it owns no domain | idempotent run, observable per-tick log line | async |
| New deployable | `apps/{prefix}-{domain}-{role}` | composition root, wrangler envs, `check:deploy` script, no-DDL test if it is a tenant | topology, wrangler-and-local-dev |
| Table / column | Drizzle schema + generated migration | backfill + backfill test; update any purge/footprint list | data |
| Derived store (search, aggregates) | its single writer consumer | rebuild command, id-only events from producers | data, async |
| Shared code | `packages/core` slice or a new package | subpath export per runtime surface; boundary lint | packages-and-contracts |
| Second app (admin…) | `apps/w-admin` | RPC to the owning worker for privileged writes | topology |
| External vendor | adapter behind a port in `core` | fake for local/test, cost logged per call, kill switch | bindings-and-config, async |

## Anti-patterns to flag

| Smell | Consequence | Fix |
|---|---|---|
| `await initSchema()` / any D1 call before routing | cold-start tax; a hung init takes down every request | init in migrations or behind a bounded, success-only memo; local/test only |
| DB triggers maintaining an index / FTS | engine locked in; writes slow; untestable | id-only event → single-writer consumer |
| `ctx.waitUntil(longWork())` | silently cut off, no retries | Workflow |
| Hand-written response types on the client | silent drift | generate from OpenAPI |
| Test-only twin of a consumer in the main worker | twin drifts from the deployed one | run the real consumer as an auxiliary worker in the pool |
| Optional `queue?`/`emit?` dependency | missing wiring is a silent no-op | make it required |
| Dev routes or fakes in a deployed bundle | auth bypass in a public environment | build-time exclusion + test |
| Hand-copied lists (CI steps, worker inventory, ids) | the forgotten entry is the ungated one | derive or diff-check |
| Self-healing re-enqueue loop on paid work | unbounded spend | single producer, budget debit first, reaper never produces |
| Edited applied migration | prod and fresh DBs diverge | add the next migration |

## Lessons

Read [lessons](references/lessons.md) before arguing with a rule: each one maps to a real failure
mode, with the symptom to recognize it by.
