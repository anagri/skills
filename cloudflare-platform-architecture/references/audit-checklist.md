# Audit checklist

Run this against an existing Cloudflare monorepo to find drift from the rules in `SKILL.md`. Each
item has a **check**, a **command** an agent can run from the repo root, what a **failure means**,
and a **severity**. Adapt paths (`apps/`, `packages/core`, `packages/contracts`) to the project's
layout before running, and record what you adapted in the report.

The examples use the neutral "acme" layout: `apps/{w-app,w-admin,q-consumer-enrich,q-consumer-index,
q-consumer-analytics,wf-vendorx-fetch,cron-reaper,pages-website}` and
`packages/{contracts,core,api-client,test-utils}`.

## Severity guide

| Severity | Meaning | Examples |
|---|---|---|
| **High** | Can cause an outage, data loss, unbounded spend, a security hole, or a defect that ships ungated | test seams in a deployed bundle, a retrying queue without a DLQ, edited applied migration, a gate that runs nowhere |
| **Medium** | Silent drift that will produce a high-severity bug at the next change | optional side-effect deps, hand-written API types, copied ids across configs, a status table without a reaper |
| **Low** | Friction or inconsistency; fix when touching the area | `compatibility_date` spread, oversized entrypoints, undated world-claims |

Escalate one level when the codebase already contains a past incident of the same shape (search
`git log --grep` for the symptom). Hits inside tests, fixtures and generated files are not findings
unless the item says so.

## Helper: read wrangler.jsonc without extra tooling

`jq` does not parse JSONC. Every JSONC file is a valid JS object literal, so Node can evaluate it:

```bash
# cfg <path> <js-expression over c>   e.g. cfg apps/w-app/wrangler.jsonc 'Object.keys(c.env ?? {})'
cfg() { node -e 'const fs=require("fs");const c=Function("return ("+fs.readFileSync(process.argv[1],"utf8")+")")();console.log(JSON.stringify(('"$2"')))' "$1"; }
# all configs as one JSON array for jq
for f in apps/*/wrangler.jsonc; do echo "{\"file\":\"$f\",\"c\":$(cfg "$f" c)}"; done | jq -s . > /tmp/cfgs.json
```

JS accepts comments and trailing commas, so this handles any JSONC. Static reads show what is
*written*; for what an env actually *resolves to* (inheritance applied), run
`npx wrangler deploy --dry-run --env <name>` in the app dir — it prints the bindings that env gets.

## 1. Topology

| # | Check | Command | Failure means | Sev |
|---|---|---|---|---|
| T1 | Every deployable follows `{platform}-{domain}-{role}` | `ls apps \| grep -Ev '^(w\|q-consumer\|wf\|cron\|pages)-'` | Role is not readable from the name; inventories drift | Low |
| T2 | Entrypoints are thin: no SQL, no business logic | `rg -l 'prepare\(\|SELECT \|INSERT \|UPDATE ' apps/*/src/index.ts apps/*/worker/index.ts` and `wc -l` on each entrypoint (>150 lines is a smell) | Logic is untestable without the runtime and cannot be moved when splitting | Medium |
| T3 | No app imports another app | `rg -n "from ['\"](\.\./)+apps/\|from ['\"]@acme/(w\|q-consumer\|wf\|cron)-" apps` | Deployables are coupled at build time; one deploy drags another's code | High |
| T4 | Privileged worker-to-worker calls use RPC over a service binding | `rg -n "fetch\(.*(internal\|/admin/\|/_\w+)" apps` and `rg -n '"services"' apps/*/wrangler.jsonc`; then `rg -n 'extends WorkerEntrypoint' apps` | A public internal HTTP route is reachable from the internet | High |
| T5 | UI app is one worker serving SPA + API | `cfg apps/w-app/wrangler.jsonc 'c.assets'` shows `not_found_handling: "single-page-application"` and `run_worker_first` covering `/api/*` | API paths fall through to `index.html` (200 `text/html`) or a second deploy lane exists for one product | Medium |
| T6 | Admin endpoints are not routed on the user-facing worker | `rg -n "route\(['\"]/api/admin" apps/w-app` | Privileged surface shares the public worker's blast radius | Medium |
| T7 | One `vite dev` boots the fleet | `rg -n auxiliaryWorkers apps/*/vite.config.*` lists every worker the app's local flow depends on | Local dev runs a partial topology; bugs appear only after deploy | Low |

