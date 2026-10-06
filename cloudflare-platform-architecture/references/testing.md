# Testing architecture

Rules 24–25 in depth. Split tests by **the runtime each one needs**, not by size. Each layer has one
job, and some things are banned from it. Most flaky, slow or lying suites come from asking a layer
to do another layer's job.

> Package note: the Workers Vitest integration is published as `@cloudflare/vitest-plugin`
> (`cloudflareTest()` plugin). It was formerly `@cloudflare/vitest-pool-workers`, and the
> configuration API did not change. For API details, see the `cloudflare` and `wrangler` skills or
> the Workers testing docs.

## The three layers

| Layer | Runtime | Owns | Must NOT contain |
|---|---|---|---|
| **1. Unit** | Node (worker code) + jsdom (UI) | branching logic, handlers, storage queries, invariant pins, round-trip counts | workerd-only behaviour, real queues/Workflows, browser journeys |
| **2. Integration** | workerd via `cloudflareTest()` | the **real** durable pipeline (fetch → queue → Workflow → consumer → derived store), Workflow status/retry/replay, cross-worker RPC | test-only twins of deployed code, browser, live vendors |
| **3. E2E** | Playwright (Node) → `vite dev` (Miniflare) | user-visible journeys on seeded data, UI states, auth flows the browser owns | pipeline/ingestion journeys, transient queue/Workflow states, timing assertions |

Why three: workerd has no DOM and cannot run Playwright, since Playwright needs Node plus a
browser process. Local emulators have historically failed to run some cross-primitive paths, such
as a Workflow created from inside a queue consumer. Node with in-memory SQLite is 10–100× faster
for branching logic. A journey goes in the cheapest layer whose runtime can actually observe it.

**Rule: write each layer's ownership into the test docs, and route new tests by it.**
Why: when the pipeline was tested through the browser, the suite needed a cross-process fake vendor
and a file lock, and it flaked until the whole design was rebuilt.
Check: `grep -rn "waitForQueue\|pollWorkflow\|sleep(" e2e/` returns nothing. A pipeline assertion in
an e2e spec is a misrouted test.

**Rule: never branch production code to work around an emulator gap.** Find the layer where the
real runtime works, test there, and delete the shim.
Why: an `INGEST_INLINE`-style flag is a production code path that only tests take, and it drifts.
Check: `grep -rn "INLINE\|isTest\|process.env.VITEST" packages/core apps/*/src` lists nothing
outside composition roots.

## Layer 1 — Node unit with an in-memory D1

Core takes a structural `D1Like` port from `contracts` (rule 5 in SKILL.md). Tests pass a
better-sqlite3 adapter from `test-utils`, which is a devDependency only (rule 5). Neither
better-sqlite3 nor Miniflare enforces D1's limits. A query that binds 101 parameters passes every
local test and fails in production. So **the adapter enforces the limits it can, and lists the ones
it cannot.** If `core` takes a Drizzle instance instead of the raw port, build it over the same
guarded adapter so the limits still apply.

```ts
// packages/test-utils/src/d1-memory.ts
import Database from 'better-sqlite3';
import type { D1Like } from '@acme/contracts';

// Check current values: developers.cloudflare.com/d1/platform/limits/
export const D1_LIMITS = { maxBinds: 100, maxStatementBytes: 100_000 } as const;
// NOT emulated (pin per query instead): 50-byte LIKE/GLOB pattern cap; meta.changes
// counting trigger-written rows; per-invocation query count; 2 MB row size.

export function d1Memory(db = new Database(':memory:')): D1Like & { issued: Issued[] } {
  const issued: Issued[] = [];
  const guard = (sql: string, binds: unknown[]) => {
    if (binds.length > D1_LIMITS.maxBinds)
      throw new Error(`D1 limit: ${binds.length} binds > ${D1_LIMITS.maxBinds}\n${sql}`);
    if (Buffer.byteLength(sql) > D1_LIMITS.maxStatementBytes) throw new Error('D1 limit: statement too long');
    issued.push({ sql, binds });
  };
  /* prepare/bind/all/first/run/batch delegate to db after guard(); batch() runs as one transaction */
}
```

