# Example layout: "acme"

A complete reference monorepo for the example product **acme**: it ingests documents, enriches
them, and indexes them for search. It has an admin console and a marketing site. Copy the shape,
not the names. On a greenfield project, start with the **Day-one** subset (last section) and add
satellites only when a [split trigger](topology.md#split-triggers) fires.

## 1. Annotated tree

```text
acme/
├── package.json            # scripts: check, test, dev; no deps besides tooling
├── pnpm-workspace.yaml     # apps/*, packages/*
├── turbo.json              # task graph; per-deployable gates discovered by name
├── biome.json              # lint + format + noRestrictedImports layering rules (rule 8)
├── tsconfig.base.json      # strict, moduleResolution "bundler", no emit
├── AGENTS.md               # canonical agent rules, each names its guard (rule 27)
├── CLAUDE.md               # one line: @AGENTS.md
├── CHANGELOG.md            # ## [Unreleased] discipline
├── docs/
│   ├── guides/             # how we build (conventions, migrations, adding a worker)
│   ├── reference/          # what is: verified against code, cites symbols, not lines
│   ├── registers/          # techdebt, deliberate rule violations with reasons
│   └── archive/            # finished plans, retros: historical, never "current"
├── apps/
│   ├── w-app/              # THE product worker: SPA + API + Workflows; schema owner (option A)
│   │   ├── src/            # React SPA (browser only; imports api-client, never core)
│   │   ├── worker/
│   │   │   ├── index.ts    # entrypoint: exports handlers, Workflow/DO/RPC classes. No logic.
│   │   │   ├── compose.ts  # composition root: env → parseConfig → cf facade → core services
│   │   │   ├── app.ts      # Hono app factory: createApp(deps), mounted at /api
│   │   │   ├── routes/     # one module per resource; handlers call core, own no SQL
│   │   │   ├── cf/         # binding facade (rule 10): here because UI-visible Workflows/Queues need a fake
│   │   │   │   ├── service.ts  # CloudflareService interface: d1(), queues(), workflows()
│   │   │   │   ├── factory.ts  # getCloudflareService: picks Live/Fake, refuses fakes outside local/test
│   │   │   │   ├── live.ts     # wraps real env bindings
│   │   │   │   └── fake.ts     # sync Workflows/Queues for e2e; compiled out of deployed builds
│   │   │   ├── rpc/        # WorkerEntrypoint classes other workers bind to (rule 3)
│   │   │   ├── workflows/  # WorkflowEntrypoint classes; each step calls core via the step wrapper
│   │   │   └── dev/        # seed / login-as routes: local+test only, build-excluded (rule 25)
│   │   ├── migrations/     # drizzle-kit output == wrangler migrations_dir; append-only
│   │   ├── e2e/            # Playwright against `vite dev` with CLOUDFLARE_ENV=test
│   │   ├── openapi.json    # generated, committed, regen-and-diff gated
│   │   ├── drizzle.config.ts
│   │   ├── wrangler.jsonc  # env.dev / env.prod (deployed) + env.test (local only)
│   │   └── vite.config.ts  # react + cloudflare plugin + auxiliaryWorkers
│   ├── w-admin/            # admin console: own SPA + API; privileged writes via RPC to w-app
│   ├── q-consumer-enrich/  # calls a paid vendor API; isolated secrets + kill switch
│   ├── q-consumer-index/   # SOLE writer of the search D1 (derived store, rule 13)
│   ├── q-consumer-analytics/ # telemetry off the hot path (rule 26)
│   ├── wf-vendorx-fetch/   # hosts the vendor-fetch Workflow; w-app binds it via script_name
│   ├── cron-reaper/        # unsticks abandoned status rows, drains/alerts DLQs (rule 20)
│   └── pages-website/      # marketing site: zero workspace deps, own deploy lane
└── packages/
    ├── contracts/          # ZERO deps: ports (D1Like, QueueLike, StepLike), wire types, RPC interfaces
    ├── core/               # domain + storage + handlers; subpath per runtime surface
    │   └── src/{domain,storage,queues,workflows,vendors,observability}/
    ├── api-client/         # GENERATED from openapi.json; browser-safe; never hand-edited
    └── test-utils/         # in-memory D1, fakes, builders; devDependency only
```

Invariants this tree encodes:

| Invariant | Check |
|---|---|
| Entry files are thin | `wc -l apps/*/worker/index.ts apps/*/src/index.ts`, all under ~150 lines; `! grep -nE "prepare\(|SELECT\|INSERT" apps/*/{worker,src}/index.ts` |
| No app imports another app | `! grep -rnE "from ['\"]((\.\./)+|@acme/)(w-|q-|wf-|cron-|pages-)" apps` |
| SPA never reaches server code | `! grep -rnE "@acme/core\|cloudflare:" apps/w-*/src` |
| Every deployable is gated | each `apps/*/package.json` has `check:deploy` (or a `.no-deploy` marker) |
| One schema owner per D1 | option A: `ls -d apps/*/migrations` lists only `w-app`; option B (DB per service): each `migrations_dir` targets a D1 no other app binds. Pick one in [data](data.md) and write it down |

## 2. Root scripts and task graph

```jsonc
// package.json
{
  "private": true,
  "packageManager": "pnpm@<pinned>",
  "scripts": {
    "check": "biome check . && turbo run typecheck check:types check:openapi check:migrations check:seed check:deploy && pnpm check:repo-map",
    "test": "turbo run test",
    "test:e2e": "turbo run test:e2e --concurrency=1",
    "dev": "pnpm -F w-app migrate:local && pnpm -F w-app dev",
    "format": "biome format --write ."
  }
}
```

```yaml
# pnpm-workspace.yaml
packages: ["apps/*", "packages/*"]
```

```jsonc
// turbo.json: packages ship TS source, so nothing depends on a build
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "typecheck": {},
    "test": {},
    "check:types":      { "cache": false },   // wrangler types --check
    "check:openapi":    { "cache": false },   // regen spec + client, git diff --exit-code
    "check:migrations": { "cache": false },   // drizzle-kit generate yields no new file
    "check:seed":       { "cache": false },
    "check:deploy":     { "cache": false },   // build + wrangler deploy --dry-run
    "build":   { "outputs": ["dist/**"], "env": ["CLOUDFLARE_ENV", "VITE_*"] },
    "test:e2e": { "cache": false },
    "dev":     { "cache": false, "persistent": true }
  }
}
```

**Rule.** The root lists task *names*, never workspace members. Turbo runs a task in every package
that defines it.
Why: a hand-maintained list of workers is how one new worker ships ungated.
How to check: adding `apps/<new>` needs no edit to the root `package.json`, `turbo.json` or CI.

Per-app gate scripts:

```jsonc
// apps/q-consumer-index/package.json
"scripts": {
  "typecheck": "tsc --noEmit",
  "check:types": "wrangler types --check",
  "check:deploy": "wrangler deploy --dry-run --env prod --outdir .wrangler/dry"
}
// apps/w-app/package.json (vite-built: env is chosen by CLOUDFLARE_ENV at build time)
"scripts": {
  "dev": "vite dev",
  "migrate:local": "wrangler d1 migrations apply DB --local --env dev",
  "check:migrations": "drizzle-kit generate && git diff --exit-code -- migrations && test -z \"$(git status --porcelain migrations)\"",
  "gen:openapi": "tsx scripts/gen-openapi.ts && openapi-typescript openapi.json -o ../../packages/api-client/src/schema.d.ts",
  "check:openapi": "pnpm gen:openapi && git diff --exit-code -- openapi.json ../../packages/api-client/src/schema.d.ts",
  "check:deploy": "CLOUDFLARE_ENV=prod vite build && wrangler deploy --dry-run"
}
```

The Vite plugin writes a flattened deploy config for the env chosen at build time, and wrangler
refuses to deploy it to a different env. Build and deploy with the same `CLOUDFLARE_ENV`.

## 3. `apps/w-app/wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "acme-w-app",
  "main": "./worker/index.ts",
  "compatibility_date": "<pinned; same across all deployables>",
  "compatibility_flags": ["nodejs_compat"],
  "env": {
    "dev": {
      "name": "dev-acme-w-app",
      // assets and observability: repeat in every env, byte-identical. The docs call them
      // inheritable, but an env that relied on that shipped with no assets (wrangler-and-local-dev §3).
      "assets": {
        "binding": "ASSETS",
        "not_found_handling": "single-page-application",
        "run_worker_first": ["/api/*"]
      },
      "observability": { "enabled": true },
      "vars": { "RUNTIME_ENV": "dev", "PUBLIC_ORIGIN": "https://dev.acme.example" },
      "d1_databases": [
        { "binding": "DB", "database_name": "dev-acme-db", "database_id": "<id>", "migrations_dir": "migrations" }
      ],
      "queues": {
        "producers": [
          { "binding": "INGEST_QUEUE",    "queue": "dev-acme-ingest" },
          { "binding": "ENRICH_QUEUE",    "queue": "dev-acme-enrich" },
          { "binding": "INDEX_QUEUE",     "queue": "dev-acme-index" },
          { "binding": "ANALYTICS_QUEUE", "queue": "dev-acme-analytics" }
        ],
        "consumers": [
          // Split-ready monolith: ingest dispatch is cheap glue, so it stays next to its orchestrator.
          { "queue": "dev-acme-ingest", "max_batch_size": 10, "max_retries": 3,
            "retry_delay": 30, "dead_letter_queue": "dev-acme-ingest-dlq" }
        ]
      },
      "workflows": [
        { "binding": "INGEST_WF", "name": "dev-acme-ingest", "class_name": "IngestWorkflow" },
        { "binding": "VENDOR_FETCH_WF", "name": "dev-acme-vendorx-fetch",
          "class_name": "VendorFetchWorkflow", "script_name": "dev-acme-wf-vendorx-fetch" }
      ]
    },
    "prod": { /* the same keys (assets and observability byte-identical), prod-acme-* names and ids */ },
    "test": {
      // Local e2e only. Never deployed: no deploy script may set CLOUDFLARE_ENV=test.
      "name": "test-acme-w-app",
      "assets": { /* byte-identical to dev */ },
      "vars": { "RUNTIME_ENV": "test", "USE_FAKE_CF": "1", "USE_FAKE_AI": "1", "USE_FAKE_VENDORX": "1" },
      "d1_databases": [ { "binding": "DB", "database_name": "test-acme-db", "database_id": "local", "migrations_dir": "migrations" } ]
    }
  }
}
```

**Rule.** Repeat every non-inheritable key (`vars`, every binding list, `assets`, `observability`,
`define`, …) in every env. Binding names are env-free (`DB`); resource names are
`{env}-acme-{purpose}`.
Why: a non-inheritable key that an env omits does not reach it, so a deploy succeeds and the worker
runs without its binding, or, for a missing `assets` block, with no SPA at all. The list has grown
over wrangler versions; re-read "Non-inheritable keys" in the wrangler configuration docs when you
bump wrangler. Repeating an inheritable key per env costs nothing.
How to check: a consistency test that loads every `apps/*/wrangler.jsonc` and asserts the same
`database_id` for a given `database_name`, one `compatibility_date`, the env names `{dev,prod}`
(plus `test` only where e2e runs), identical `assets` blocks across envs, and that `USE_FAKE_*`
appears under `env.test` only.

Notes that make the seams concrete:
- `run_worker_first: ["/api/*"]` sends API calls to the worker. Everything else is served as a
  static asset, and the SPA fallback handles deep links. Patterns accept `*` globs and `!`
  exclusions.
- `workflows[].script_name` binds a Workflow class hosted by another worker
  (`wf-vendorx-fetch`). The caller creates instances, and the host owns the code and secrets.
- Every retrying consumer names a `dead_letter_queue`. Without one, Queues discards messages that
  exhaust their retries. Something (`cron-reaper` or an alert) must read each DLQ.

## 4. A satellite: `apps/q-consumer-index/wrangler.jsonc`

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "acme-q-consumer-index",
  "main": "./src/index.ts",
  "compatibility_date": "<same as w-app>",
  "env": {
    "dev": {
      "name": "dev-acme-q-consumer-index",
      "observability": { "enabled": true },
      "d1_databases": [
        { "binding": "DB",        "database_name": "dev-acme-db",        "database_id": "<id>" },  // tenant: reads only, never DDL
        { "binding": "SEARCH_DB", "database_name": "dev-acme-search", "database_id": "<id>" }   // sole writer
      ],
      "queues": {
        "consumers": [
          { "queue": "dev-acme-index", "max_batch_size": 10, "max_retries": 3,
            "dead_letter_queue": "dev-acme-index-dlq" }
        ]
      }
    },
    "prod": { /* mirrored */ }
  }
}
```

**Rule.** Under option A a satellite is a tenant of `DB`: no `migrations_dir`, no DDL. Its entry
file is five lines: parse config, build deps, call `handleIndexBatch(batch.messages, deps)` from
`@acme/core/queues`.
Why: two DDL writers on one D1 means production schema depends on deploy order.
How to check: `! grep -rniE "CREATE |ALTER |DROP " apps/q-consumer-*/src apps/wf-*/src apps/cron-*/src`
and no `migrations_dir` outside `apps/w-app/wrangler.jsonc`.

## 5. `apps/w-app/vite.config.ts`

```ts
import path from 'node:path';
import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const env = process.env.CLOUDFLARE_ENV ?? 'dev';
const isTest = env === 'test';
const aux = (dir: string) => ({ configPath: path.resolve(__dirname, `../${dir}/wrangler.jsonc`) });