## 2. Packages and contracts

| # | Check | Command | Failure means | Sev |
|---|---|---|---|---|
| P1 | `contracts` has zero runtime dependencies | `jq '.dependencies // {} \| length' packages/contracts/package.json` → `0` | The leaf package drags runtime code into every consumer | Medium |
| P2 | Core imports no Cloudflare runtime | `rg -n "from ['\"]cloudflare:\|D1Database\|R2Bucket\|WorkflowStep\b\|ExecutionContext\|@cloudflare/workers-types" packages/core/src` | The core cannot run in Node unit tests and the runtime is not swappable | High |
| P3 | Core imports no HTTP framework | `rg -n "from ['\"]hono" packages/core/src` | Domain logic is welded to routing | Medium |
| P4 | Core never reads `env` | `rg -n "\benv\.[A-Z_]+\|process\.env" packages/core/src` | Config bypasses the composition root; tests must fake the whole env | High |
| P5 | `env.X` reads happen only in composition roots | `rg -n "env\.[A-Z_]+" apps --glob '!**/compose.ts' --glob '!**/cf/**' --glob '!**/*.test.ts'` | Binding access is scattered; a facade or fake cannot cover it | Medium |
| P6 | `test-utils` is never a runtime dependency | `jq -r 'select(.dependencies["@acme/test-utils"]) \| input_filename' apps/*/package.json packages/*/package.json` → empty | Fakes and SQLite drivers ship in a deployed bundle | High |
| P7 | Layering is enforced by tooling, not prose | `jq '.. \| .noRestrictedImports? // empty' biome.json` or a boundary test exists (`rg -l "cloudflare:" packages/*/test/*boundar*`) | P2–P4 will regress silently on the next change | Medium |
| P8 | No wildcard re-export of another package | `rg -n "export \* from ['\"]@acme/" packages` | Phantom dependencies: consumers import through a package that does not own the type | Low |
| P9 | Every wire type (queue message, RPC method, DTO) has one home | `rg -n "type \w*(Message\|Event\|Job)\b\s*=" apps packages --glob '!packages/contracts/**'` | Producer and consumer shapes drift; a renamed field is dropped silently | Medium |
| P10 | Queue messages are id-only | Inspect message types in `contracts`; flag any field that is a blob, list, or full row | Messages exceed size limits and carry stale state; consumers must re-read anyway | Medium |

## 3. Bindings and config

| # | Check | Command | Failure means | Sev |
|---|---|---|---|---|
| B1 | Each deployable parses `env` once into a typed config | `rg -ln "parseConfig\|loadConfig\|z\.object" apps/*/src` — one hit per app | Missing secrets surface as runtime `undefined` deep in a handler | Medium |
| B2 | Side-effecting collaborators are required | `rg -n "(queue\|producer\|emit\|emitter\|enqueue\|starter\|workflow\|search\|index)\??\s*\?:" packages/core/src apps` | Missing wiring compiles into a silent no-op (events never sent, index never updated) | Medium (High if on a write path) |
| B3 | No I/O before routing | `rg -n -B2 -A6 "async fetch\(" apps/*/src/index.ts \| rg "await .*(init\|migrate\|schema\|prepare)"` | Cold-start tax; a hung init takes down every request on the isolate | High |
| B4 | Memoized init caches success only and is time-bounded | `rg -n "let \w*(init\|ready)\w*\s*:\s*Promise" apps packages` then read each: a rejected promise must be cleared; a timeout must exist | One failed or hung init poisons the isolate until eviction | High |
| B5 | Fakes are constructible only in local/test | `rg -n "new Fake\w+\|USE_FAKE_" apps --glob '!**/*.test.ts'` — each site is guarded by a build-time constant, not a runtime var | A deployed env var can turn production into a fake | High |
| B6 | `Env` types are generated | `rg -l "wrangler types" package.json apps/*/package.json`; hand-written `interface Env` with mostly optional fields is a finding | Bindings typed `?` hide missing config | Low |

