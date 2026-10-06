# Observability, error taxonomy and cost metering

Rule 26 in full: **one logger that emits objects; one error taxonomy (domain vs transient)
decides log level, retry and ack at every entrypoint kind; telemetry leaves the hot path through a
queue.** This file also covers instrumentation choke points, correlation, platform config,
alerting and spend metering. Product APIs (Workers Logs query builder, OTel export, trace spans)
are in the `cloudflare` and `workers-best-practices` skills.

All of it lives in one framework-free module in `core` (for example `core/observability/{log,
errors,http-log,telemetry}.ts`). It imports no Hono and no `cloudflare:*` value, so every
deployable (`w-app`, `w-admin`, `q-consumer-*`, `wf-*`, `cron-*`) wires the same code at its own
entrypoint. Extract it into `core` as soon as a second deployable needs it. Copies drift: two
workers carrying their own access-log code diverge within weeks.

## 1. One logger, objects only

**Rule.** Every backend log line goes through `log.{info,warn,error}(tag, event, fields, err?)`,
which emits **one object**. Never use `console.log(string, json)`, and never call `console.*`
outside the logger.

Why: Workers Logs indexes the properties of a logged object as queryable fields, but string
arguments end up in `message`. In one production app the logger concatenated a string with a JSON
blob, and for weeks no one could filter or aggregate `ms`, `status` or `errorKind`. The
first perf baseline had to string-parse raw events.

```ts
// core/observability/log.ts
export type LogTag = 'http' | 'workflow' | 'queue' | 'cron' | 'enrich' | 'index' | (string & {});
export type LogFields = Record<string, unknown>;

function emit(level: 'info' | 'warn' | 'error', tag: LogTag, event: string, fields: LogFields) {
  // tag/event spread LAST: a caller field must never shadow the keys every query groups by.
  const entry = { ...fields, tag, event, message: `[${tag}] ${event}` };
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(entry);
}

export const log = {
  info: (tag: LogTag, event: string, f: LogFields = {}) => emit('info', tag, event, f),
  warn: (tag: LogTag, event: string, f: LogFields = {}, err?: unknown) =>
    emit('warn', tag, event, err === undefined ? f : { ...f, ...errorFields(err) }),
  error: (tag: LogTag, event: string, f: LogFields = {}, err?: unknown) =>
    emit('error', tag, event, err === undefined ? f : { ...f, ...errorFields(err) }),
};
```

- `(string & {})` lets a new worker use its own tag without editing `core`, and autocomplete
  still works for the known tags.
- `tag:http AND event:request` is the access log, and `tag:workflow AND event:step` is step
  timing. Pick the event vocabulary once and keep it.
- **Redaction.** Log ids, counts and reasons only: never tokens, emails, cookies or raw bodies.
  A convention will be broken, so enforce it. Type `LogFields` against a denylist of keys, or add
  a test that greps log call sites for `token|email|cookie|authorization`. In one project a docs
  sync turned up a cookie being logged.

**How to check.**
- A unit test asserts the shape: `expect(spy).toHaveBeenCalledWith(expect.objectContaining({tag:'http', event:'request'}))`.
- `rg -n "console\.(log|warn|error)\(" apps packages --glob '!**/observability/log.ts' --glob '!**/*.test.ts'`
  returns nothing. A publishable package that cannot depend on `core` takes a `Logger` interface
  from `contracts` by injection; it does not fall back to `console.*`.
- After the first deploy, run one real query in the dashboard that filters on a custom field. A
  shape that looks right in tests has fooled people before.

## 2. Normalized error fields

**Rule.** Passing `err` merges a fixed set of fields: `error`, `errorName`, `cause`, `errorKind`
and `reason`.

Why: ORMs and drivers rethrow with the database error in `cause`. Without that field the line
says which query failed but not why. With `errorKind`, a single line tells you whether the
failure was expected or a bug.