export default defineConfig({
  base: '/', // mount path lives on the router basename, never here
  define: { __TEST_SEAMS__: JSON.stringify(isTest) }, // folds dev/ and cf/fake.ts out of deployed builds
  plugins: [
    react(),
    cloudflare(
      isTest
        ? { persistState: false } // e2e: the fake makes Workflows/Queues sync, so no consumers needed
        : {
            // One dev server runs the fleet: keep every producer and its consumer in this one session
            // rather than a separate `wrangler dev` (cross-session dev only covers service bindings).
            auxiliaryWorkers: [
              aux('q-consumer-enrich'), aux('q-consumer-index'), aux('q-consumer-analytics'),
              aux('wf-vendorx-fetch'), aux('cron-reaper'),
            ],
          },
    ),
  ],
});
```

**Rule.** Every deployable that binds or consumes something from `w-app` is an `auxiliaryWorkers`
entry; local secrets stay per worker (its own `.dev.vars`/`.env` beside its wrangler config), never
copied from `w-app`.
Why: a consumer outside the dev session silently never receives messages, and shared secrets erase
the spend isolation the split bought. A vendor worker with no local token declines the message, so
local dev costs nothing by default.
How to check: every `apps/{q-consumer,wf,cron}-*` directory appears in `w-app/vite.config.ts`.

## 6. Entrypoint and composition root

```ts
// apps/w-app/worker/index.ts: wiring only (rule 4)
import { handleIngestBatch } from '@acme/core/queues';
import type { IngestMessage } from '@acme/contracts';
import { createApp } from './app';
import { compose } from './compose';