- **Rule: the memory adapter throws on every D1 limit it can check, and its file lists the ones it
  cannot.** Why: each limit you pin per incident leaves the next query that crosses it invisible.
  Check: a test binds 101 values and expects a throw.
- **Rule: every deployable has its own `test/` that calls its real exported `queue()` /
  `scheduled()` / `fetch()`** with test-utils seams. Never call an internal helper and skip the
  entrypoint. Check: each `apps/*/test/` imports its own entry (`src/index.ts` or `worker/index.ts`).
- **Use real elapsed time for any budget or deadline.** Why: a frozen-clock unit test passed while
  a `maxWaitMs: 1` budget, checked against the real clock before the first poll, timed out every
  slow request in e2e. Check: every deadline/budget function has at least one test that advances
  the injected clock past the deadline.
- Keep timeouts short (≈5 s) in this layer so a hang fails fast and does not stall the run.

## Layer 2 — workerd integration: the real pipeline, deployed topology

Drive the real Worker with `exports.default.fetch()` (or `SELF.fetch` on older versions), using
real D1, R2, Queues, Workflows and DOs. Pump async delivery with `vi.waitUntil(() => rowReached())`,
never with fixed sleeps.

**Rule: run the deployed topology. Satellite consumers run as auxiliary workers in the pool, never
as test-only `queue()` branches in the main worker.**
Why: in one case a main worker kept `-index`/`-enrich` queue branches that only the integration
suite exercised. Their context type drifted from the deployed consumer's, and the suite stayed
green while proving the wrong code.
Check: no `case 'acme-index'` in `w-app`'s queue handler. The pool config lists each satellite.

```ts
// apps/w-app/vitest.integration.config.ts
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.integration.jsonc' }, // never deployed (wrangler-and-local-dev §6)
    miniflare: {
      // Auxiliary workers must be pre-built JS (`wrangler deploy --dry-run --outdir dist`).
      workers: [
        { name: 'acme-q-consumer-index', modules: true, scriptPath: '../q-consumer-index/dist/index.js' /* + its bindings */ },
        { name: 'vendorx-stub', modules: true, scriptPath: './test/vendorx-stub.js' },
      ],
    },
  })],
  test: { include: ['test/**/*.itest.ts', 'test/**/*.runtime.test.ts'], testTimeout: 30_000 },
});
```

**Rule: stub vendors at the network, at a seam every worker in the pool can reach.**
Global mocks set up in the test file (`vi.stubGlobal('fetch')`, `@msw/cloudflare`) cover the main
worker and its in-process Workflows. **They do not cover auxiliary workers.** For a vendor that a
satellite calls, point the satellite's `VENDORX_BASE_URL` config var at a stub auxiliary worker
whose fixtures are files keyed by request. Check: no integration config has a real vendor hostname;
`grep -rn "https://api\." wrangler*.jsonc` shows only deployed envs.

**Workflow runtime tests.** Node tests with a fake `StepLike` cover branching. Runtime tests cover
what only the real engine shows: final status, retries, replay. Assert the error taxonomy (rule 26)
end to end: a domain error ends `complete` with the status row at `failed`, and a transient error is
re-thrown and ends `errored`, which is what triggers platform retries.

```ts
import { env } from 'cloudflare:workers';
import { introspectWorkflowInstance } from 'cloudflare:test';

it('transient vendor failure retries, then completes', async () => {
  await using wf = await introspectWorkflowInstance(env.FETCH_WORKFLOW, 'doc-1');
  await wf.modify(async (m) => {
    await m.disableSleeps();
    await m.disableRetryDelays();
    await m.mockStepError({ name: 'vendor-fetch' }, new Error('503'), 1);
  });
  await env.FETCH_WORKFLOW.create({ id: 'doc-1', params: { docId: 'doc-1' } });
  await wf.waitForStatus('complete');
  expect(await statusRow('doc-1')).toBe('done');
});
```

When the instance id is unknown (a fetch or consumer creates the instance), use
`introspectWorkflow(binding)` + `modifyAll` + `get()`. Always dispose introspectors with
`await using` or `dispose()`, or instance state leaks into the next test.