## 4. Data

| # | Check | Command | Failure means | Sev |
|---|---|---|---|---|
| D1 | Ownership model is written down: (A) one schema owner + tenant workers, or (B) database per service | `rg -il "schema owner\|database per service" AGENTS.md docs` | Nobody knows who may run DDL; two workers eventually both do | Medium |
| D2 | Exactly one `migrations_dir` per database (both models) | `jq -r '.[] \| .file as $f \| .c.d1_databases[]? \| select(.migrations_dir) \| "\(.database_name) \($f)"' /tmp/cfgs.json \| sort` — one file per database | Competing migration chains; production schema depends on deploy order | High |
| D3 | Model A: tenant workers run no DDL. Model B: no database is bound by two workers | A: `rg -n "CREATE TABLE\|ALTER TABLE\|DROP " apps --glob '!apps/w-app/**' --glob '!**/*.test.ts'` and a `no-ddl` test per tenant. B: `jq -r '.[].c.d1_databases[]?.database_name' /tmp/cfgs.json \| sort \| uniq -d` → empty | A: a satellite mutates a schema it does not own. B: a hidden shared DB defeats service isolation | High |
| D4 | No triggers maintain derived state | `rg -n "CREATE TRIGGER" migrations apps packages` — any trigger writing an index, FTS or aggregate table | Engine locked in, writes slowed, index untestable and unrebuildable | High |
| D5 | No FTS/virtual tables in the primary database | `rg -n "VIRTUAL TABLE\|USING fts" apps/w-app/migrations` | Derived store has no single writer and no rebuild path | Medium |
| D6 | Each derived store has exactly one writer | List bindings per store: `jq -r '.[] \| .file as $f \| .c.d1_databases[]? \| "\(.binding) \($f)"' /tmp/cfgs.json`; then `rg -n "SEARCH_DB.*(prepare\|exec\|batch)" apps` hits only the indexer | Two writers race; rebuild semantics undefined | High |
| D7 | Every derived store has a rebuild command | `rg -n "reindex\|rebuild" package.json justfile scripts` | A corrupted index is unrecoverable without hand SQL | Medium |
| D8 | Applied migrations are never edited | `git log --diff-filter=M --name-only --format= -- '**/migrations/*.sql' \| sort -u` | Fresh and production databases diverge (wrangler tracks applied migrations by filename only) | High |
| D9 | Migration ordinals are unique per migrations dir | `for d in apps/*/migrations; do ls "$d" \| sed -E 's/^([0-9]+).*/\1/' \| sort \| uniq -d \| sed "s#^#$d #"; done` → empty | Apply order is ambiguous across environments | Medium |
| D10 | Destructive DDL carries a justification marker | `rg -n "DROP (TABLE\|COLUMN)" migrations \| rg -v "ALLOW-DROP"` | A drop ships without review of live data | High |
| D11 | Backfill tests start from the previous schema | `rg -l "backfill" --glob '*.test.ts'` vs. migrations that `ADD COLUMN` a column a query filters on | Correct on a fresh DB, wrong on production rows | High |
| D12 | Drizzle output is regenerated and diffed (n/a if the project chose hand-written SQL — record that decision) | `npx drizzle-kit generate && git diff --exit-code -- '**/migrations'`, and `check` runs it | Schema file and migrations disagree | Medium |
| D13 | Single-flight uses one conditional write | `rg -n "UPDATE .* WHERE .*state\|RETURNING" packages/core/src` exists for every lock; flag `SELECT … ; if (…) UPDATE` pairs | Two workers both take the lock | Medium |
| D14 | Per-user purge list is complete | Test compares the purge/footprint list against every table with a user-id column | Account deletion leaves personal data behind | High |
| D15 | Blobs live in R2, keys in D1 | `rg -n "TEXT.*(body\|content\|html\|json)" migrations` — large payload columns | D1 size and row-read cost grow with content | Low |

## 5. Async

