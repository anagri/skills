# Async topology: Queues, Workflows, crons, Durable Objects

Rules 15 and 18–21 in detail. API mechanics live in the `cloudflare`, `workers-best-practices`,
`wrangler` and `durable-objects` skills. This file covers **who owns which piece of async work,
where state lives, and how to check it**.

The model in one line: **D1 is the control plane, queues are work lists.** State, locks, budgets and
status live in rows. Messages carry ids. The UI reads rows. Workflows orchestrate. Consumers do
bulk or external work. Crons recover state; they never create new work.

## Picking the primitive

| Need | Use | Not |
|---|---|---|
| Work after the response that must not be lost, or that takes longer than a few seconds | Workflow (or a queue) | `ctx.waitUntil` (it is cancelled about 30s after the response) |
| Multi-step process with checkpoints, durable sleep, per-step retry | Workflow | a consumer that loops and re-enqueues itself |
| Bulk, deduplicated, batchable work on many ids (enrich, index, forward telemetry) | Queue + one consumer | an inline fan-out loop inside a Workflow |
| Periodic recovery or cleanup | Cron in the worker that owns the state | a UI poll that restarts work |
| Hot per-entity state, or serialized coordination of one entity | Durable Object (SQLite storage) | a D1 row with heavy write contention |
| Fire-and-forget telemetry | Queue → `q-consumer-analytics` | a synchronous vendor call in a request or a step |

In acme: `w-app` hosts the orchestration Workflows and the cheap dispatch consumer.
`q-consumer-enrich` (heavy, external), `q-consumer-index` (the single writer of the search store),
`q-consumer-analytics` (best effort) and `wf-vendorx-fetch` (paid) each run in their own worker.
`cron-reaper` sweeps state that no domain owns.

## Queues

### Q1. Each queue has exactly one consumer and one message type in `contracts`
Why: the platform allows only one push consumer per queue. A second "consumer" is a test-only twin,
and the twin drifts from the deployed one. In acme the harness's twin skipped a downstream emitter,
and the "real pipeline" suite never covered that leg.
How to check: every `queues.consumers[].queue` appears in exactly one deployed `wrangler.jsonc`
(test configs included: route the queue to the real consumer, run it as an auxiliary worker).
`grep -rn "type .*Message\b" packages apps | grep -v contracts` returns nothing.