- **Every Workflow has at least one runtime test, or a written gap entry.** The paid Workflow
  needs one most. Check: `ls test/**/*.runtime.test.ts` covers every `class * extends
  WorkflowEntrypoint`.
- **Memoized module init survives per-test storage reset.** Re-create schema in `beforeEach`, or
  expose a reset hook. Never let a memo make a test pass by accident (see no-DDL below).
- **`compatibility_date` is capped by the local runtime.** Never move a deployable's date past what
  the pinned workerd accepts. Satellites that share `core` should run the same date, or `core`
  should be tested under each date. Check: one consistency test over all `wrangler.jsonc`.
- Run independent pipelines concurrently inside a spec, and wait on conditions. Doing both cut one
  integration suite's runtime several-fold.

### Fake-vs-live equivalence

Layer 3 runs a fake durable layer (below). **Rule: one table-driven test runs the same scenarios
through the Live pipeline and the Fake, then compares a projection of terminal D1 state.**
Why: the fake writes hand-chosen outcomes. If the real Workflow's terminal state changes, every e2e
test stays green against a fake that no longer matches production.

```ts
const scenarios = [{ name: 'fresh doc', seed: oneDoc }, { name: 'already fetched', seed: fetchedDoc }];
for (const s of scenarios) it(`fake ≡ live: ${s.name}`, async () => {
  const live = await runThrough(liveDurable, s);   // real queue + Workflow, waitUntil terminal
  const fake = await runThrough(fakeDurable, s);   // same request, fake layer
  expect(project(fake)).toEqual(project(live));    // status, counts, derived-store ids; not timestamps
});
```

## Layer 3 — Playwright against `vite dev` with the fake durable layer

One `CLOUDFLARE_ENV=test vite dev` serves the SPA and `/api/*` (rule 2) with `persistState: false`,
so every run starts empty. A worker whose Workflows/Queues sit behind a UI is exactly where the
binding facade (rule 10) earns its keep: `USE_FAKE_CF=1` swaps **only Workflows and queue
producers**. D1, R2 and DOs stay real.

**Rule: the fake makes durable work synchronous and writes the FINAL outcome inside the triggering
request, through the same production functions the real path uses.** The gate that decides whether
work should run is one exported function that both Live dispatch and the Fake call.
Why: a fake with its own gate or its own writes passes e2e for behaviour production never has.
Check: `fake.ts` imports the gate and the storage completion method from `core`; it contains no SQL.

```ts
// packages/core/src/fetch/gate.ts — the single-flight claim (rule 15), shared by Live and Fake
export const claimFetch = (db: D1Like, docId: string, now: number) =>
  db.prepare(`UPDATE doc_state SET state='fetching', at=? WHERE doc_id=? AND state IN ('idle','done') RETURNING doc_id`)
    .bind(now, docId).first();

// apps/w-app/worker/cf/fake.ts — reachable only when __TEST_SEAMS__ is true
workflows: { fetch: { async create({ params }) {
  if (!(await claimFetch(db, params.docId, clock()))) return;           // same gate as Live
  await storage.completeFetch(params.docId, fixtureFor(params.docId));  // same method the last step calls
  await indexInline(storage, params.docId);                             // the index consumer's handler, called in-request
} } },
```

Consequence: **transient states (`queued`, `fetching`, retrying) cannot be observed in Playwright.**
Do not build coordination scaffolding to see them. Route instead:

| Want to verify | Layer |
|---|---|
| UI renders `fetching` / spinner / progress | Unit (jsdom), with the poll response mocked |
| Pipeline reaches `done`, derived store updated | Integration (real queue + Workflow) |
| Retry / backoff / DLQ / reaper takeover | Integration (`mockStepError`, `disableRetryDelays`) + unit |
| Button → request → terminal UI | E2E (fake writes the terminal state) |
| Something cosmetic that needs a transient state to appear | Unit test + check by hand in the browser; write down the route taken |

Assert on `data-testid` / `data-test-state` / `data-test-value`, never on CSS or copy, and read
numbers from attributes. Replace toast/spinner waits and `networkidle` with `data-test-state` hooks.

## Seeding — declarative, in-worker, drift-gated