export { IngestWorkflow } from './workflows/ingest'; // discovered by export name
export { AdminRpc } from './rpc/admin';

export default {
  fetch: (req, env, ctx) => createApp(compose(env, ctx)).fetch(req), // no I/O before routing (rule 12)
  queue: (batch, env) => handleIngestBatch(batch.messages, compose(env).ingest),
} satisfies ExportedHandler<Env, IngestMessage>;
```

```ts
// apps/w-app/worker/compose.ts: the only file that reads env
import { makeIngestService, makeRepo } from '@acme/core';
import { parseConfig } from '@acme/core/config';
import { getCloudflareService } from './cf/factory'; // imports cf/fake only under __TEST_SEAMS__

export function compose(env: Env, ctx?: ExecutionContext) {
  const cfg = parseConfig(env); // throws on a missing core secret; optional features stay off
  const cf = getCloudflareService(env, cfg); // Live, or Fake when __TEST_SEAMS__ && cfg.fakes.cf
  const repo = makeRepo(cf.d1());
  return {
    cfg, ctx, repo,
    ingest: makeIngestService({ repo, enrich: cf.queues().enrich, startFetch: cf.workflows().vendorFetch }), // required, never optional (rule 11)
  };
}
```

**Rule.** `compose.ts` (with `cf/`) is the only code that reads `env`; side-effecting collaborators
are required arguments; the fake is reachable only behind a build-time constant **and** the
factory's runtime refusal outside local/test
([bindings-and-config §4](bindings-and-config.md#4-the-binding-facade-live--fake-situational-rule-10)).
Why: a runtime flag alone ships the fake (and its auth bypasses) to production, one mis-set var away.
How to check: build with `CLOUDFLARE_ENV=prod` and `! grep -rqE "CloudflareServiceFake|/api/dev/" dist/`;
`! grep -rlE "\benv\.[A-Z_]+" apps/w-app/worker --include=*.ts | grep -vE 'compose.ts|/cf/'`; the wrangler
consistency test asserts no deployed env sets `USE_FAKE_*`. A worker with no UI-visible async and no
paid calls skips `cf/` and passes bindings straight from `compose.ts` (rule 10).

## 7. RPC instead of internal HTTP

```ts
// packages/contracts/src/rpc.ts: one home for the wire shape (rule 6)
export interface AdminRpcApi {
  purgeUser(userId: string): Promise<{ rowsDeleted: number }>;
  reindexDocument(docId: string): Promise<void>;
}
```

```ts
// apps/w-app/worker/rpc/admin.ts
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { AdminRpcApi } from '@acme/contracts';
import { compose } from '../compose';

