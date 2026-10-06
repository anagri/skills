# Lessons from production

Each lesson below is a real failure from a production Cloudflare monorepo, rewritten for the example
product **acme**. Acme ingests documents, enriches them and indexes them for search. Its deployables
are `w-app`, `w-admin`, `q-consumer-enrich`, `q-consumer-index`, `q-consumer-analytics`,
`wf-vendorx-fetch`, `cron-reaper` and `pages-website`. Read the lesson before arguing with the rule
it produced.

## The meta-pattern

Almost every structural rule in this skill came out of the same four-step loop:

1. **Shortcut.** Something is done in-process because it works today: a DB trigger, an init on the
   request path, `waitUntil`, an env-flag fork, a hand-kept list.
2. **Platform limit.** Production load, a runtime limit or a deploy quirk breaks it, usually
   silently.
3. **Extraction.** Under pressure, the work moves to a queue consumer, a Workflow, a separate
   Worker, a migration or a generated artifact.
4. **Pinning test.** A test is added so the shortcut cannot come back.

Starting from the rules skips steps 1–3. If you take a shortcut anyway, write the step-4 test first.

Format: **Symptom** (how you would notice) / **Cause** / **Rule** (where the fix is documented).

---

## Boot, request path and runtime

### 1. A request-path schema init hung half of production
- **Symptom:** about half of `/api/*` requests hang for over an hour. Invocations show
  `outcome = canceled`, CPU time 0, and no access-log line at all. Only traces show them.
- **Cause:** `w-app` awaited `ensureInit()` (`CREATE … IF NOT EXISTS` on the search DB) before
  routing. That DDL needed the write lock and queued behind `q-consumer-index`'s long batches. The
  client gave up, so the invocation was canceled. The memo had cached the **pending** promise, and
  every later request on that isolate awaited a promise that never settled, until the isolate was
  recycled.