**Rule: specs declare the world as a typed `SeedSpec` and POST it to a test-only seed route that
builds it inside the Worker.** Playwright cannot write Miniflare's D1 from outside, and builders
reuse production `Storage` methods. Seeding is deterministic: no RNG, a fixed `SEED_EPOCH`, and
per-spec sequences, because factory sequences are global and make output depend on order.
Committed fixtures are regenerated and diffed: `check:seed` = `gen:seed && git diff --exit-code
e2e/fixtures`. On its first run this gate caught the global-sequence bug.

Why: specs that write rows by hand duplicate storage logic and drift from it; order-dependent seeds
flake under parallelism. Check: `check:seed` is in the local `check`; `e2e/` contains no SQL.

- Import the `SeedSpec` type from the worker or `contracts`. Do not re-declare it in `e2e/`.
- Seed through the same inline-index path the fake uses, so search sees seeded rows.

## Parallel isolation — tenancy, not locks

**Rule: every test gets a unique user (`crypto.randomUUID()`), and reads are scoped by user. Shared
entity-keyed tables (docs, sources, status rows keyed only by entity id) are re-homed per test:
the seed route rewrites ids with a per-test namespace, and page objects resolve ids through the
same function.** This makes `fullyParallel` against one Worker and one D1 safe.
Check: no spec hard-codes an entity id; every id passes through the re-homing function.
Why: unique users alone failed. A status table keyed only by entity id collided across workers,
and concurrent seeds for one user interleaved deletes and inserts. Serialize seeds per user on the
server.
Why not locks: a cross-process lock had a stale-break longer than the test timeout. Another lived
in a directory the runner clears, and its waiter released a lock it never held. If a truly global
table forces a lock, keep it in `os.tmpdir()`, release it only from the owner, and keep `max hold
< stale < acquire timeout < hook timeout`. Better: give global state its own serial project.

## Invariant pins — cheap unit tests that replace reviewer memory

| Pin | What it asserts | Catches |
|---|---|---|
| Schema ≡ migrations | `drizzle-kit generate` emits nothing new (regenerate-and-diff); if a hand-written fresh-DB builder exists, its output equals the migration chain applied in order | a column added in one place only |
| Backfill | stop at migration N-1, insert legacy rows, apply the rest, assert reads succeed | correct on fresh DB, broken on prod |
| Migration hygiene | unique ordinals, destructive DDL carries a justification marker, no FTS/trigger in the primary DB | silent drops, index-by-trigger |
| Query plan | `EXPLAIN QUERY PLAN` of the SQL actually issued (captured by the recording adapter) uses the expected index | planner regressions (without `PRAGMA optimize` the planner has no statistics, so the plan follows schema shape; pin it) |
| Round trips | serial D1 waves and `maxInFlight` per route, pinned to current numbers | latency regressions; improvements show up as visible edits |
| Bind counts | per-statement binds ≤ limit on captured SQL | the 100-bind production failure |
| Port shape | `Object.keys(storage(ctx)).length === N` | spread-composed ports (`{...a(ctx), ...b(ctx)} satisfies Storage`) slip past excess-property checks |
| Tool/API snapshot | MCP `tools/list` and OpenAPI committed and diffed | unreviewed contract change |
| Read parity | REST and MCP return the same projection for a table of reads, **after asserting each call succeeded** | parity that passes because both sides 500 |
| No-DDL in tenants (shared-DB model, rule 13) | a tenant's real entrypoint, on a fresh DB, issues no `CREATE`/`ALTER`/`DROP` | satellite runs schema init |
| Purge completeness | every table with a user column is in the purge list or an exemption list | missed rows on account deletion |

**No-DDL must live in its own test file.** If an earlier test in the module already triggered the
memoized init, the assertion passes without testing anything.

## Test seams never reach a deployed environment (rule 25)

Seams are fake bindings, seed/reset/login-as routes and `USE_FAKE_*` flags. **Exclude them from the
build, and pin both the build and the configs.**
Why: impersonation routes were found mounted on an internet-facing dev worker, and the fake tree
shipped in the production bundle. Separately, a boot-time schema init that existed for the empty
e2e database also ran before routing in production and contributed to an outage.

