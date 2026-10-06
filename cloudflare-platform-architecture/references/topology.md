# Topology

Which deployables exist, why each one exists, what they are called, and where the seams between
them sit. Rules 1–4 of the skill. Product APIs (wrangler keys, RPC semantics, Vite plugin options)
belong to the `cloudflare`, `wrangler` and `workers-best-practices` skills. This file covers
how the pieces are organized.

Running example: **acme** ingests documents, enriches them, and indexes them for search.

| Deployable | Trigger(s) | Exists because |
|---|---|---|
| `apps/w-app` | fetch (SPA + `/api/*`), cheap dispatch queue, orchestration Workflows | the product: request serving and orchestration |
| `apps/w-admin` | fetch (SPA + `/api/*`) | different audience, auth and release cadence |
| `apps/q-consumer-enrich` | queue | heavy vendor-API + R2 work; its own CPU limit, secret and blast radius |
| `apps/q-consumer-index` | queue | **single writer** of the derived search DB |
| `apps/q-consumer-analytics` | queue | best-effort telemetry, kept off the hot path |
| `apps/wf-vendorx-fetch` | queue + Workflow + `*/10` cron | paid vendor integration: spend isolation and a kill switch |
| `apps/cron-reaper` | scheduled | cross-domain lock and expiry sweeps that belong to no domain worker |
| `apps/pages-website` | static (Pages) | marketing; no runtime coupling at all |

---

## Split triggers

Start as a **split-ready monolith** (next section). Extract a deployable only when at least one of
these triggers fires, and write the trigger in that deployable's `AGENTS.md`.

| Trigger | Fires when | Why a separate script fixes it |
|---|---|---|
| **CPU / wall limits** | a handler needs a higher `limits.cpu_ms` than the API should have, or needs long wall time | `limits` apply to the whole script. Raising them for one job raises them for every request (and for runaway cost). Wall time also differs by trigger: queue consumers and cron are capped per invocation (15 min at time of writing), HTTP runs while the client stays connected. Check current limits. |
| **Failure isolation** | a crash, OOM or retry storm in background work must not take down request serving | each script has its own isolates, error budget and rollback |
| **Secret / spend isolation + kill switch** | the work holds a credential that costs money or carries privilege | a secret lives on exactly one script. Deleting it stops the spend without a code change, and nothing else loses access. |
| **Deploy cadence** | one part ships many times a day and another rarely, or they have different owners | independent deploys and rollbacks |
| **Single writer for a derived store** | a search index, aggregate or cache needs exactly one writer | the consumer *is* the writer, so ownership shows up in the topology, not just in a convention |
| **Vendor integration** | the deployable is the adapter to one external vendor (queue claim → Workflow → poll → persist) | the vendor's protocol, retries and failure modes stay in one place. Put the vendor in the name (`wf-vendorx-fetch`). |

### Anti-triggers (do not split for these)

- **"It's a different queue."** Splitting one worker per queue by reflex multiplies config without
  isolating anything. A queue without one of the triggers above stays a module in its owner.
- **Cheap dispatch glue.** A queue whose consumer just runs `workflow.create()` for Workflows
  hosted in `w-app` stays in `w-app`. Moving it out adds a cross-script Workflow binding and buys
  nothing. **Orchestration glue stays with its orchestrator.**