| # | Check | Command | Failure means | Sev |
|---|---|---|---|---|
| A1 | No long work in `waitUntil` | `rg -n "waitUntil\(" apps packages/core/src` — each call must be short and loss-tolerant (logging, telemetry send) | Work is cut off silently after the response with no retry | High |
| A2 | Every retrying consumer has a DLQ, in every env | `jq -r '.[] \| .file as $f \| ([.c] + [(.c.env // {})[]])[] \| (.queues.consumers // [])[] \| select(.dead_letter_queue == null) \| "\($f) \(.queue)"' /tmp/cfgs.json` → empty | Without `dead_letter_queue`, messages that exhaust `max_retries` are discarded | High |
| A3 | Something consumes or alerts on every DLQ | Each DLQ name appears as a consumer `queue` or in an alert/metric query | Failures accumulate unseen ("inspect-only" DLQ) | Medium |
| A4 | One shared consumer failure helper | `rg -n "\.retry\(\|retryAll\(" apps` — all call sites go through one helper; `retryAll` on a poison id is a finding | One bad id blocks the batch; no backoff, permanent errors retried forever | Medium |
| A5 | Retries use backoff | `rg -n "retry\(\{\s*delaySeconds" apps packages` or `retry_delay` set in config | Hot retry loops hammer a failing dependency | Medium |
| A6 | Every status/lock table has a reaper or stale takeover | `rg -n "'(queued\|running\|fetching\|in_progress\|pending)'" migrations packages/core/src` → list tables; each must appear in the reaper or a `WHERE … updated_at < ?` takeover | A crashed run leaves the row "in progress" forever; the UI spins, retries are blocked | Medium |
| A7 | Workflow steps go through one wrapper | `rg -n "step\.do\(" apps packages --glob '!**/step*.ts'` → empty | Non-deterministic names, oversized results, no timing | Medium |
| A8 | Step results are small and serializable | Read each step's return; flag rows, blobs, class instances (check current per-step result size limit in the Workflows docs) | Step fails at the size limit or on replay | Medium |
| A9 | Paid work has one producer, an intent row, and a kill switch | `rg -n "VENDORX\|vendorx" apps packages --glob '!**/*.test.ts'` — calls originate from one producer; a config flag stops it | Unbounded spend from a re-enqueue loop | High |
| A10 | Reapers never produce paid work | Read the reaper: it flips state only | A reaper becomes a spend amplifier | High |
| A11 | Cron runs are idempotent and log one line per tick | Read `scheduled` handlers | Double-fire corrupts state; silent crons rot | Low |

## 6. Wrangler and local dev

| # | Check | Command | Failure means | Sev |
|---|---|---|---|---|
| W1 | Named envs only; root env never deployed | `rg -n "wrangler deploy(?!.*--env)" -P package.json apps/*/package.json .github` | A stray root Worker with dev bindings is deployed | Medium |
| W2 | Non-inheritable keys repeated in every env | `cfg apps/w-app/wrangler.jsonc 'Object.fromEntries(Object.entries(c.env ?? {}).map(([k,e])=>[k,["vars","d1_databases","r2_buckets","kv_namespaces","queues","services","workflows","durable_objects"].filter(x=>c[x]&&!e[x])]))'` → every list empty; confirm with `wrangler deploy --dry-run --env <name>` | That env deploys without the binding or var (bindings and `vars` are not inherited; check the current inheritable/non-inheritable list in the wrangler configuration docs) | High |
| W3 | Shared resource ids identical across configs | `jq -r '.[] \| .c.d1_databases[]? \| "\(.database_name) \(.database_id)"' /tmp/cfgs.json \| sort -u \| awk '{print $1}' \| uniq -d` → empty | Two workers bind different databases under one name | High |
| W4 | `compatibility_date` spread | `jq -r '.[].c.compatibility_date' /tmp/cfgs.json \| sort \| uniq -c` | Workers run different runtime semantics; a bump is an untested runtime change | Low |
| W5 | Env vocabulary is identical | `jq -r '.[] \| .c.env // {} \| keys[]' /tmp/cfgs.json \| sort \| uniq -c` | A worker missing an env (`dev`, `prod`) is silently not deployed there; a `production` spelling never matches `prod` | Low |
| W6 | Service binding targets resolve per env | Each `services[].service` in env X names a worker that exists in env X | Cross-env calls (dev → prod), or a deploy that fails on a missing target | High |
| W7 | A cross-config consistency test exists | `rg -l "wrangler.jsonc" --glob '*.test.ts'` | W2–W6 are re-checked only by this audit | Medium |
| W8 | Migrations run before any dev server | `rg -n "migrations apply.*--local" package.json justfile apps/*/package.json` in the `dev` path | Local dev boots on a stale schema | Low |