```ts
// vite.config.ts — the dead branch and its imports tree-shake out of non-test builds
define: { __TEST_SEAMS__: JSON.stringify(process.env.CLOUDFLARE_ENV === 'test') },
// composition root
const cf = __TEST_SEAMS__ && cfg.fakes.cf ? new CloudflareServiceFake(deps) : new CloudflareServiceLive(env, cfg);
if (__TEST_SEAMS__ && cfg.devRoutes) app.route('/api/__test', testRoutes);
```

Check, as one test plus one script, both in `check`:
- Parse every `apps/*/wrangler*.jsonc`. Only `env.test` and `wrangler.integration.jsonc` may set
  `USE_FAKE_*`, `DEV_ROUTES` or any seam flag; `env.dev` and `env.prod` never do.
- Build each deployable for each deployed env and grep the bundle for seam markers
  (`__test`, `login-as`, `CloudflareServiceFake`). Any hit fails.
- Separate fake switch per external cost (`USE_FAKE_CF`, `USE_FAKE_AI`, `USE_FAKE_VENDORX`), so faking one does not
  open a billable path for another.

**Test attributes are stripped from production builds**, using a build-only transform
(`apply: 'build'`, e.g. a babel remove-properties plugin over `src/**/*.tsx`). `vite dev` keeps
them, so there is no env condition to get wrong. A bundle gate fails if an authored `data-test*`
attribute reaches `dist/`.
Why: a live API token sat in a `data-test-value`, and the session-replay recorder serialized it.
Consequences: never put a secret in a test attribute, and **key replay masking on a class**, never
on a test attribute that will not exist in production.
Check: the bundle gate runs in the local `check` (rule 28). A gate that existed only in CI went
dark the day CI stopped running.

## Flake, performance and harness hygiene

- **Every retry, skip or quarantine names its cause and an exit criterion** in a comment, for
  example "remove after 3 consecutive green runs" or "retry 1: scoped to real-model latency only".
  Quarantines without an exit criterion stay dark for weeks.
- **Turn emulator persistence off for tests** (`persistState: false`). Accumulated local state made
  full-text queries take seconds, which looked like a performance regression.
- **Measure before blaming the corpus.** An e2e slowdown came from a fixture that put the search
  term in every chunk of one very large document: snippet cost follows term frequency within a
  document. Keep fixtures realistic.
- **Assert counts, never timings** (round trips, binds, rows read). Timings flake. Counts are a
  contract.
- **Fixed-port external dependency means sequential suites.** When two e2e suites boot the same
  external server on a fixed port, run them strictly in sequence (`turbo run e2e --concurrency=1`,
  or ordered steps). Better: derive a port per suite from config and remove the clash.
- **Align retry tolerance across a sequential gate.** In a six-suite sequential run, one untolerated
  flake throws away the whole run.
- Keep live-model or live-vendor specs out of the gating suite. Put them in an opt-in acceptance
  tier.
- Harness copies of worker types and config (seed types, integration bindings, server managers)
  are generated or imported, never hand-mirrored. Otherwise give them a parity test.

## Audit checklist

- [ ] Three layers exist, with written ownership. No pipeline journeys in Playwright.
- [ ] Memory D1 throws on the bind and statement-size limits and lists the gaps it cannot emulate.
- [ ] Integration runs the satellites as auxiliary workers. The main worker has no test-only twins.
- [ ] Vendor stubs reach every worker in the pool. No live vendor hostnames in test configs.
- [ ] Each Workflow has a runtime test with introspection, or a gap entry.
- [ ] Fake-vs-live equivalence test exists. The fake calls the production gate and storage methods.
- [ ] Seeding is in-worker, deterministic and regenerate-and-diff gated.
- [ ] Parallel e2e isolates by unique user plus id re-homing. Any lock follows the timeout ordering.
- [ ] Invariant pins from the table exist. No-DDL tests sit in their own files.
- [ ] Seam flags are build-excluded. A config test and a bundle grep run in local `check`.
- [ ] `data-test*` attributes are stripped in prod builds, with a bundle gate in `check`. Replay masking is class-based.
- [ ] Every retry/skip has a cause and an exit criterion. Test persistence is off.