- **Rule:** a deployed worker does no I/O before routing. Any memo is time-bounded and caches only
  success (`makeEnsureInit`) — [bindings-and-config §8](bindings-and-config.md#8-no-io-before-routing-bounded-success-only-init-rule-12),
  rule 12. Prefer moving the DDL into migrations entirely; the memo is for local/test boot only.
  Check: a test of the deployed configuration asserts zero D1 calls before the router runs.

### 2. Split-out workers carried the boot DDL with them
- **Symptom:** tables show up in prod that no migration created. A later migration collides with
  them, or a fresh table hides a missing migration.
- **Cause:** `q-consumer-enrich`, `wf-vendorx-fetch` and `w-admin` were copied from `w-app`, and the
  copy included `storage.init()` (the whole fresh-DB schema) on cold start. Fixing the hang in
  `w-app` did not fix the clones.
- **Rule:** tenants never run DDL. Copy the topology of a worker, not its internals —
  [data](data.md), rule 13; [topology](topology.md).
  Check: each tenant has a `no-ddl` test that runs one `queue()`/`fetch()` against an empty D1 and
  asserts no table exists. Put it in its own file so another test cannot warm the memo first.

### 3. `waitUntil` cut off long work
- **Symptom:** large sources never reach `ready`. A 30-second poll keeps restarting the fetch.
- **Cause:** source discovery ran as `ctx.waitUntil(fetchAll())`. The runtime gives `waitUntil` a
  shared window after the response or client disconnect (30 s across all `waitUntil` calls at the
  time of writing; check current limits) and cancels whatever has not settled. No retries, no
  checkpoints.
- **Rule:** long work goes in a Workflow with `step.do` checkpoints, and single-flight comes from an
  atomic `pending → running` transition — [async](async.md), rule 18; [data](data.md), rule 15.
  Check: `grep -rn "waitUntil(" apps/*/src`. Each hit must be bounded and fire-and-forget, such as
  a log or cache write.

### 4. A platform host blocked Worker egress
- **Symptom:** a feature works from a laptop and from `vite dev`, then fails or is challenged when
  deployed.
- **Cause:** some third-party hosts block or challenge traffic from Workers. A local run says nothing
  about deployed egress.
- **Rule:** before you build on an external host, deploy a throwaway spike worker that calls it, and
  record the result. Verify reachability from the real platform —
  [topology](topology.md), split triggers (vendor dependency).
  Check: the design doc links the spike result.

### 5. Code that holds credentials ran in the browser
- **Symptom:** work stops when the user's tab closes. Tokens sit in client storage. Spend cannot be
  capped or killed.
- **Cause:** compute was placed in the browser or an extension because that was quicker to ship.
- **Rule:** default to the server for anything that holds credentials, spends money or owns durable
  state. A Durable Object or Workflow is the host, and the client is a view —
  [topology](topology.md).
  Check: `grep -rnE "localStorage|sessionStorage" apps/*/src | grep -i token` returns nothing, and
  every paid call site lives in a worker, not a client bundle.

---

## Async, queues and money

### 6. A trigger-maintained FTS index was reverted to a queue and a single writer
- **Symptom:** primary-DB writes slow down. The search engine cannot be swapped. A trigger that
  writes rows inflates `meta.changes`. Index bugs are untestable outside SQLite.
- **Cause:** FTS tables plus `AFTER INSERT/UPDATE/DELETE` triggers in the primary DB.
- **Rule:** producers emit id-only events, and `q-consumer-index` is the only writer of `SEARCH_DB`.
  The index has a rebuild command — [data](data.md), rule 13; [playbooks](playbooks.md).
  Check: a migration lint bans `CREATE VIRTUAL TABLE … fts` and `CREATE TRIGGER` that write to
  another table.

### 7. A monolithic `queue()` had to be split
- **Symptom:** one `queue(batch)` with a `switch (batch.queue)`. A slow enrich batch delays indexing,
  and one bad deploy stops every pipeline.
- **Cause:** every consumer was registered on `w-app` because it was easy to add.
- **Rule:** split by failure, cost and trigger domain. Keep each handler as its own module from day
  one so the split is a move — [topology](topology.md), rule 1; [playbooks](playbooks.md).
  Watch the move: **secrets and consumer registration do not travel with the code.** Re-register
  the consumer and re-put the secrets on the new worker.
  Check: any `batch.queue` routing table maps each queue to its own handler module (no inline
  logic), and every queue whose split trigger fired is consumed by its own `q-consumer-*`.

### 8. An inline env flag forked the pipeline
- **Symptom:** e2e passes, but prod drops index events. Tests ran a code path that never ships.
- **Cause:** an `INLINE_INGEST=true` var made producers call consumers synchronously "for tests",
  scattered as `if (env.INLINE_INGEST)` through the core.
- **Rule:** no test flags in core. Swap behaviour only at the binding boundary: core takes the same
  port either way, and where local tests need fakes, a Live/Fake binding facade chosen in the
  composition root supplies them (local/test only). Prove the real queue → workflow pipeline in
  the layer-2 integration suite —
  [bindings-and-config](bindings-and-config.md), rule 10; [testing](testing.md), rule 24.
  Check: `grep -rn "env\.\(USE_FAKE\|INLINE\)" packages/core` returns nothing.

### 9. Acking the overflow dropped work
- **Symptom:** most of an oversized batch vanished. Only a later reconcile found the
  missing ids.
- **Cause:** the consumer clamped the batch to fit D1's bound-parameter cap, then `batch.ackAll()`,
  which included the messages it had discarded. The clamp almost never fired, so tests missed it.
- **Rule:** ack a message only after it is applied or rejected as permanent. `msg.retry()` the rest,
  per message — [async](async.md), rule 19.
  ```ts
  for (const m of overflow) m.retry({ delaySeconds: 30 });
  ```
  Check: a test sends a batch bigger than the clamp and asserts the overflow is retried, not acked.

### 10. A self-healing re-enqueue loop leaked money
- **Symptom:** the vendor bill grows with no user activity. The same record is bought every hour.
- **Cause:** the cron re-enqueued "stranded" items. That was harmless when fetching was free. Once
  each fetch cost money, one budget debit could fund unbounded retries.
- **Rule:** one producer function debits the budget **before** enqueuing paid work. The reaper
  settles and fails stale rows, and **never produces**. Persist the vendor job id inside the step
  that pays — [async](async.md), rules 20 and 21.
  Check: the cron's test binds a recording queue and asserts it received zero messages.

### 11. A missing side-effect wire compiled into a silent no-op
- **Symptom:** an endpoint returns 202 and writes a `queued` row, but nothing is ever processed.
  It was hidden for months by a scanner that polled the table anyway.
- **Cause:** `queueWork(db, ids, opts, emitter?)`. One call site left out the optional emitter.
  Removing the scanner exposed it.
- **Rule:** producers, emitters and workflow starters are **required** parameters —
  [bindings-and-config](bindings-and-config.md), rule 11.
  Check: `grep -rnE "(queue|emit|emitter|producer)\?:" packages/core` returns nothing.

### 12. Every "in progress" status became a stuck spinner
- **Symptom:** rows sit in `queued`/`fetching` forever after a crash or a canceled Workflow, and the
  UI refuses to re-request them.
- **Cause:** a lock state with no exit except success.
- **Rule:** every lock or status row has a reaper or a stale takeover whose window matches the lease
  — [async](async.md), rule 20.
  Check: list every enum value that means "in progress", and name each one's reaper.

---

## Data and migrations

### 13. A stale "no prod data" note nearly shipped a no-op migration
- **Symptom:** a schema change edits only the fresh-DB schema file. It passes every test, and in
  production nothing changes.
- **Cause:** the agent docs still said "no production data yet" a month after launch, so the agent
  skipped the migration and backfill.
- **Rule:** world-claims carry a date and are re-checked before use. Rules do not depend on them —
  [governance](governance.md), rule 27; [data](data.md), rule 14.
  Check: `grep -rnE "no (prod|production) (data|users)|not (yet )?live" AGENTS.md docs/` hits only
  dated lines; a schema diff without a new migration file fails `check`.

### 14. An applied migration's comment was edited
- **Symptom:** a commit touches `migrations/00NN_*.sql` "only to fix a link".
- **Cause:** the change looked inert. Wrangler tracks migrations by filename, but the habit is the
  hazard.
- **Rule:** migrations are append-only, comments included. A stale reference in a historical
  migration is accurate for when it was written — [data](data.md), rule 14.
  Check: in the local `check`, `git diff --name-status origin/main -- '**/migrations/' | grep -v '^A'`
  returns nothing.

### 15. A test-only table reached production
- **Symptom:** `e2e_stubs` exists in the prod DB.
- **Cause:** the fixture table was in the fresh-DB schema, and deployed boot init ran that schema
  everywhere (see lesson 2).
- **Rule:** test fixtures never become production DDL. Put them in R2 under a test prefix, or seed
  them in-worker under the test env only — [testing](testing.md), rule 25.
  Check: diff the deployed schema's table list against the migrations' table list; any extra table
  fails.

### 16. A migration added a column that nothing wrote
- **Symptom:** a provenance column is NULL on every row, and only a run against the real vendor
  reveals it.
- **Cause:** the migration shipped, but the writer was never updated. No test asserts a column that
  nobody populates.
- **Rule:** a column ships with a test showing its writer sets it, and a backfill test if reads
  depend on it — [data](data.md), rule 14.
  Check: for each column a migration adds, `grep` its Drizzle field name in a non-migration writer
  and in a test assertion.

### 17. The fake D1 driver hid real D1 limits
- **Symptom:** green unit tests, 500s in production: too many bound parameters, a `LIKE` pattern
  over D1's length cap, a statement over the size limit (`SQLITE_TOOBIG`), and `meta.changes`
  counting trigger writes.
- **Cause:** the in-memory SQLite driver does not enforce D1's limits (at the time of writing: 100
  bound parameters per query, a 50-byte `LIKE`/`GLOB` pattern, a 100 KB statement, a 2 MB row; check
  current limits). A failing oversized row ordered first also head-of-line-blocked a whole queue.