export class AdminRpc extends WorkerEntrypoint<Env> implements AdminRpcApi {
  purgeUser(userId: string) { return compose(this.env).repo.purgeUser(userId); }
  async reindexDocument(docId: string) { await compose(this.env).repo.emitIndex(docId); }
}
```

```jsonc
// apps/w-admin/wrangler.jsonc (inside each env)
"services": [{ "binding": "APP", "service": "dev-acme-w-app", "entrypoint": "AdminRpc" }]
```

**Rule.** Privileged cross-worker calls are methods on a named `WorkerEntrypoint`; `w-admin` types
the binding as `APP: AdminRpcApi` from `@acme/contracts` and never imports `w-app`.
Why: a named entrypoint is reachable only through a service binding, not from the worker's public
URL, so an "internal" HTTP route guarded by a shared header cannot leak.
How to check: `! grep -rnE "/api/internal|x-internal-(token|secret)" apps`.

## 8. `apps/w-app/drizzle.config.ts`

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: '../../packages/core/src/storage/schema.ts', // schema code lives in core
  out: './migrations',                                  // == wrangler migrations_dir
  // Only needed for drizzle-kit commands that talk to a remote DB (studio, introspect):
  // driver: 'd1-http', dbCredentials: { accountId, databaseId, token } from env
});
```