When you move a consumer to a new worker, neither its registration nor its secrets move with it;
follow [playbooks §1](playbooks.md#1-split-a-consumer-cron-or-workflow-out-of-the-main-worker).

### Q2. Messages are id-only; the consumer re-reads current state
```ts
// packages/contracts/src/messages.ts (full union: packages-and-contracts §3)
export type IndexMessage = { kind: 'document'; documentId: string } // no payload, no snapshot
```
Why: reordered, duplicated and redelivered messages all converge on the current row. Messages stay
far below the per-message size cap. A missing row means "delete", not "crash".
How to check: message types contain ids, plus only attribution that cannot be re-derived (for
example the requester). New fields are optional, and absence is the safe default.

### Q3. Every consumer has a written ack policy, enforced through one shared failure helper
Classify each failure once, using the shared taxonomy ([observability §3](observability.md#3-one-error-taxonomy-applied-at-every-entrypoint-kind)):

| Error | Action | Why |
|---|---|---|
| `DomainError` (not found, invalid, quota exhausted for this item, forbidden) | **ack**, record a terminal status in D1, log at `warn` | a retry gives the same answer and burns budget |
| `TransientError` / unknown | **retry with `delaySeconds` backoff** | without a delay, all retries fire almost at once and a short outage dead-letters everything |
| unprocessed overflow (clamped to a bind/budget limit) | **retry**, never ack | acking it silently discards work |

```ts
// packages/core/src/queues/consume.ts — the ONE place a consumer decides ack vs retry.
// Runtime-blind: MessageLike/BatchLike live in contracts; classifyError/log in core/observability.
const backoffSeconds = (attempts: number) => Math.min(30 * 2 ** (attempts - 1), 3600)

export async function consumeEach<T>(
  batch: BatchLike<T>,
  handle: (body: T) => Promise<void>,
): Promise<void> {
  for (const m of batch.messages) {
    try {
      await handle(m.body)
      m.ack()
    } catch (err) {
      if (!classifyError(err).retryable) {
        log.warn(batch.queue, 'message_dropped', { id: m.id }, err)
        m.ack() // the terminal state is already durable in D1
        continue
      }
      log.error(batch.queue, 'message_retry', { id: m.id, attempts: m.attempts }, err)
      m.retry({ delaySeconds: backoffSeconds(m.attempts) })
    }
  }
}
```
Bulk consumers (one upsert for the whole batch) still decide per message. Run the bulk path first.
If it throws, fall back to `consumeEach` over single ids, so one poison id cannot drag up to
`max_batch_size − 1` healthy ids into the DLQ. Never `retryAll()` because of one id.

Best-effort consumers (analytics) may `ackAll()`. Say so in the consumer's header, and log the
vendor's rejection body: once the batch is acked, the events are gone.

How to check: `grep -rn "retryAll\|\.retry()" apps packages` returns only the helper or documented
exceptions. A test feeds a mixed batch (ok, domain, transient, overflow) and asserts ack/retry per
message.

**The rule behind every policy: never ack work you have not durably recorded or deliberately
abandoned.** In acme, a consumer clamped a batch to its bind budget and acked everything: most of
the batch was silently lost. Pin the overflow path with a test,
because it rarely fires.

### Q4. Every retrying queue has a DLQ, and something consumes it or alerts on its depth
```jsonc
"queues": { "consumers": [{
  "queue": "prod-acme-index",
  "max_batch_size": 50, "max_retries": 3,
  "retry_delay": 30,                       // a default; the helper's delaySeconds overrides it
  "dead_letter_queue": "prod-acme-index-dlq"
}]}
```
Without `dead_letter_queue`, messages that exhaust their retries are discarded. A DLQ that is only
ever inspected is the same thing with a delay. Pick one: a DLQ consumer that marks the owning status
row `failed` (so the user can act on it), or an alert on DLQ depth.
How to check: every consumer block with `max_retries > 0` has `dead_letter_queue`, and every DLQ
name appears either as a consumer or in the alert config.

### Q5. Routing and latency class live in queue config, not in the message
For the same work at two urgencies (backlog vs user-clicked), use **two queues with the same message
type and the same consumer**. They differ only in `max_batch_timeout` and `max_concurrency`. The
consumer derives the kind from `batch.queue`. `max_concurrency` on a paid queue also caps how many
billable jobs a burst can open.
How to check: no `priority` or `urgent` field in any message type.

### Q6. Emit follow-on work where its precondition is guaranteed
Emit "index this" after the searchable write commits, from the writer. Emit "fetch content for X"
from the consumer that just created row X, not from the Workflow that only enumerated X's id: a
by-id claim against a row that does not exist yet matches zero rows, silently.
How to check: for each producer, name the row the message's consumer will read, and point at the
line that guarantees the row exists.

## Workflows

### W1. Never `waitUntil` long work
`waitUntil` gets about 30s after the response, has no retries and no checkpoints. In acme, a
source-discovery job ran under `waitUntil` and a UI poll restarted it every 30s. Large sources
never finished. A Workflow behind a conditional-write gate (W6) fixed it.
How to check: `grep -rn "waitUntil(" apps` shows only logging, cache and telemetry sends.

### W2. Every step goes through one shared wrapper
```ts
// packages/core/src/workflows/step.ts — StepLike is a structural port from contracts
export function asStep<T>(step: StepLike, name: string, fn: () => Promise<T>): Promise<T> {
  return step.do(name, async () => {
    const start = Date.now() // a replayed step never runs this callback
    try {
      const result = await fn()
      log.info('workflow', 'step', { name, ms: Date.now() - start, outcome: 'ok' })
      return (result === undefined ? null : result) as T // undefined is not a persistable value
    } catch (err) {
      log.warn('workflow', 'step', { name, ms: Date.now() - start, outcome: 'threw' }, err)
      throw err
    }
  })
}
export const sleepStep = (step: StepLike, name: string, ms: number) => step.sleep(name, ms)
```
The wrapper guarantees four things:
- **Deterministic names.** The name is the cache key. Derive names from the payload or from earlier
  step results (`wait:${round}`), never from `Date.now()` or random values.
- **`null` for `undefined`.** A void step returning `undefined` has been seen to end the instance
  in an exception after its work, and its spend, already happened. Coercing to `null` costs nothing.
- **Small, serializable results.** A non-stream step result is capped at 1 MiB (check current
  limits). Return counters and keys; put blobs in R2. A step that "collects results" returns
  `{ ok: 12, failed: 1 }`, not the documents.
- **Timing.** One log line per step that actually executed.

Why: names drifting or oversized results fail only on replay or in production, never in a happy-path test.
How to check: `grep -rn "step\.do(" apps packages` matches only the wrapper.

### W3. Side effects and non-determinism go inside steps
Code outside `step.do` can run again on every engine restart. Creating instances, sending to a
queue, `Math.random()`, `Date.now()` and branching on any of them all belong in a step. A replayed
settle step must not double-emit, so make settlement a guarded write that reports whether it won:
`UPDATE run SET status='settled' WHERE id=? AND status='running'` with `changes === 1` before
emitting anything.
Why: replay re-executes everything outside completed steps; a send there duplicates work on every restart.
How to check: in each `run()`, every `send`/`create`/`fetch`/clock read sits inside `asStep`; an
introspection test restarts the instance and asserts one emit.

### W4. Domain failures end the run once, through one idiom
Pick one idiom per codebase. Two idioms classify edge cases differently.
```ts
try {
  await asStep(step, 'fetch-source', () => core.fetchSource(deps, params))
} catch (err) {
  if (classifyError(err).retryable) throw err // transient: let step retries / the runtime handle it
  await asStep(step, 'mark-failed', () => deps.storage.markFailed(params.jobId, errCode(err)))
  return { status: 'failed' }       // terminal; no retry storm against quota or auth
}
```
Classify inside the step: the Workflow adapter rethrows a domain error as `NonRetryableError`
(`cloudflare:workflows`) so it does not burn the step's retries, then the run persists the terminal
status in its own step. An error that crosses `step.do` is re-thrown by the engine, so classify by
`err.name` or a code in the message, not `instanceof`; or have the step return
`{ ok: false, code }` for domain outcomes and skip the throw entirely.
Why: two idioms, or a misclassified domain error, mean a retry storm against quota or auth.
How to check: a layer-2 integration test using Workflow introspection (`mockStepError` with the
error the adapter throws) asserts the instance ends with exactly one terminal row.

### W5. Enumerate → enqueue → poll-wait; no inline fan-out
A Workflow pages through the source, records membership, computes the new ids, sends them to the
shared batch queue (`sendBatch`, which takes up to 100 messages), then waits:
```ts
for (let round = 0; round * POLL_MS < MAX_WAIT_MS; round++) {
  const pending = await asStep(step, `check:${round}`, () => storage.countMissing(ids))
  if (pending === 0) break
  await sleepStep(step, `wait:${round}`, POLL_MS)
}
// on timeout, complete with what landed; the status row says how much
```
Why: one dedupe point for the external call across all Workflows and users, and failure handling
moves to queue retry plus DLQ. `step.waitForEvent` is the alternative when the consumer can know
the instance id. Poll-wait keeps consumers unaware of Workflows. `sleep` steps do not count toward
the per-instance step limit, but `check:` steps do: size `MAX_WAIT_MS / POLL_MS` against it.
How to check: no Workflow contains a loop of per-id external calls; `grep -rn "for (.*of ids" `
inside workflow modules matches only enqueue/count code.

### W6. Instance ids are a secondary guard; D1 is the dedupe
Ids must match `^[a-zA-Z0-9_][a-zA-Z0-9-_]*$` and be at most 100 characters (current limits). `job:123:batch` throws, and if it throws out of a consumer after a paid step, the retry
pays again. Separate the **stable state key** (`source_id`) from a **per-attempt instance id**
(`ingest-<sourceId>-<attempt>`), so a finished resource can legitimately run again. Swallow
"instance already exists" in exactly one place (the single function that creates instances, the
facade's `create` if the worker has one), and match it narrowly. A broad `/conflict/i` turns real
failures into silent success.
How to check: one id-builder function per Workflow with a unit test against the pattern and length;
`grep -rn "\.create(" ` on Workflow bindings matches only that one creator.

### W7. Adopt before pay
```ts
const jobId = await asStep(step, 'submit', async () => {
  const run = await deps.storage.getRun(runId)       // the run row was written BEFORE dispatch
  if (run.vendorJobId) return run.vendorJobId        // replay: adopt, never re-buy
  const id = await deps.vendor.submit(run.inputs)    // the billable call
  await deps.storage.markSubmitted(runId, id)        // persisted inside the paying step
  return id
})
```
The billable call lives inside the Workflow's step, never in the consumer, so there is no window in
which a paid job has no owner. Write the run row before creating the instance, so a dying isolate
still leaves evidence that the reaper can settle.
Why: a paid call outside a step, or a job id persisted after it, is re-bought on every replay.
How to check: an introspection test fails the step after `submit` once (`mockStepError`, `times: 1`)
and asserts the vendor fake saw exactly one submit.

## Single-flight, locks and reapers

### L1. Single-flight is one conditional write (rule 15)
```ts
// Drizzle (the default); the same shape in raw SQL is UPDATE … WHERE … RETURNING
const [won] = await db.update(syncJob)
  .set({ status: 'running', startedAt: now, attempt: sql`${syncJob.attempt} + 1` })
  .where(and(
    eq(syncJob.sourceId, id),
    or(notInArray(syncJob.status, ['queued', 'running']), lt(syncJob.startedAt, now - STALE_MS)), // stale takeover
    or(isNull(syncJob.lastDoneAt), lt(syncJob.lastDoneAt, now - DEBOUNCE_MS)),                   // rate limit
  ))
  .returning({ attempt: syncJob.attempt })
if (!won) return { started: false } // someone else holds it
```
No row returned means someone else holds the lock. One statement gives single-flight, a debounce
and stale takeover. The row must already exist (create it when the resource is tracked), or use
`insert … onConflictDoUpdate({ where })` so the first claim is not a silent zero-row update. Never
read and then write.
Why: read-then-write races under concurrent requests and double-starts paid work. How to check: grep `tryBegin*` / `claim*` functions
and confirm each is a single statement whose `RETURNING` or `meta.changes` decides the winner.

### L2. Every lock or status row has a reaper or a stale takeover
A Workflow owns its row's lifecycle. If the instance dies between `running` and a terminal state,
the row is locked forever, and when the key is global, one leak wedges the resource for every user.
Domain-failure handling does not cover instance death.
- **Recover to the state that keeps user controls available** (in acme, `done`, not `failed`, so
  the user's retry and load-more actions still work), or to `failed` with a reason the UI shows.
- **Reapers never produce work.** They settle, release and mark rows. They never enqueue.
- **Window > a healthy run's maximum lifetime**, including the poll-wait budget.
- Log one line on **every** tick, empty ones included: an empty tick is the baseline you compare a
  slow one against.

How to check: list every column holding `queued|running|fetching|pending`. Each needs a reaper
query or a stale clause in its `tryBegin`. A test ages a row past the window and asserts recovery,
plus zero sends on a recording queue binding.

### L3. Crons live in the owning domain's worker
A paid domain's reaper runs in the same worker as its `scheduled()` handler, next to its config,
secrets and kill switch. Use `cron-reaper` only for sweeps that no deployable owns (expired
sessions, global stale rows), and do not let it bind another worker's internals across scripts.
Make crons idempotent. Do not rely on crons firing under local dev: trigger them by hand through
`/cdn-cgi/local/scheduled?cron=…` (exposed by `@cloudflare/vite-plugin`, or `wrangler dev
--test-scheduled`), wrapped in a package script. An untriggered sweep is how an untested one ships.
Why: a cron in a foreign worker needs that domain's secrets and kill switch, and drifts from its schema.
How to check: every `triggers.crons` entry lives in the worker that owns the tables its handler
writes; `cron-*` workers write only domainless tables.

## Paid and external work (rule 21)

### P1. One producer function debits budget before it enqueues
```ts
export async function requestFetch(deps: FetchDeps, user: string, ids: string[]) {
  const accepted = await deps.storage.reserve(user, ids) // INSERT … RETURNING; unique (user,id) WHERE pending
  for (let i = 0; i < accepted.length; i += 100) // sendBatch takes at most 100 messages (and 256 KB)
    await deps.queue.sendBatch(accepted.slice(i, i + 100).map((id) => ({ body: { id, user } })))
  return accepted
}
```
Every surface (button, API, agent tool, ingestion hook) calls this function. A second route to the
queue is a second, unfiltered spend path. Every "mark queued" is paired with a send in the same
function: a status written without a send is an hour-long silent wait that a corpus-scanning sweep
will hide until the sweep is removed.
How to check: `grep -rn "PAID_QUEUE.send" apps packages` matches only the producer.

### P2. A kill switch that a deploy cannot undo
Use a secret set out-of-band (the deploy never uploads it), or a D1 config row. Do not use a
wrangler `var`, and do not use a secret that CI re-uploads: "kill spend, ship an unrelated fix,
spending resumes" is the failure. When disabled, the consumer records the state in D1 and acks;
retrying only ages the messages into the DLQ.
How to check: the switch's name appears in no `vars` block and no deploy/CI secret upload; a test
with the switch off asserts zero vendor calls and terminal rows.

### P3. No self-healing re-enqueue loops
A reconcile that re-enqueues every loss path is harmless while the work is free. Once each attempt
is billed, it becomes an unbounded spend loop: leaked ids are re-bought with nobody waiting, and an
uncorrelatable failure record is re-requested every tick under one debit. Stuck requests go to
`failed`, and their debit is **charged**, not released, so one debit cannot fund repeated
attempts. A retry is a user action through P1.
How to check: no cron, reaper or reconcile path calls the producer or the paid queue (recording
binding test, as in L2).

## Surfacing status

**Rule:** status is a row the UI polls only while in flight. Why: a push channel or an always-on
poll costs more and still needs the row for reloads. How to check: every `refetchInterval` is a
function that returns `false` for terminal states.

- Every async process has one status row or column (`queued → running → done|failed`). Producers
  write `queued` **before** enqueuing, so the UI's poll arms immediately.
- Ordinary read endpoints project the status. The client polls (`refetchInterval`) **only while a
  row is in flight**. A second meter rides an existing read instead of adding its own poll.
- Polling stops only at a terminal state, so the reaper is what bounds the worst-case poll.
- No push channel is needed. Reach for a Durable Object / WebSocket only when latency demands it.

## Gates that check "done" must be count-aware

A dispatch gate that skips any resource in `done` breaks "load more": the resource is done, so
nothing runs. Compare what was requested with what exists:
```ts
const shouldFetch = (s: State, requested: number, have: number) =>
  s.status !== 'running' && (s.status !== 'done' || have < requested)
```
Share the gate between the live dispatcher and the e2e fake, so idempotency is tested once.
How to check: grep dispatch paths for `status === 'done'` / `!== 'done'` without a count comparison;
a test requests more after `done` and asserts work starts.

## Durable Objects

Use a DO for per-entity hot state (a chat transcript, a rate counter) or for serializing one
entity's operations. It does not replace a queue (no batching, no DLQ) or the D1 status rows the UI
reads. A DO alarm that owns a lease is a lock like any other: give it L2's reaper or a takeover. A
worker that binds another worker's DO class (`script_name`) couples their deploy order, so prefer
RPC to the owner. Class migrations: `durable-objects` skill.
How to check: every `durable_objects.bindings[].script_name` is justified in the binding's comment,
and every DO alarm that holds a lease has a takeover test.

## Audit checklist

| Check | Pass |
|---|---|
| consumers per queue (deployed + test configs) | exactly 1, and it is the deployed one |
| `.retry()` calls without `delaySeconds` | 0 outside the helper |
| retrying consumers without `dead_letter_queue` | 0 |
| DLQs with no consumer and no alert | 0 |
| `step.do` outside the wrapper | 0 |
| in-flight status values without a reaper or stale clause | 0 |
| reapers or crons that call `send` | 0 (asserted with a recording binding) |
| paid-queue send sites | 1 |
| kill switch survives a deploy | the secret is not in any deploy step |
| `waitUntil` carrying work over a few seconds | 0 |
| "done" gates that ignore counts | 0 |