```ts
export function errorFields(err: unknown): LogFields {
  const c = classifyError(err);
  return {
    error: err instanceof Error ? err.message : String(err),
    errorName: err instanceof Error ? err.name : undefined,
    cause: err instanceof Error && err.cause instanceof Error ? err.cause.message : undefined,
    errorKind: c.kind,
    reason: c.reason,
  };
}
```

**Check:** whenever a wrapper logs a failure, it passes `err`. A step wrapper that logs
`outcome:'threw'` without `err` leaves every caller that skips the shared failure handler with no
error detail at all.

## 3. One error taxonomy, applied at every entrypoint kind

**Rule.** Every thrown value classifies into exactly one of two kinds:

| Kind | Meaning | Log | Retry? |
|---|---|---|---|
| `DomainError` (permanent) | expected, caused by input or external state: quota, auth, not found, validation | `warn` | **no**: ack, or end terminal |
| `TransientError` (unexpected) | a bug, infrastructure, a timeout, a D1 hiccup, a vendor 5xx | `error` | **yes**: retry with backoff |

Why: retrying a quota or auth failure burns retries (and quota), delays the terminal status the
UI polls for, fills the DLQ with expected failures and buries the real ones. Not retrying a
transient failure loses work.

```ts
// core/observability/errors.ts
export class DomainError extends Error {
  readonly kind = 'domain' as const;
  constructor(readonly reason: string, message?: string) { super(message ?? reason); this.name = 'DomainError'; }
}
export class TransientError extends Error {
  readonly kind = 'transient' as const;
  constructor(readonly reason: string, message?: string, opts?: { cause?: unknown }) {
    super(message ?? reason, opts); this.name = 'TransientError';
  }
}
export function classifyError(err: unknown) {
  if (err instanceof DomainError) return { kind: 'domain', reason: err.reason, retryable: false } as const;
  if (err instanceof TransientError) return { kind: 'transient', reason: err.reason, retryable: true } as const;
  // Vendor client errors: detect structurally (name + reason) so core needn't import the client.
  if (err instanceof Error && err.name === 'VendorApiError' && typeof (err as any).permanent === 'boolean')
    return (err as any).permanent
      ? ({ kind: 'domain', reason: (err as any).reason, retryable: false } as const)
      : ({ kind: 'transient', reason: (err as any).reason, retryable: true } as const);
  return { kind: 'transient', reason: 'unexpected', retryable: true } as const; // unknown = bug = retry
}
```

- **Construct the typed errors at the throw sites.** Do not classify by matching message
  substrings: the classification silently changes when someone rewords an error. One audited
  codebase declared both classes but never constructed either; in practice its classifier ran on
  two hard-coded message strings.
- Unknown errors default to `transient`. Treating a bug as permanent hides it, and treating it as
  retryable surfaces it in the DLQ.

### Applying it per entrypoint kind

| Entrypoint | Domain (permanent) | Transient |
|---|---|---|
| HTTP (`fetch`) | 4xx with a stable `reason` code, `warn` | 5xx, `error` (onError middleware) |
| Queue (`queue`) | `msg.ack()` + `warn` | `msg.retry({ delaySeconds: backoff(msg.attempts) })` + `error`; DLQ after `max_retries` |
| Workflow (`run`) | persist the terminal status row, then end the instance (catch and return, or throw `NonRetryableError` from `cloudflare:workflows`) | throw from the step so step `retries` apply; persist status when retries run out |
| Cron (`scheduled`) | log and skip the item; the tick continues | log `error`; the next tick or the reaper retries |
| MCP / RPC tool | return a structured error result (`isError`), not a success body | throw, or return an error with `retryable:true` |