**Rule.** Drizzle schema in `core` is the source; `drizzle-kit generate` writes SQL into the
wrangler `migrations_dir`; `wrangler d1 migrations apply DB --env <env> [--local|--remote]` applies
it. Committed migration files are never renamed or edited, comments included.
Why: wrangler records applied migrations by filename, so an edited file never re-runs and prod and
fresh databases diverge silently.
How to check: `check:migrations` (generate yields no diff); a test lists the migration files, asserts
unique ordering prefixes and that no applied file differs from `main`. Check the layout your
drizzle-kit version emits (flat files, or one folder per migration plus `migrations_pattern`; see
[data §3](data.md#3-schema-tooling-drizzle-by-default)) and pin that version.

## 9. Day-one checklist (greenfield)

Start as a **split-ready monolith**: `w-app` plus the four packages. Add each satellite only when
its split trigger fires.

- [ ] `pnpm-workspace.yaml`, `turbo.json`, `biome.json`, `tsconfig.base.json` as above.
- [ ] `packages/contracts` with zero deps: `D1Like`, `QueueLike<M>`, `StepLike`, `WorkflowLike<P>`,
      the first id-only message type.
- [ ] `packages/core` with subpaths `./domain` (runtime-neutral), `./storage`, `./queues`,
      `./workflows`. Add the Biome `noRestrictedImports` rule banning `cloudflare:*`, `hono` and
      `@cloudflare/workers-types` in `packages/core` and `packages/contracts`.
- [ ] `packages/test-utils` (in-memory D1, fake queue) as a devDependency only.
- [ ] `packages/api-client` generated from `w-app/openapi.json`, with `check:openapi` wired.
- [ ] `apps/w-app` with `worker/{index,compose,app}.ts`, `routes/`, `workflows/`, `migrations/`,
      `wrangler.jsonc` (`dev`, `prod`, `test`), and `vite.config.ts` with the `__TEST_SEAMS__`
      define. Add `cf/{service,factory,live,fake}.ts` once a Workflow or Queue result is visible in the UI
      or a call costs money (rule 10); until then `compose.ts` passes bindings straight to core.
- [ ] Write down the D1 ownership model (one owner + tenants, or DB per service) in `docs/guides`.
- [ ] Each queue handler is already its own module in `core/queues`, with a consumer failure
      helper and a DLQ per queue, even while `w-app` consumes all of them. Moving one to
      `q-consumer-*` is then a new 5-line entry file plus wrangler entries.
- [ ] Each status or lock row gets a stale takeover. Add the `scheduled` reaper in `w-app` until it
      warrants `cron-reaper`.
- [ ] Root `check` runs green locally, and CI runs only `pnpm install && pnpm check && pnpm test`.
- [ ] `AGENTS.md` lists commands and rules, and each rule names its guard. `CLAUDE.md` is `@AGENTS.md`.
- [ ] One e2e spec drives the critical path through `vite dev` with `CLOUDFLARE_ENV=test`.

When a trigger fires, add the satellite:

| Trigger | Becomes |
|---|---|
| Derived store needs a single writer (search index) | `q-consumer-index` |
| Paid vendor call: isolate secrets, spend, kill switch | `q-consumer-enrich`, `wf-vendorx-fetch` |
| Telemetry should not share failure or CPU budget with requests | `q-consumer-analytics` |
| Periodic maintenance owned by no single domain | `cron-reaper` |
| Second UI with different auth or deploy cadence | `w-admin` (RPC into `w-app`) |
| Marketing pages with their own release lane | `pages-website` (zero workspace deps) |

Each new deployable brings its own `wrangler.jsonc` with every env, a composition root, a
`check:deploy` script, an `auxiliaryWorkers` entry in `w-app/vite.config.ts`, and, if it binds
`DB`, the no-DDL test. Nothing else in the repo should need an edit.
