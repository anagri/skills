# Bindings & config

Covers SKILL rules **9–12**: the composition root, typed config, the binding facade, narrow deps,
required collaborators and boot-time I/O. Binding APIs themselves belong to the `cloudflare`,
`workers-best-practices` and `wrangler` skills. This file covers **where `env` may be touched and
what has to happen before a handler runs**.

The invariant: **`env` is read in exactly one place per deployable, the composition root.**
Everything below that point receives typed config and narrow ports.

```
env ──► parseConfig(env) ──► Config ──► compose(env, cfg) ──► deps ──► core handler
        (once, typed,         (frozen,     (facade or            (narrow    (no env, no
         fail fast)            no env)      plain adapters)       ports)     cloudflare:*)
```

---

## 1. One composition root per entrypoint kind (rule 9, rule 4)

**Rule.** Every entrypoint (`fetch`, `queue`, `scheduled`, Workflow `run`, DO constructor) begins
with the same two lines: parse config, build deps. Then it delegates. A shell contains no SQL, no
business branching, and no binding calls.

Why: the main worker had a facade while every satellite worker wired raw `env` into shared
handlers. That left two DI styles, a second copy of each context object and drift between them. A
consumer that assembles its own context drifts from the one the integration suite tests.

```ts
// apps/w-app/worker/compose.ts: the ONLY module that reads env
import type { Env } from "../worker-configuration"; // generated, see §3
export function compose(env: Env) {
  const cfg = parseConfig(env);
  const cf = getCloudflareService(env, cfg); // or plain adapters if no facade (§4)
  return { cfg, cf };
}

// apps/w-app/worker/index.ts: export registry + thin shells
export { EnrichWorkflow } from "./workflows/enrich";   // discovered by export from `main`
export { SessionDO } from "./do/session";

export default {
  async fetch(req, env, ctx) {
    const { cfg, cf } = compose(env);
    return createApp({ cfg, cf, ctx }).fetch(req);       // nothing awaited before routing (§8)
  },
  async queue(batch, env) {
    const { cf } = compose(env);
    await handleIngestBatch({ storage: cf.d1(), workflows: cf.workflows() }, batch.messages);
  },
  async scheduled(ctrl, env, ctx) {
    const { cf } = compose(env);
    ctx.waitUntil(reapStale({ storage: cf.d1(), now: Date.now }));   // short and bounded only
  },
} satisfies ExportedHandler<Env, IngestMessage>;

// workflows/enrich.ts
export class EnrichWorkflow extends WorkflowEntrypoint<Env, EnrichParams> {
  async run(event: WorkflowEvent<EnrichParams>, step: WorkflowStep) {
    const { cfg, cf } = compose(this.env);
    return runEnrich({ storage: cf.d1(), vendor: cf.vendorx(), cfg }, event.payload, asStepLike(step));
  }
}

// do/session.ts
export class SessionDO extends DurableObject<Env> {
  private readonly deps;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.deps = sessionDeps(compose(env), ctx.storage);  // no I/O here; build only
  }
}
```

How to check:
- `grep -rnE "\benv\.[A-Z_]+" apps/*/worker apps/*/src | grep -v compose.ts | grep -v /cf/` returns
  nothing.
- `grep -rnE "import \{[^}]*\benv\b[^}]*\} from \"cloudflare:workers\"" apps packages` hits only
  the composition root. The global `env` import bypasses every check above if left unbanned.
- Entrypoint files stay small (about 150 lines or fewer) and contain no `prepare(` or `SELECT`.
- Every `apps/*` deployable has a `compose` (or `cf/factory`) module. That includes satellites
  (`q-consumer-*`, `cron-*`), not just the main worker.
- `satisfies ExportedHandler<Env, Msg>` is on every default export, so the queue message type is
  checked against the shared contract.

Building the app per request is fine. Hono app construction is cheap, and per-invocation facades
give per-request counters (D1 round trips, rows) for free. Memoize only what is expensive and pure.

---

## 2. Parse `env` once into a typed `Config` (rule 9)

**Rule.** `parseConfig(env)` validates with Zod and returns a frozen, typed `Config`. Core secrets
throw. Optional features become `null` and **stay closed** when unconfigured. They never run
degraded. Nothing downstream reads a string var.

Why: casting `env as Record<string,string>` and reading vars ad hoc lets a missing secret surface
deep inside a request as `undefined`. A feature that runs without its protection is worse than one
that declines: an unsigned session cookie lets anyone act as anyone else.