## 7. Testing

| # | Check | Command | Failure means | Sev |
|---|---|---|---|---|
| X1 | Three layers exist | `rg -l 'vitest-plugin\|vitest-pool-workers' apps/*/vitest*.ts`, `ls apps/*/e2e`, Node unit configs | A layer's bugs are found in production | Medium |
| X2 | No test-only twin of a consumer in the main worker | `rg -n "async queue\(" apps/w-app` while `q-consumer-*` deployables exist | The tested pipeline is not the deployed one | High |
| X3 | Test seams are absent from the deployed bundle | `npx vite build --mode production` (or `wrangler deploy --dry-run --outdir dist`), then `rg -n "login-as\|__dev\|/seed\|FakeCloudflare\|USE_FAKE_" dist` → empty | Auth bypass or fake bindings reachable in a deployed env | High |
| X4 | A test pins X3 | `rg -l "dist.*(login-as\|__dev\|Fake)" --glob '*.test.*'` | The exclusion regresses at the next refactor | High |
| X5 | Deployed configs cannot enable seams | `jq -r '.[] \| .file as $f \| [.c.vars, (.c.env // {} \| .[].vars)] \| .. \| objects \| to_entries[] \| select(.key \| test("DEV_ROUTES\|USE_FAKE")) \| "\($f) \(.key)=\(.value)"' /tmp/cfgs.json` | A deployed env has seams on | High |
| X6 | In-memory D1 limits are enforced or listed | `rg -n "bind.*limit\|LIKE.*50\|max.*variables" packages/test-utils` or a written gaps list | Unit tests pass queries D1 rejects | Low |
| X7 | Where a binding facade exists: a fake-vs-live equivalence test exists | `rg -l "Fake.*Live\|Live.*Fake" --glob '*.test.ts'` | The fake diverges and e2e proves nothing | Medium |
| X8 | Round-trip counts are asserted, not timings | `rg -n "toHaveBeenCalledTimes\|roundTrips\|queryCount" --glob '*.test.ts'` near storage | Latency regressions ship unnoticed | Low |

## 8. Observability

| # | Check | Command | Failure means | Sev |
|---|---|---|---|---|
| O1 | One logger emitting objects | `rg -n "console\.(log\|error\|warn)\(['\"\`]" apps packages/core/src --glob '!**/*.test.ts'` | String logs cannot be queried | Low |
| O2 | One error taxonomy drives level, retry and ack | `rg -n "class \w+Error extends" packages` → a domain/transient pair used by every entrypoint kind | Permanent errors are retried; transient ones are acked and lost | Medium |
| O3 | Observability enabled in every env | `jq -r '.[] \| .file as $f \| .c as $c \| ([$c] + [($c.env // {})[]])[] \| select((.observability // $c.observability).enabled != true) \| $f' /tmp/cfgs.json` → empty; the skill also expects each env to carry the full block (wrangler-and-local-dev §3) | An env has no logs at incident time | Medium |
| O4 | Telemetry leaves the hot path through a queue | `rg -n "fetch\(.*(analytics\|events\|track)" apps --glob '!apps/q-consumer-analytics/**'` | Vendor latency and outages land on user requests | Medium |
| O5 | External calls log cost | `rg -n "cost\|credits\|units" packages/core/src/vendors` | Spend cannot be attributed | Low |

## 9. Governance