- **Rule:** the Node-layer D1 double enforces the limits you depend on, or you keep a written list
  of the ones it misses with a guard for each. Put blobs in R2 and keys in D1 —
  [testing](testing.md), rule 24; [data](data.md), rule 17.
  Check: chunk helpers take the bind budget as a **required** parameter.

### 18. An FTS delete keyed on an unindexed column scanned the whole index
- **Symptom:** one statement accounts for nearly all of the search DB's rows read.
- **Cause:** `DELETE FROM docs_fts WHERE doc_id = ?` on an `UNINDEXED` FTS5 column is a full scan.
- **Rule:** budget cost in rows read, and address FTS rows by integer rowid through a map table —
  [data](data.md), rule 16.
  Check: run `EXPLAIN QUERY PLAN` and query-plan tests on every hot statement.

---

## Config, deploy and environments

### 19. `CLOUDFLARE_ENV` leaked into deploy and renamed a worker
- **Symptom:** a new worker named `dev-acme-w-app-dev` appears. Workflows and queue consumers are
  reassigned, and the deploy fails.
- **Cause:** `CLOUDFLARE_ENV` selects the env for the Vite build, which writes a flattened deploy
  config containing only that env. Wrangler also reads `CLOUDFLARE_ENV` (like `--env`) at deploy
  time; an older wrangler re-applied it on top of the flattened config. Newer wrangler validates
  that the deploy env matches the build env, so the same mistake now fails loudly instead. Check
  your version.