One shared helper per kind, in `core`. Never inline the decision. The queue helper is
`consumeEach` in [async Q3](async.md#q3-every-consumer-has-a-written-ack-policy-enforced-through-one-shared-failure-helper):
it calls `classifyError`, acks non-retryable errors at `warn`, and retries the rest per message with
`delaySeconds` backoff at `error`.

Workflows: one `handleWorkflowFailure(err, statusRow)` classifies, logs, persists the terminal
status and rethrows only when the error is retryable. Pick **one** failure idiom per project,
either this helper or `Outcome`-returning steps (`{ok:false, reason}`) for flows that must always
reach a terminal UI state. Do not let three idioms grow. An outer `catch` that logs `run_crashed`
and never rethrows marks a real bug's instance as *complete*.

**How to check.**
- `rg -n "new (DomainError|TransientError)\(" apps packages --glob '!**/*.test.ts'` returns
  matches. An empty result means the taxonomy exists in name only.
- `rg -n "\.retry\(|retryAll\(" apps packages` hits only the shared consumer helper (`consumeEach`).
- A unit test per helper: a domain error leads to `ack` and `warn`; a transient error leads to
  `retry` with a delay.

## 4. Instrument at choke points, once per entrypoint kind

**Rule.** All traffic of a given entrypoint kind already passes through one point. Measure there,
never at individual call sites.

| Kind | Choke point | One line with |
|---|---|---|
| HTTP | app middleware calls `logRequest({method, route, status, ms, ...db})` | route pattern (not raw path), status, `ms`, `db_waves`, `db_rows_read`, `db_rows_written` |
| Workflow | the shared step wrapper | `stepName`, `ms`, `outcome` (the callback never runs on replay, so a line proves real execution) |
| Queue | per batch | `size`, `acked`, `retried`, `ms`, `db_*` |
| Cron | per tick, **including idle ticks** | `scanned`, `changed`, `ms`, `db_*` (an idle tick is the baseline you compare a slow one to) |

- `logRequest` takes plain numbers, not a framework context, so `core` stays independent of Hono.
- Wrap the D1 port structurally (`tracedD1(db): D1Like & { stats() }`) to count statements,
  **waves** (serial round trips; concurrent calls and a `batch()` each count as one), rows read and
  rows written. Wave counts predict latency and rows read predict cost (rule 16). Tests assert
  wave counts per route, so adding a hop means visibly editing a test.
- Use the same wrapper in every deployable, especially the one that spends money. In one audit
  the paid-vendor worker was the only consumer without D1 counters.

**Background workers are the least visible.** `queue()`, `scheduled()` and Workflow `run()` never
pass through HTTP middleware. In one system nothing instrumented them until a baseline found the
enrich consumer spending seconds of wall time per invocation for milliseconds of CPU. Give every
background entrypoint its per-batch or per-tick line on the day you create it.

**Check:** for each `apps/*` entry file, `rg -n "logRequest|logBatch|logTick|asStep" apps/<x>/src`
returns a hit for every handler the file exports.

## 5. Correlation: request id and async hops

**Rule.** Echo the platform request id (`cf-ray`) in a response header such as
`x-request-id`. The SPA's API client remembers the last one and attaches it to client telemetry
(boot timeline, error reports). For async hops, carry a `correlationId` **field in the queue
message and the Workflow params**, defined in `contracts`, and log it on every line.

Why: a slow page turned out to be time spent after the bundle parsed, which no worker can see; the
browser timing plus the request id localized it. Without a carried id, a document's path through
`w-app → q-consumer-enrich → q-consumer-index` can only be stitched together from domain ids, and
not every line carries them.

```ts
// contracts/messages.ts — still id-only (rule 6); correlationId is optional, absence is safe
export interface EnrichMessage { documentId: string; vendorFetch?: boolean; correlationId?: string }
```

Check what the platform propagates before you build your own. Automatic tracing now joins
service-binding and Durable Object subrequests into one trace, but a queue send or a Workflow
start is a new invocation. The message field is what crosses that boundary.

## 6. Telemetry through a queue, never on the hot path

**Rule.** Product analytics and third-party telemetry are a local `queue.send` behind a facade
method that never throws. A dedicated `q-consumer-analytics` batches events to the vendor and
always `ackAll()`s: losing analytics is acceptable, while backpressure from analytics is not. That
queue has no DLQ by design.

Why: an inline POST to the analytics vendor added a blocking round trip to every request, and
inside Workflows the step awaited it and persisted its result.

**What you lose by going indirect, and must carry in the message** (all of these broke when one
team made the switch):

| Lost | Symptom | Fix at the producer |
|---|---|---|
| event time | events dated at drain time | stamp `timestamp` |
| dedup | duplicates on redelivery | stamp `uuid` |
| geo | the vendor geolocates the CF colo's IP | send client geo, or disable server-side geoip |
| env tag | prod events tagged with the wrong env (two helpers spelled it differently) | normalize env in **one** shared helper |
| rejections | the batch is acked, so failures vanish | log `batch_rejected` at `error` with a truncated response body |

Choose sinks at the facade: `Noop` when the binding is absent, `Queue` live, `Recording` in tests,
so e2e asserts emitted events with no network. The message type lives in `contracts`.

**Check:** `rg -n "fetch\(.*(analytics|telemetry|events)" apps packages` finds no hot-path calls
outside `q-consumer-analytics`.

## 7. Platform config: identical block per env, sampling as a cost decision

**Rule.** Every env of every deployed worker carries the same `observability` block, written out in
full in each env ([wrangler-and-local-dev §3](wrangler-and-local-dev.md#3-non-inheritable-keys-are-repeated-per-env-byte-identical):
the docs list it as inheritable, but an env-level block replaces rather than merges, and an explicit
block is what the consistency test can compare). Pin it with the cross-config consistency test
(rule 22).

```jsonc
"observability": {
  "enabled": true,
  "logs":   { "enabled": true, "invocation_logs": true, "head_sampling_rate": 1 },
  "traces": { "enabled": true, "head_sampling_rate": 0.05 },  // decided per worker, see below
  "issues": { "enabled": true }                                 // recent wrangler required; see §9
}
```

- **Turn traces on before you need them.** A hung request is canceled by the runtime before any
  handler logs, so only the span tree shows what was still open.
- **Sampling is a cost decision. Make it explicitly, with a date.** Both log and trace head
  sampling default to `1`. Stored traces and logs are billable volume (check current Cloudflare
  Observability pricing and its effective dates). One team wrote "re-tune sampling before
  billing starts" in a guide and missed it: a deadline in prose is not a task. Typical
  starting points: low-traffic background workers stay at `1`, and a high-traffic `w-app` drops
  traces to a few percent while keeping logs at `1`.
- Export through OTel to an external backend if you need retention beyond the platform window
  (check current retention).

**Check:** a test over `apps/*/wrangler.jsonc` reads each env's `observability` block and asserts
it deep-equals the project's canonical block (sampling may vary by an allowed per-worker override
map).

## 8. Hung requests leave no log line

**Rule.** Know the signature: invocation `outcome = canceled`, `cpuTimeMs ≈ 0`, high
`wallTimeMs`, and **no access-log line**. Alert on it. Trust `wallTimeMs` or a trace over the
middleware's `ms`, because work done before the middleware (pre-route init) is not included in
`ms`.

Why: a request-path schema init awaited a database that was busy with long index writes. Its
memoized promise never settled, and about half of production's API hung at zero CPU for over an
hour before anyone noticed. Dozens of "exceptions" in the dashboard turned out to be
multi-second hangs that only spans could attribute. See rule 12: no I/O before routing, and any
memoized init is time-bounded and caches only success.

**Check:** a test asserts that a deployed-mode request does zero D1 waves before routing
(`expect(db.stats().waves).toBe(0)` after constructing the composition root).

## 9. Alerts: push, don't wait for someone to look

**Rule.** A signal that only a person browsing a dashboard can see is not monitoring. Push at least:

| Alert | Why |
|---|---|
| DLQ depth > 0 for any DLQ | an inspect-only DLQ is a silent data-loss bin (rule 19) |
| 5xx rate above a baseline per `w-*` | catches regressions a deploy introduced |
| canceled / cpu≈0 invocations > 0 | the hang signature from §8 |
| spend per day above budget, vendor quota near cap | money and hard limits |
| cron tick missing | a background worker that stopped is otherwise invisible |
| SPA unhandled errors (error boundary + `window.onerror` → telemetry) | the browser is the one runtime no worker sees |

Workers Issues (`observability.issues.enabled`) groups uncaught exceptions, failed invocations,
5xx responses and error-level logs per worker and can route them to a webhook or chat; enable it
in the canonical block, which is one more reason `log.error` must mean "a bug" (§3). For signals
it does not cover (DLQ depth, missing tick, spend), run a small scheduled checker in `cron-reaper` that queries the analytics
APIs and posts to a channel. Dashboards are code paths too. A failures tile once omitted
dead-lettered items, and an external analytics dashboard kept counting a deleted event. Look at them after
every change, and record where externally defined dashboards live.

## 10. Cost metering

**Budgets are append-only ledgers in integer micro-units** (the guarded-debit mechanism lives in
[data §5](data.md#5-d1-as-the-control-plane)).
- Never update a balance column in place; the balance is `SUM(amount)`, so the ledger can be
  audited and replayed. Use time-bucketed spend rows (an hourly bucket) for rate caps.
- Make grants idempotent: `INSERT … WHERE NOT EXISTS` backed by a partial unique index.
- Settle exactly once: `UPDATE run SET cost_micros=?, settled_at=? WHERE id=? AND settled_at IS NULL`
  and branch on `meta.changes > 0`. A replayed Workflow step then writes nothing.
- Meter at the project level too, not only per user. A shared vendor quota consumed by both user
  calls and background calls needs its own meter.

**Spend is isolated in its own worker with a kill switch** (rule 21). `wf-vendorx-fetch` holds the
consumer, the Workflow and the reaper cron for paid work. With its vendor secret absent, it acks
every message without spending. The secret is set out of band. CI may check that it exists but
**never uploads it**: a deploy that pushed the secret from CI silently re-armed spend someone had
deliberately killed.

**A retry that spends money is a person's decision.** Reapers never produce paid work; stuck
requests go to `failed` with their debit charged, and the user's next click pays its own debit
([async P3](async.md#p3-no-self-healing-re-enqueue-loops)).

**Check:**
- `rg -n "UPDATE .*balance" packages/core` returns nothing; balances are only ever summed.
- The deploy workflow contains no `wrangler secret put` for spend secrets.
- `rg -n "queue.*send|\.create\(" apps/cron-* <reaper modules in wf-*>` finds no producers of
  paid work in any reaper, wherever its cron lives.

## 11. Measurement is a command, not a checklist

**Rule.** Wrap "check after deploy" in a script, for example `pnpm perf-report [env] [hours]`. It
pulls worker latency by status, D1 rows read, top queries, queue backlog and **DLQ depth** from the
Cloudflare GraphQL and REST analytics APIs.

Why: "+48h, verify rows read" items in two separate perf plans were never done. When someone
finally measured, the targets had been badly missed. A command gets run; a checklist item gets
skipped.

**Check:** every plan with a post-deploy verification step names the command to run, and
`AGENTS.md` lists it.

## Audit quick list

| Check | Pass condition |
|---|---|
| object logger | no stray `console.*`; a shape test exists; one real field-filtered query works |
| taxonomy constructed | `new DomainError(` / `new TransientError(` occur at throw sites; no message matching |
| one failure helper per entrypoint kind | `.retry(` only in `consumeEach`; one Workflow failure idiom |
| choke points | access log, step wrapper, per-batch and per-tick lines in every deployable, all with `db_*` |
| correlation | request-id header echoed; `correlationId?` in message contracts |
| telemetry off hot path | queue-backed facade; producer stamps time, id and env |
| config | identical observability block per env, pinned by a test; sampling chosen with a date |
| alerts | DLQ depth, 5xx, canceled/cpu≈0, spend, missing tick |
| spend | ledger + micro-units + guarded settlement; isolated worker; kill switch CI cannot undo |
| measurement | a `perf-report` command exists and is referenced from plans |