| # | Check | Command | Failure means | Sev |
|---|---|---|---|---|
| G1 | Local `check` is a superset of CI | Extract CI commands: `rg -o "run: .*" .github/workflows \| sort -u`; each must be invoked by `check` or a test script | A gate that runs only in CI runs nowhere when CI is off | High |
| G2 | Agent docs do not treat CI as the gate | `rg -n "wait for CI\|CI (is\|as) the gate\|green CI" AGENTS.md docs`; optionally `gh run list --limit 5` to note whether CI runs at all | Agents push unverified work assuming CI will catch it; the local `check` is the gate, CI only re-runs it | Medium |
| G3 | Committed derived artifacts are regenerated and diffed | For OpenAPI, client types, seeds, migrations, indexes: `rg -n "git diff --exit-code" package.json apps/*/package.json` | Generated files drift from source | Medium |
| G4 | Client types are generated, not hand-written | `rg -n "fetch\w*<\w+>\(\|as Promise<\w+>\|\.json\(\) as \w+" apps/*/src --glob '!**/*.gen.ts'` | Silent drift between server responses and UI types | Medium |
| G5 | Per-deployable gates are discovered by convention | `jq -r '.tasks \| keys[]' turbo.json` includes `check:deploy`; every `apps/*/package.json` defines it | Adding a worker silently adds an ungated deployable | Medium |
| G6 | `AGENTS.md` is canonical; `CLAUDE.md` imports it | `test -f AGENTS.md && rg -n '^@AGENTS.md' CLAUDE.md` (or `test -L CLAUDE.md`) | Two agent docs drift; agents follow stale rules | Low |
| G7 | Scoped agent docs only where a dir has its own traps | `fd -H 'AGENTS.md\|CLAUDE.md' apps packages` — each has content beyond the root's | Duplicated rules that drift | Low |
| G8 | Rules name their guard | In `AGENTS.md`, each rule references a test, lint or script | Rules are enforced by memory only | Low |
| G9 | World-claims are dated or derived | `rg -n "(no production\|not yet\|currently\|we have \d+\|there are \d+\|is live\|never runs)" AGENTS.md docs \| rg -v "20[0-9]{2}-[0-9]{2}"` | A stale claim steers agents into wrong decisions | Medium |
| G10 | Hand-copied enumerations are derived | Lists of workers, queues, tables, CI steps in docs or scripts are generated or diff-checked | The forgotten entry is the ungated one | Medium |
| G11 | Reference docs cite symbols, not line numbers | `rg -n "\.tsx?:\d+\|#L\d+" docs` | Citations rot on every edit | Low |
| G12 | Changelog Unreleased discipline | `git log --since=30.days --format=%s \| rg -c "^feat"` vs. entries under `## [Unreleased]` | User-visible changes undocumented | Low |

## Running the audit

1. Build `/tmp/cfgs.json` with the helper. Run sections 1–9 in order; record each hit with
   file and symbol (not line), or command output.
2. Verify each hit before reporting it: read the code. Grep hits in tests, generated files or
   comments are not findings.
3. Check `git log --grep` for a past incident of the same shape and escalate severity if found.
4. For each finding, name the rule number from `SKILL.md` and the guard that would prevent its
   return (test, lint, script) — a fix without a guard is half a fix.

## Report template

```markdown
# Architecture audit — <project> @ <short ref>, <YYYY-MM-DD>

Scope: <apps/packages audited>. Adapted paths: <e.g. core = packages/shared>.
Totals: <n> high · <n> medium · <n> low · <n> checks not applicable (listed at end).

## Findings (most severe first)

### H1 — <one-line defect> (Rule <n>, check <ID>)
- Evidence: `<command>` → `<trimmed output>`; <file / symbol>
- Failure scenario: <concrete input/state → wrong outcome>
- Fix: <smallest change at the source>
- Guard: <test/lint/script that keeps it fixed>

### M1 — …
### L1 — …

## Top 5 fixes
| # | Fix | Closes | Effort | Guard added |
|---|---|---|---|---|
| 1 | | H1, M3 | S/M/L | |

## Strengths worth keeping
- <invariant already enforced, and by what>

## Not applicable / not checked
- <check ID> — <reason>
```

Rank the top 5 by severity first, then by how many findings one fix closes, then by effort. A
fix that adds a guard for a whole class (a boundary lint, a cross-config test, a bundle-content
test) outranks several one-off fixes.