- **Rule:** the build picks the env once; deploy the generated config without re-selecting a
  different env, and set `CLOUDFLARE_ENV` explicitly per step rather than leaking it from job
  scope — [wrangler-and-local-dev](wrangler-and-local-dev.md), rule 22.
  Check: the deploy script asserts the deployed worker name equals the name in the built config.

### 20. A missing queue failed a deploy halfway through
- **Symptom:** the deploy uploads, then fails on a DLQ that does not exist, and leaves the fleet
  half-released.
- **Cause:** the resource was not provisioned for that env. Which resources wrangler auto-provisions
  has changed over time. Check current behavior, and remember that pinned ids are never created for
  you.
- **Rule:** run a provisioning preflight derived from the wrangler configs (queues, D1, secrets
  present) before any upload — [wrangler-and-local-dev](wrangler-and-local-dev.md).
  Check: the preflight lists every queue/D1 name from each env block and fails on any missing one
  (`wrangler queues list`, `wrangler d1 list`).

### 21. A service binding pointed at the unqualified worker name
- **Symptom:** the admin deploy fails with "references Worker 'acme-w-app' which was not found".
- **Cause:** a named env deploys under an env-qualified name (`<name>-<env>` by default, or the
  env's own `name`, here `prod-acme-w-app`). A `services[].service` or DO `script_name` must use that
  deployed name, not the top-level one.
- **Rule:** a cross-config consistency test (recommended, cheap) resolves every `service`, DO
  `script_name` and queue name per env against the target's deployed name —
  [wrangler-and-local-dev](wrangler-and-local-dev.md), rule 22.
  Check: the test fails when any env block references a name no config deploys in that env.

### 22. A deploy re-uploaded a secret and undid the kill switch
- **Symptom:** spend restarts after an unrelated deploy, and no log line looks like a decision.
- **Cause:** the kill switch was "delete the vendor token". One deploy step uploaded that token from
  a CI secret, so every deploy re-armed it.
- **Rule:** secrets are set out-of-band and only **audited** by deploy. Never upload a secret that
  doubles as a kill switch — [async](async.md), rule 21.
  Check: `grep -n "secrets:" .github/workflows/*` shows no upload of a kill-switch secret.

### 23. The mount path and the asset base were conflated: blank page, twice
- **Symptom:** the SPA deploys to a blank page. Chunk URLs return `200 text/html`, because the SPA
  fallback serves `index.html`.
- **Cause:** Vite `base: '/ui/'` was set to mount the app at `/ui`, but static assets serve from
  the root.
- **Rule:** keep Vite `base: '/'` and put the mount path only on the router basename;
  `run_worker_first: ["/api/*"]` — [topology](topology.md), rule 2.
  Check: an e2e loads a deep link and asserts that a JS chunk responds with a JavaScript content
  type.

---

## Contracts and UI

### 24. Hand-mirrored types drifted
- **Symptom:** the UI shows `undefined` after a server rename, while typecheck stays green.
- **Cause:** client response types were hand-copied (`fetchJson<DocumentDto>`). Harness types were
  mirrored the same way.
- **Rule:** generate client types from the committed OpenAPI, and regenerate-and-diff in `check` —
  [packages-and-contracts](packages-and-contracts.md), rule 7.
  Check: `grep -rn "fetchJson<" apps/*/src` returns nothing outside the generated client.

### 25. Duplicated lookalike components drifted within one cycle
- **Symptom:** the demo page and the app page differ after one feature lands.
- **Cause:** the demo surface was a copy, not a reuse, gated by `isDemo` flags.
- **Rule:** variant surfaces share components and differ only by unfilled slots. A parity diff is the
  gate — [packages-and-contracts](packages-and-contracts.md).
  Check: `grep -rn "isDemo" apps/*/src` returns nothing; a parity test renders both surfaces and
  diffs their structure.

### 26. A test attribute leaked a token into session replay
- **Symptom:** bearer tokens show up in recorded sessions.
- **Cause:** `data-test-value={apiToken}` for Playwright. Replay recorders serialize every DOM
  attribute.
- **Rule:** strip `data-test*` at build time (`apply: 'build'`), prove the strip on the built
  artifact, and mask by class, never by test attribute — [testing](testing.md), rule 25.
  Check: after `build`, `grep -rl "data-test" dist/` returns nothing; this runs in the local `check`.

### 27. A fallback that always fires is a broken feature
- **Symptom:** the marketing build "succeeds" every time and always serves the committed snapshot.
  The weekly refresh changes nothing.
- **Cause:** an 8 s fetch timeout never survived a cold worker reached from a CI runner. The fallback
  hid it.
- **Rule:** every fallback emits an observable marker (`data-source="live|snapshot"`, a log field),
  and someone checks it after a deploy — [observability](observability.md), rule 26.
  Check: a post-deploy smoke asserts the marker reads `live`; a fallback marker fails it.

---

## Observability and governance

### 28. String logs could not be queried for weeks
- **Symptom:** an incident question ("which ids failed, and how often?") cannot be answered.
- **Cause:** `console.log(\`[enrich] failed ${id}: ${e}\`)`.
- **Rule:** one logger emits objects (`{ tag, event, id, err }`) with normalized error fields —
  [observability](observability.md), rule 26.
  Check: `grep -rn "console\.\(log\|error\)" packages apps/*/src` hits only the logger.

### 29. Analytics on the hot path
- **Symptom:** p95 latency follows the analytics vendor's latency, and an outage there fails
  requests.
- **Cause:** a synchronous `await track()` in handlers.
- **Rule:** telemetry leaves through the `ANALYTICS_QUEUE` binding to `q-consumer-analytics`. Event time,
  geo and env are captured at the producer, because the consumer cannot know them —
  [observability](observability.md), rule 26.
  Check: `grep -rn "await track(" apps packages` returns nothing; handlers only `send()` to the queue.

### 30. CI went dark, and the CI-only gates ran nowhere
- **Symptom:** months of commits with no CI run. A test-attribute leak check existed only in CI, so
  it ran nowhere.
- **Cause:** a flaky CI was switched off, not fixed, and the local `check` was a subset of CI.
- **Rule:** the local `check` is a superset of CI, and CI only re-runs it —
  [governance](governance.md#8-local-gate--ci), rule 28.
  Check: every command in the CI workflow is reachable from `pnpm check`.

### 31. A hand-kept CI list left a worker ungated
- **Symptom:** a new `q-consumer-*` was deployed with tests that never ran.
- **Cause:** CI listed per-app test steps by hand, and the new app was never added.
- **Rule:** discover per-deployable gates by turbo convention (`turbo run check:deploy`), so adding a
  worker needs no CI edit — [governance](governance.md#7-per-deployable-gates-discovered-by-convention), rule 28.
  Check: every `apps/*/package.json` defines `check:deploy`; the CI file names no app.

---

## Using this catalog

- **In a review**, match symptoms first. Most incidents above were noticed by symptom long before
  anyone found the cause.
- **When proposing a shortcut**, find its lesson and write the pinning test before you take it.
- **When a new failure happens**, add it here in the same format and link the rule it produced. If
  no rule fits, the skill is missing one.