- **Frontend vs backend layers.** Split along deployable boundaries, never into a "web" package and
  an "api" package (see [one package = one worker](#one-package--one-worker--spa--api)).

### Cost of every split (count it before you split)

Each new script adds: one `wrangler.jsonc` × N envs (bindings are non-inheritable, so they are
repeated), a deploy step, a secrets store per env, a `.dev.vars` file, a queue consumer
registration, an `auxiliaryWorkers` entry, env-qualified cross-script targets, release-order
constraints (schema owner first), and one more `compatibility_date` that can drift. If the split
triggers don't outweigh that list, don't split.

**How to check:** for every `apps/*` with a `wrangler.jsonc`, the deployable's `AGENTS.md` (or a
table like the one above) names its trigger(s), what it spends, and what it can take down. If a row
names no trigger, merge that deployable back.

---

## The split-ready monolith

**Rule:** day one is one worker, but every entry point is its own module over `packages/core`.
**Why:** handlers that reach into each other or into `http/` turn a later split into a rewrite
under pressure; isolated modules make it a file move.

```
apps/w-app/worker/
  index.ts            # export registry ONLY: default {fetch, queue, scheduled}, Workflow + DO + RPC classes
  compose.ts          # composition root: env → parseConfig → deps
  http/app.ts         # Hono app factory, routers get narrow deps
  queues/enrich.ts    # export async function onEnrichBatch(batch, deps)  → core
  queues/index.ts     # export async function onIndexBatch(batch, deps)   → core
  queues/dispatch.ts  # INGEST → workflow.create (orchestration glue; never leaves)
  cron/reap.ts
  workflows/ingest.ts # class IngestWorkflow { run() → runIngest(args, deps) }
```

```ts
// worker/index.ts — routing by queue *purpose*; names carry the {env}- prefix, so match the suffix
const handlers: Record<string, (b: MessageBatch, d: Deps) => Promise<void>> = {
  "acme-enrich": onEnrichBatch,
  "acme-index": onIndexBatch,
  "acme-ingest": onIngestDispatch,
};
export default {
  fetch: (req, env, ctx) => createApp(compose(env, ctx)).fetch(req, env, ctx),
  async queue(batch, env, ctx) {
    const key = Object.keys(handlers).find((k) => batch.queue.endsWith(k));
    if (!key) throw new Error(`no handler for queue ${batch.queue}`);
    await handlers[key](batch, compose(env, ctx));
  },
} satisfies ExportedHandler<Env>;
```

**Check:** `queues/*.ts`, `cron/*.ts` and `workflows/*.ts` import from `core` and `compose`, never
from each other or from `http/`.

---

## Naming

**Rule:** a deployable's directory name states its trigger kind and domain; resource names state
their env; binding names state neither.
**Why:** a name that hides the trigger hides what can be split, merged or killed; an env baked into
a binding name forks core code and tests per env.

### Deployables: `{platform}-{domain}-{role}`

| Prefix | Meaning | Example |
|---|---|---|
| `w-` | HTTP worker (SPA + API, admin, public API) | `w-app`, `w-admin` |
| `q-consumer-` | queue consumer | `q-consumer-index`, `q-consumer-analytics` |
| `wf-` | worker whose main job is hosting Workflows | `wf-vendorx-fetch` |
| `cron-` | scheduled-only worker that owns no domain | `cron-reaper` |
| `pages-` | static site on Cloudflare Pages | `pages-website` |
| *(none)* | shared library under `packages/` | `contracts`, `core`, `api-client`, `test-utils` |

- **Multi-trigger rule:** name the worker after its *primary* trigger. `wf-vendorx-fetch` also
  consumes a queue and runs a cron reaper, and it is still `wf-`.
- **Put the vendor in the name only when the deployable *is* that vendor's integration.**
- **A cron that belongs to a domain lives in that domain's worker.** The reaper for vendor-fetch
  locks runs inside `wf-vendorx-fetch`, so `cron-*` is only for sweeps that no domain owns.

### Resources: `{env}-{product}-{purpose}`. Bindings: env-free.

```jsonc
// apps/q-consumer-index/wrangler.jsonc (excerpt)
"env": {
  "prod": {
    "name": "prod-acme-q-consumer-index",
    "d1_databases": [
      { "binding": "DB",        "database_name": "prod-acme-db",     "database_id": "…" },
      { "binding": "SEARCH_DB", "database_name": "prod-acme-search", "database_id": "…" }
    ],
    "queues": { "consumers": [{ "queue": "prod-acme-index", "dead_letter_queue": "prod-acme-index-dlq" }] }
  }
}
```

- Every resource name (D1, R2, queue, DLQ, script) starts with `{env}-`, so dev and prod can live
  in one account without colliding.
- Binding names (`DB`, `SEARCH_DB`, `INDEX_QUEUE`, `MEDIA`) are identical in every env and every worker,
  so core code and tests never branch on env.

**Check:** `rg -o '"(database_name|queue|bucket_name|name)":\s*"[^"]+"' apps/*/wrangler.jsonc`
returns only names whose prefix matches the env block they sit in. Do this in a cheap consistency
test ([wrangler-and-local-dev](wrangler-and-local-dev.md#5-optional-a-cross-config-consistency-test)).

---

## Thin entrypoints, one composition root per kind

**Rule:** each entrypoint kind does the same two things: build deps in a composition root, delegate
to core. Whether that root wires live bindings directly or through a swappable Live/Fake facade is
decided per deployable ([bindings-and-config](bindings-and-config.md#4-the-binding-facade-live--fake-situational-rule-10));
the thin shell is not optional.
**Why:** logic in an entrypoint cannot be unit-tested, cannot move with a split, and is where
boot-time init and hidden env reads accumulate.

| Entrypoint | Shell does | Core does |
|---|---|---|
| `fetch` | `createApp(compose(env, ctx))` | route handlers |
| `queue` | route by `batch.queue`, `compose(env, ctx)` | `handleXBatch(batch.messages, deps)` + ack policy |
| `scheduled` | `compose(env, ctx)`, log one line per tick | idempotent sweep |
| Workflow `run` | `runX(event.payload, step, compose(this.env))` | step bodies over a `StepLike` port |
| DO constructor | `compose(env)` → fields | per-entity logic |
| `WorkerEntrypoint` method | authorize, `compose(this.env)` | the privileged operation |

A split-out consumer should look like this all the way through:

```ts
export default {
  async queue(batch: MessageBatch<IndexMessage>, env: Env) {
    const deps = compose(env);                       // parse env once, typed
    await handleIndexBatch(batch.messages, deps);
    log.info("index", "batch", { messages: batch.messages.length, ...deps.stats() });
  },
} satisfies ExportedHandler<Env, IndexMessage>;
```

**Check:** `wc -l apps/*/src/index.ts apps/*/worker/index.ts` stays under ~150 lines each;
`rg -n 'prepare\(|SELECT |INSERT |UPDATE ' apps/*/src/index.ts apps/*/worker/index.ts` is empty.

---

## One package = one worker = SPA + API

**Why:** a separate web package plus a dev proxy duplicates config, drifts on routing, and lets the
SPA and API ship out of step.

An app with a UI is **one** package and **one** Worker. `@cloudflare/vite-plugin` builds the SPA,
runs the Hono Worker in workerd during `vite dev`, and serves `/api/*` in the same process. No dev
proxy, no predev build, no second package.

```jsonc
// apps/w-app/wrangler.jsonc — the Vite plugin fills `assets.directory` in the built config
"assets": {
  "binding": "ASSETS",
  "not_found_handling": "single-page-application",
  "run_worker_first": ["/api/*"]          // add "/" only if the Worker redirects bare / to a mount
}
```

- `assets` is documented as inheritable, but bindings are not, and a named env that ships without
  its assets is a blank site. Verify the flattened per-env output (`dist/<worker>/wrangler.json`
  built with `CLOUDFLARE_ENV=<env>`) contains the `assets` block; repeating it per env is cheap.
- An array `run_worker_first` invokes the Worker only on matching paths, and it turns off the
  automatic `Sec-Fetch-Mode: navigate` detection. Everything else is served as an asset or falls
  back to the SPA's `index.html`.
- **The mount path goes on the router basename, never on Vite `base`.** Static assets are served
  from the root of the client build. Setting `base: "/ui/"` rewrites script tags to
  `/ui/assets/*`, those paths miss, the SPA fallback returns `index.html` with **200 text/html**,
  the browser rejects it as a module script, and the page is **blank**. It shipped twice: the first
  fix moved the build output, and the second one recurred. Mount path and asset base are separate
  axes. Keep `base: "/"` and set `createBrowserRouter(routes, { basename: "/ui" })`.
- The same 200 text/html fallback hides a stale chunk after a deploy. Treat a JS request answered
  with HTML as an error in the client loader.

**Check:** `rg -n '\bbase:' apps/*/vite.config.ts` finds nothing, or only `"/"`. In a smoke test,
fetch the built `index.html`, request every `<script src>` and `<link href>` it references, and
assert that none has `content-type: text/html`.

### One `vite dev` runs the fleet

```ts
// apps/w-app/vite.config.ts
cloudflare({
  auxiliaryWorkers: ["q-consumer-enrich", "q-consumer-index", "q-consumer-analytics",
                     "wf-vendorx-fetch", "cron-reaper"]
    .map((d) => ({ configPath: path.resolve(__dirname, `../${d}/wrangler.jsonc`) })),
})
```

- Separate dev sessions share service bindings, but Queues with a separated producer and consumer
  (and cross-script Workflow / DO `script_name`) need one dev command. Make them auxiliary Workers
  of the same `vite dev` (or pass several `-c` to one `wrangler dev`).
- Each Worker resolves local secrets next to its **own** config; nothing is inherited from the
  entry Worker. Commit a `.dev.vars.example` per deployable.
- `wrangler deploy` on the entry Worker deploys only the entry. Deploy each auxiliary Worker
  individually: `wrangler deploy -c dist/<worker>/wrangler.json`.
- Under e2e with the fake durable layer, drop the auxiliary Workers ([testing](testing.md#layer-3--playwright-against-vite-dev-with-the-fake-durable-layer)).

---

## Inter-worker calls: RPC over a service binding

**Rule:** privileged worker-to-worker calls go through a named `WorkerEntrypoint` reached over a
service binding, never through a public `/api/internal/*` or `/api/admin/*` route on the
user-facing worker.
**Why:** an internal HTTP route is reachable from the internet and needs its own shared-secret auth
that someone will get wrong; a service binding is not routable and the call is typed end to end.

```ts
// apps/w-app/worker/rpc.ts — exported from worker/index.ts
export class AdminRpc extends WorkerEntrypoint<Env> {
  async removeDocument(input: RemoveDocumentInput, actor: AdminActor): Promise<RemoveResult> {
    assertAdmin(actor);                         // the owner authorizes too, not only the caller
    return removeDocument(compose(this.env), input);  // core; owner holds SEARCH_DB, R2, INDEX
  }
}
```

```jsonc
// apps/w-admin/wrangler.jsonc — per env, env-qualified target
"env": {
  "dev":  { "services": [{ "binding": "APP", "service": "dev-acme-w-app",  "entrypoint": "AdminRpc" }] },
  "prod": { "services": [{ "binding": "APP", "service": "prod-acme-w-app", "entrypoint": "AdminRpc" }] }
}
```

- The `service` field (and any Workflow or DO `script_name`) is the **deployed script name for
  that env**: the env's own `name`, or `<name>-<env>` by default. Never use the top-level name. A
  production admin deploy failed because it pointed at the top-level script name, which does not
  exist in production.
- `RemoveDocumentInput`, `RemoveResult` and the `AdminRpc` method signatures live in
  `packages/contracts`, and both sides import them.

**Check:** `rg -n '/api/(internal|admin)/' apps/w-app` is empty. For each env,
`rg -n '"(service|script_name)"' apps/*/wrangler.jsonc` resolves to a script `name` declared in
that same env of the target's config.

---

## Second app (admin) shape

**Rule:** `w-admin` copies `w-app`'s shape: one package, SPA + API, `@cloudflare/vite-plugin`, its
own composition root, its own auth.
**Why:** a second app with a bespoke shape gets its own dev setup, its own bugs, and a back door
into data it does not own.

- Data access follows the project's ownership model ([data](data.md#1-ownership-choose-a-model-and-write-it-down)). With a shared D1 and one schema
  owner, admin binds it as a **tenant**: it reads freely, its own tables (`admin_*`) come from the
  owner's migrations, and it never runs DDL (no-DDL test). With database-per-service, admin reads
  and writes through the owner's RPC.
- Either way, writes that touch the owner's bindings or derived stores (search index, R2, queues)
  go through RPC to the owner. Do not use a second data-access path.
- In dev, either run the owner as an auxiliary Worker of the admin dev server, or inject a fake
  binding that calls the **same core function**. A stub that returns success proves nothing.
- Keep one data-access dialect. If an admin package has raw SQL, an ORM and RPC side by side, it
  has stopped being a tenant.

---

## Marketing site: `pages-` with zero workspace deps

**Why:** a marketing site that imports workspace code redeploys on every core change and breaks
when the app does.

- `apps/pages-website` has **no `workspace:` dependencies**, runs no shared code, and has its own
  deploy lane, path-filtered to its own directory.
- If it shows live product content, fetch it **at build time** with a timeout, a committed snapshot
  fallback, and an observable marker in the output (`data-content-source="live|snapshot"`). Test
  that a normal build produces `live`: a fallback that always fires is a broken feature.

**Check:** `rg -n '"workspace:' apps/pages-website/package.json` is empty.

---

## Archived and harness apps are fenced off

**Why:** an unfenced archived or harness app gets "fixed", rewired into the fleet, or counted as a
deployable by agents and gates.

- An archived app keeps a scoped `AGENTS.md` that says "archived: do not delete, rewire, or add
  features". It has no `check:deploy` script, so turbo never discovers it as a deployable.
- An acceptance or test harness under `apps/` is not a deployable. It has no `wrangler deploy`
  and is never in `auxiliaryWorkers`, and the root repo map lists it separately with a one-line
  reason.

**Check:** the set of packages with a `check:deploy` script equals the deployables table in the root
`AGENTS.md`. Derive the table, or diff it in `check`.

---

## Splitting a worker out: what travels and what doesn't

**Copy the topology, not the internals.** The new worker gets the queue protocol (routing by queue
name, ack policy, batch settings, DLQ) and a fresh thin entrypoint over the **same** core handler.
Leave behind the original's boot-time init, its whole-app config loader and its test-only branches.
Split-out workers have carried boot DDL with them before, and ended up creating production tables
outside the migration ledger. A cloned memoized init copies the hang hazard as well.

Consumer registration, secrets, kill-switch secrets, local dev entries, gates and docs do **not**
move on their own; each is an explicit step in every env, in a fixed order. The phased procedure,
with gates and rollback, is [playbooks §1](playbooks.md#1-split-a-consumer-cron-or-workflow-out-of-the-main-worker).

**Check:** after the split, `rg -n '<queue-suffix>' apps/w-app/wrangler.jsonc` shows only a
producer. `rg -n 'on<Name>Batch' apps/w-app` is empty. `wrangler secret list --env <env>` on the
new script lists every secret its config parser requires.