```ts
// packages/core/src/config/parse.ts is runtime-neutral (takes a plain record)
const RuntimeEnv = z.enum(["local", "test", "dev", "prod"]);
const flag = z.enum(["0", "1"]).optional().transform((v) => v === "1");

const Raw = z.object({
  RUNTIME_ENV: RuntimeEnv,
  PUBLIC_ORIGIN: z.string().url(),
  SESSION_SECRET: z.string().min(32),           // core: fail fast
  VENDORX_API_KEY: z.string().optional(),       // feature: closed when absent
  CAPTCHA_SECRET: z.string().optional(),
  ENRICH_BUDGET: z.coerce.number().int().positive().default(500),
  USE_FAKE_CF: flag, USE_FAKE_AI: flag, USE_FAKE_VENDORX: flag,
});

export type Config = Readonly<ReturnType<typeof toConfig>>;
export function parseConfig(env: Record<string, unknown>) {
  const r = Raw.safeParse(env);
  if (!r.success) throw new Error(`invalid config: ${r.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  return Object.freeze(toConfig(r.data));
}
function toConfig(e: z.infer<typeof Raw>) {
  return {
    runtimeEnv: e.RUNTIME_ENV,
    publicOrigin: e.PUBLIC_ORIGIN.replace(/\/$/, ""),
    sessionSecret: e.SESSION_SECRET,
    vendorx: e.VENDORX_API_KEY ? { apiKey: e.VENDORX_API_KEY } : null, // null = feature off
    publicSignup: e.CAPTCHA_SECRET ? { captchaSecret: e.CAPTCHA_SECRET } : null,
    enrichBudget: e.ENRICH_BUDGET,
    fakes: { cf: e.USE_FAKE_CF, ai: e.USE_FAKE_AI, vendorx: e.USE_FAKE_VENDORX },
  };
}
```

The feature checks `if (!cfg.vendorx) return declined("vendorx_unconfigured")`. Do not fall back to
an unauthenticated or unmetered path.

| Kind of var | Missing means | Parse as |
|---|---|---|
| Core secret (session key, encryption key, primary API key) | misconfiguration | required → throw |
| Feature config (vendor key, captcha pair, gateway id) | feature off | optional → `null` object → route declines |
| Tunable (budget, batch size, timeout) | default | `.default(n)` in **one** shared parser that every deployable imports |
| Test/dev switch (`USE_FAKE_*`, `DEV_ROUTES`) | off | `flag`, refused outside local/test (§4) |

How to check:
- A unit test feeds `parseConfig` an empty record (it throws, naming the core keys) and the
  minimal valid record (every feature is `null`).
- `grep -rn "as unknown as Record<string" apps/` returns nothing.
- Value parsers (budget caps, durations) live in `core` and are imported by every deployable that
  reads the var, so two workers cannot parse `ENRICH_BUDGET` differently.
- Keep one `Config` shape per deployable. Do not create a "shared config" that every worker
  half-fills.

**Each switch does exactly one job.** Do not key a security relaxation (an SSRF allow-local, an
auth bypass) on a flag that is also set in a deployed env for another reason. A shared dev env
exposed to the internet is still public.

---

## 3. One env vocabulary; generated `Env` types

**Rule.** Use one variable (`RUNTIME_ENV`) with exactly `local | test | dev | prod` across every
deployable. Wrangler env names, resource prefixes (`{env}-acme-db`) and this value use the same
words.

Why: two spellings (`prod` in one worker, `production` in another) make every `=== "prod"` check
fail open or closed depending on the file. A default such as "anything unknown → prod" turns a typo
into a production code path.

**Rule.** Generate `Env` with `wrangler types` and commit it. Never hand-write it.

Why: hand-written `Env` interfaces drift from the config and get marked optional "to be safe".
`wrangler types` aggregates bindings from **all** named envs by default. A binding present in only
some envs comes out optional, which is a useful signal that your envs are asymmetric. `--check`
exits non-zero when the generated file is stale.

```jsonc
// apps/w-app/package.json
"scripts": {
  "types": "wrangler types worker-configuration.d.ts",
  "check:types": "wrangler types worker-configuration.d.ts --check"
}
```

How to check:
- `grep -rhoE "RUNTIME_ENV\"?\s*:\s*\"[a-z]+\"" apps/*/wrangler.jsonc | sort -u` shows only the four
  words.
- `check:types` is part of the per-deployable gate discovered by turbo (see
  [governance](governance.md)).
- An optional binding in the generated `Env` is either a deliberate asymmetry, written in the config
  next to it, or a missing block in one env (see [wrangler-and-local-dev](wrangler-and-local-dev.md)
  on non-inheritable keys).

Note that `import { env } from "cloudflare:workers"` makes bindings reachable from any module, even
top-level ones (I/O still needs a request context). That convenience is exactly what this file
forbids in `core`. Ban `cloudflare:*` there with the boundary lint ([packages-and-contracts](packages-and-contracts.md)).

---

## 4. The binding facade (Live / Fake): situational (rule 10)

A facade is a typed interface over *every* binding a worker uses. It has a Live implementation
and a Fake one, selected once in the composition root. It is **not** mandatory. Every deployable
needs a composition root; only some need a facade.

### When a deployable gets one

| Signal | Facade? |
|---|---|
| A UI shows the outcome of a Workflow or Queue the worker starts | **Yes.** Under the local runtime, queues do not drain inside the triggering request, so Playwright cannot see the result without a fake that completes the work synchronously. |
| It calls paid/external services (vendor API, Workers AI) that e2e must not hit | **Yes.** An AI binding always runs remotely and bills even in local dev. |
| It produces messages consumed by another deployable and you need deterministic e2e | Yes |
| A queue consumer or cron over D1 with no UI and no paid call | **No.** A composition root plus layer-2 integration tests (`@cloudflare/vitest-plugin`) are enough. |
| Static site / pure proxy | No |

### Shape

Expose **typed verbs**, not raw bindings. App code calls `workflows().enrich(params)`, never
`env.ENRICH_WF.create(...)`. Instance-id derivation and "already exists ⇒ in flight" handling then
live in one place.

```ts
// apps/w-app/worker/cf/service.ts
export interface CloudflareService {
  d1(): Storage;                         // port from core, memoized per instance
  workflows(): { enrich(p: EnrichParams): Promise<{ id: string }> };
  queues(): { enrich(ids: readonly string[]): Promise<void>; index(): IndexEmitter };
  r2(): BlobStore;
  ai(): AiService;
  vendorx(): VendorxClient;
  d1Stats(): D1Stats;                    // round trips this invocation (observability)
}

// apps/w-app/worker/cf/factory.ts
export function getCloudflareService(env: Env, cfg: Config): CloudflareService {
  const anyFake = cfg.fakes.cf || cfg.fakes.ai || cfg.fakes.vendorx;
  if (anyFake && cfg.runtimeEnv !== "local" && cfg.runtimeEnv !== "test")
    throw new Error("USE_FAKE_* is refused outside local/test");   // guards ALL switches
  const live = new CloudflareServiceLive(env, cfg);                // ai()/vendorx() honour their own flags
  if (!cfg.fakes.cf) return live;
  // Fake durable layer: D1 and R2 stay REAL; Workflows/Queues write their final D1 outcome
  // synchronously through the same core functions the real consumers call.
  return new CloudflareServiceFake({ d1: live.d1(), r2: live.r2(), ai: live.ai(), vendorx: live.vendorx() });
}
```

**Rules for the fake.**
- **Fake only what the local runtime cannot observe or should not pay for.** Keep D1 and R2 real.
  Durable Objects run fully locally, so keep them Live everywhere.
- **The fake runs production code for the outcome.** It calls the same `core` handlers and the same
  idempotency gate (the conditional `UPDATE … RETURNING` claim). It must not hand-write the
  rows it thinks the pipeline would produce. Pin that with a fake-vs-live equivalence test over the
  same seed ([testing](testing.md)).
- **Fakes are constructible only in local/test.** Check the env in the factory (above) and also
  exclude the fake modules from deployed builds (alias to a throwing stub). A test asserts that no
  deployed wrangler env sets any `USE_FAKE_*` ([testing](testing.md), rule 25).
- **One switch per external cost.** `USE_FAKE_CF` (durable layer), `USE_FAKE_AI` (inference),
  `USE_FAKE_VENDORX` (paid vendor). The integration suite wants the *real* durable pipeline but must
  never reach paid inference, so a single "fake everything" flag cannot express it. Live's `ai()`
  returns the scripted fake when `USE_FAKE_AI` is set, so that flag is the only thing deciding
  whether inference is real.
- **Stubs that simulate a vendor enter in exactly one place**: inside the fake branch of the
  factory.

How to check:
- `grep -rnE "env\.[A-Z_]+" apps/w-app/worker | grep -v "/cf/"` returns nothing.
- `grep -rln "Fake" apps/*/worker | xargs grep -l "new .*Fake"` shows only `cf/factory.ts` and tests.
- After a production build, `grep -c "CloudflareServiceFake" dist/**/*.js` is `0`.

### Escape-hatch creep: a smell

Facades accumulate methods that return raw handles, such as `primaryDb(): D1Like`,
`imagesBucket(): R2Bucket`, a synchronous `inlineIndex()` for a seed route, or a "port for this one
module". Each one is locally justified. Together they recreate `env` with extra steps, and the fake
must mirror each one.

| Escape hatch | Better |
|---|---|
| Raw DB handle for one module that owns its SQL | Give that module its own port (`ReportReads`) returned by the facade |
| Raw bucket for one route | Add the verb (`getImage(key)`) |
| Test-only synchronous variant | Put it on the fake only, behind the factory branch |
| Optional `bucket?: R2Bucket` "undefined in unit tests" | Inject an in-memory `BlobStore` in tests; keep the type required |

How to check: count facade methods whose return type is a platform type (`D1Database`, `R2Bucket`,
`Queue`, `DurableObjectNamespace` other than deliberate DO namespaces). Every one needs a one-line
reason at its declaration. Flag more than about 2 in an audit.

---

## 5. Narrow deps per route module; handlers never read `c.env`

**Rule.** Each route module exports `xxxRoutes(deps: XxxDeps)`, where `XxxDeps` names only what it
uses. `createApp` is the only place that slices the facade into deps. Prefer a closure or probe over
a whole service when the module needs one capability.

```ts
export interface DocumentRoutesDeps {
  storage: Pick<Storage, "getDocument" | "listDocuments" | "markRequested">;
  enqueueEnrich: (ids: readonly string[]) => Promise<void>;   // a verb, not QueuesService
  cfg: Pick<Config, "publicOrigin">;
}
export interface PublicShareDeps {
  hasSession: (id: string) => Promise<boolean>;  // a probe: knows THAT, never WHAT
}
```

Why: the deps interface is the module's blast radius, written in the type system. Tests build one
router against in-memory SQL with recording fakes and no Cloudflare toolchain. A handler reading
`c.env` bypasses config parsing, the facade and the fake switch all at once.

How to check:
- `grep -rn "c\.env" apps/*/worker` returns nothing.
- No route module imports `cf/service` except `app.ts`.
- Reject deps assembled by object spread (`{ ...cf, ...extra }`). Spread defeats TypeScript's
  excess-property check, so a renamed field silently becomes a new, unused one. Build deps
  literals explicitly.

---

## 6. Side-effecting collaborators are required (rule 11)

**Rule.** Queue producers, event emitters, workflow starters and analytics sinks are **required**
parameters. Never write `emitter?: IndexEmitter` or an optional trailing argument.

Why: an optional producer compiles into a silent no-op. In one incident a tool endpoint called the
"prioritize" function with one argument fewer than the REST route, omitting the emitter. It wrote
`status='queued'`, returned success and enqueued nothing. A periodic sweep that re-scanned the table
masked it for weeks. When the sweep was removed, every such request became an hour-long wait for
the backlog reconcile. A retry verb had the same shape: it reset the row, returned 202 and never
produced.

To express "this path must not emit", pass an explicit `noopEmitter`, so the choice is visible at
the call site.

How to check:
```sh
# optional side-effect deps or params
grep -rnE "\w+\?\s*:\s*\w*(Emitter|Producer|Queue|Queues|Workflows?|Sink|Analytics)\b" packages/core apps/*/worker
```
Also add a test per producing endpoint that asserts the recording producer received the expected
ids. "Returned 2xx" is not the assertion.

---

## 7. Config and secrets locally

- Each deployable has its own `.dev.vars.example` listing every key `parseConfig` requires. The
  `required` error message names that file.
- Auxiliary workers composed by `@cloudflare/vite-plugin` read their **own** config and secrets.
  Do not assume they inherit the main worker's. Fail-fast parsing makes that a loud first-request
  error instead of a silent default.
- Only local/test config sets `USE_FAKE_*`; no deployed wrangler env does. The e2e config sets all
  three; the integration config sets `USE_FAKE_AI`/`USE_FAKE_VENDORX` but **not** `USE_FAKE_CF`,
  because it exists to run the real durable pipeline ([wrangler-and-local-dev](wrangler-and-local-dev.md)).
- Declare secrets in wrangler's `secrets.required` where your wrangler version supports it:
  `wrangler types` then types them without a `.dev.vars` present, local dev loads only the listed
  keys, and deploy fails if one is unset. `parseConfig` still owns the semantic checks (length,
  format, feature-closed).

---

## 8. No I/O before routing; bounded, success-only init (rule 12)

**Rule.** A deployed worker awaits **nothing** before handing the request to the router: no schema
init, no warm-up queries, no config fetched from D1. Schema belongs to migrations
([data](data.md)). Boot-time `CREATE … IF NOT EXISTS` exists only to build a fresh local or e2e
database when migrations cannot be applied first, and is gated on `runtimeEnv ∈ {local, test}`.
Prefer applying the Drizzle-generated migrations before any dev server or test pool boots (rule 23);
then the deployed and local init paths are both empty.

### The production hang

A deployed API worker ran an idempotent `CREATE … IF NOT EXISTS` against the search database on the
first request of each isolate. It memoized the **pending** promise so that later requests would
share it. The DDL needed the write lock on a single-writer database, and it sat behind the index
consumer's long batches. The client gave up, the invocation was canceled, and the memo kept the
promise forever. Every later request on that isolate awaited it at 0 CPU. About half of
production's API hung until the isolates were recycled.

- **Signature:** outcome `canceled`, CPU time ~0, no access-log line (the logger sits after the
  await).
- **Spread:** a second worker that copied the "init on boot" pattern ran the full primary schema
  on every cold request in every env. Patterns get cloned along with their hazards.

### If an init memo must exist (local/test only, or for a consumer's own store)

Bound each attempt, cache **only success**, and clear on failure or timeout so that the next
invocation retries instead of joining a dead wait.

```ts
// packages/core/src/init.ts
export function makeEnsureInit(timeoutMs = 10_000) {
  let ok: Promise<void> | undefined;
  return (target: { init(): Promise<void> }) => {
    ok ??= withTimeout(target.init(), timeoutMs).catch((err) => {
      ok = undefined;              // rejection or timeout: next invocation retries
      throw err;
    });
    return ok;
  };
}
function withTimeout(p: Promise<void>, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  p.catch(() => {});               // the abandoned attempt must not become an unhandled rejection
  const expiry = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`init > ${ms}ms`)), ms); });
  return Promise.race([p, expiry]).finally(() => clearTimeout(t));
}
```

```ts
// CloudflareServiceLive.init(): a no-op in every deployed env
async init() {
  if (this.cfg.runtimeEnv !== "local" && this.cfg.runtimeEnv !== "test") return;
  await this.ensureInit(this.search);   // makeEnsureInit(): bounded, success-only
}
```

How to check:
- A test builds the Live service with `runtimeEnv: "prod"`, runs `init()` and the router's
  pre-handler path over a traced D1, and asserts **zero** round trips.
- A unit test on `makeEnsureInit`: a never-settling init rejects after the timeout, and the next
  call invokes `init()` again. A rejected init is retried, not re-thrown from cache.
- Grep each entrypoint: the only `await` before `createApp(...).fetch` is inside a
  `runtimeEnv`-gated branch.
- Per-test reset in e2e must also reset the memo, or the second test sees "already initialized"
  against a wiped DB.

---

## Quick audit table

| Check | Command / test | Severity if failing |
|---|---|---|
| `env` read outside compose/`cf/` | `grep -rnE "env\.[A-Z_]+"` (see §1) | M |
| `c.env` in a handler | `grep -rn "c\.env"` | M |
| `env` cast instead of parsed | `grep -rn "as unknown as Record<string"` | L |
| Hand-written `Env` / stale types | `wrangler types --check` per deployable | M |
| Mixed env vocabulary | grep `RUNTIME_ENV` values | M |
| Fake reachable in a deployed env | factory guard + no-`USE_FAKE_*` test + bundle grep | **H** |
| One switch for several external costs | read `Config.fakes` | M |
| Optional side-effect deps | grep in §6 | M |
| Facade escape hatches without a stated reason | count raw-handle return types | L |
| I/O before routing in deployed env | zero-round-trip test | **H** |
| Init memo caches pending/rejected promise or is unbounded | `makeEnsureInit` tests | **H** |
