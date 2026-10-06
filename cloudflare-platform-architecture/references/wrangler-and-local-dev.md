# Wrangler config and local dev

Rules 22–23 in depth. This covers **how config is organized across a fleet**, and how one dev
command runs the fleet. For key-by-key syntax, see the `wrangler` skill and the Cloudflare docs.
Provisioning and CI authoring are out of scope.

Example fleet used below: `w-app` (SPA+API, owns the schema), `w-admin`, `q-consumer-enrich`,
`q-consumer-index`, `q-consumer-analytics`, `wf-vendorx-fetch`, `cron-reaper`, `pages-website`.

## 1. One config per deployable

**Rule.** Every `apps/*` deployable has exactly one `wrangler.jsonc` for deployment. Other configs
exist only for a stated purpose (§6). No shared root config, and no config that deploys two Workers.

Why: a Worker's bindings, triggers and limits describe its blast radius. When two deployables share a
config, splitting them later means untangling triggers that are already live, such as queue consumers
and Workflow ownership.

How to check: `ls apps/*/wrangler.jsonc` matches the deployable list, and each `name` is unique.

```
apps/w-app/wrangler.jsonc               # deploy (dev, prod) + e2e (env.test)
apps/w-app/wrangler.integration.jsonc   # Workers Vitest integration only, never deployed
apps/q-consumer-index/wrangler.jsonc
apps/cron-reaper/wrangler.jsonc
...
```

## 2. Named envs only

**Rule.** Every deployed environment is a named `env.<name>` block with an explicit `name`
(`{env}-{product}-{purpose}`, e.g. `prod-acme-w-app`). The top level holds only inheritable keys and
is **never deployed**. The deploy script must not run without an env.

Why: the top-level Worker is a separate deployment with its own name. A deploy that forgets the env
creates or overwrites that stray Worker, which runs with whatever bindings sit at the top level.

How to check:
- Every `env.*` block sets `name`.
- Every deploy script passes an env (`CLOUDFLARE_ENV=` at build for Vite apps, `--env` for plain
  wrangler apps). `grep -n "wrangler deploy" package.json apps/*/package.json` shows no bare call.
- Top-level bindings either do not exist or are dead weight. Delete them (§9).

Env vocabulary is closed and identical in every config: `dev`, `prod` and `test` (local e2e
only), the same words as `RUNTIME_ENV` (which adds `local`) and the resource prefixes. Never mix
`prod` and `production` across Workers, or across a config and a `RUNTIME_ENV` var: a branch on
`env === "prod"` silently never matches the other spelling.

## 3. Non-inheritable keys are repeated per env, byte-identical

**Rule.** Write every non-inheritable key out in full inside every env that needs it. Keep the
blocks that should be the same byte-identical, so a diff shows only the intended differences.

Non-inheritable per the docs: `vars`, `define`, `secrets`, and every binding (`d1_databases`,
`durable_objects`, `kv_namespaces`, `r2_buckets`, `queues`, `services`, `workflows`, `vectorize`,
`tail_consumers`, …). Check the current list in the wrangler configuration docs; it grows.

Repeat these per env too, although the docs list them as inheritable:
- `assets`. One fleet's env that omitted it (relying on inheritance through the Vite build's
  flattening) deployed the Worker with no static assets. An explicit block costs nothing.
- `observability`. Explicit per env, so the consistency test (§5) can compare it.

Keep the other inheritable keys **once** at the top level: `main`, `compatibility_date`,
`compatibility_flags`, `limits`, `placement`. Mark the boundary in the file. `triggers` is
inheritable too, so a cron at the top level fires in **every** env. Put crons inside the envs
that should run them.

Why: an env block **replaces** a non-inheritable key; it does not merge. If `env.prod.vars`
has three keys, the four top-level vars do not exist in production. Nothing errors at deploy, and
the Worker reads `undefined`.

```jsonc
{
  "name": "acme-w-app",                    // never deployed
  "main": "./worker/index.ts",
  "compatibility_date": "2026-06-01",    // inheritable: once
  "compatibility_flags": ["nodejs_compat"],
  "limits": { "cpu_ms": 60000 },
  // ---- everything below is NON-INHERITABLE: repeated in every env ----
  "env": {
    "dev": {
      "name": "dev-acme-w-app",
      "assets": { "directory": "./dist/client/", "binding": "ASSETS",
                  "not_found_handling": "single-page-application", "run_worker_first": ["/api/*"] },
      "observability": { "enabled": true },
      "vars": { "RUNTIME_ENV": "dev", "PUBLIC_ORIGIN": "https://dev.acme.example" },
      "d1_databases": [{ "binding": "DB", "database_name": "dev-acme-db", "database_id": "…",
                         "migrations_dir": "migrations" }],
      "queues": { "producers": [{ "binding": "INDEX_QUEUE", "queue": "dev-acme-index" }] },
      "services": [{ "binding": "VENDORX", "service": "dev-acme-wf-vendorx-fetch",
                     "entrypoint": "VendorxRpc" }]
    },
    "prod": { /* same shape, prod-* names and ids */ }
  }
}
```

How to check: run `wrangler deploy --dry-run` per env (wire it as each app's `check:deploy` turbo
task) and diff the env blocks. The cross-config test in §5 catches drift between Workers.

## 4. Cross-Worker targets use the deployed, env-qualified name

**Rule.** `services[].service`, `durable_objects.bindings[].script_name`, a Workflow's
`script_name` and queue names all name the **deployed** Worker or resource in **that** env, for
example `prod-acme-w-app`, never `acme-w-app`.

Why: a binding that points at the top-level name is looking for a Worker that was never deployed.
One production deploy failed with "Service binding references Worker '…' which was not found",
while dev worked because its target had been typed correctly. Without an explicit `name`, an env
Worker is called `<name>-<env>`. With explicit names (§2), the target is whatever that `name` says.

How to check: the consistency test (§5) collects every Worker's `env.<e>.name` and asserts that each
`service` or `script_name` in `env.<e>` is in that set for the same `e`.

## 5. Optional: a cross-config consistency test

Recommended, not mandated. It is cheap, and it catches what humans miss when an id is hand-copied
into six files.

```ts
// tools/wrangler-consistency.test.ts — node vitest
import { readFileSync } from "node:fs";
import { globSync } from "glob";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

const ENVS = ["dev", "prod"] as const;
const configs = globSync("apps/*/wrangler.jsonc").map((path) => ({
  path, cfg: parse(readFileSync(path, "utf8")) as any,
}));
const envBlocks = (e: string) =>
  configs.filter((c) => c.cfg.env?.[e]).map((c) => ({ path: c.path, block: c.cfg.env[e] }));

describe("wrangler configs agree", () => {
  it("use one env vocabulary", () => {
    for (const { path, cfg } of configs)
      for (const e of Object.keys(cfg.env ?? {}))
        expect([...ENVS, "test"], path).toContain(e);
  });

  it("align compatibility_date across Workers that share core", () => {
    const dates = new Set(configs.filter((c) => c.cfg.main).map((c) => c.cfg.compatibility_date));
    expect([...dates]).toHaveLength(1);
  });

  for (const e of ENVS) {
    it(`${e}: one D1 id per database name`, () => {
      const ids = new Map<string, string>();
      for (const { path, block } of envBlocks(e))
        for (const db of block.d1_databases ?? []) {
          const seen = ids.get(db.database_name) ?? db.database_id;
          expect(db.database_id, `${path} ${db.database_name}`).toBe(seen);
          ids.set(db.database_name, seen);
          expect(db.database_name.startsWith(`${e}-`)).toBe(true);
        }
    });

    it(`${e}: every queue consumed has a producer, one consumer each`, () => {
      const produced = new Set<string>(), consumed: string[] = [];
      for (const { block } of envBlocks(e)) {
        for (const p of block.queues?.producers ?? []) produced.add(p.queue);
        for (const c of block.queues?.consumers ?? []) consumed.push(c.queue);
      }
      expect(new Set(consumed).size).toBe(consumed.length);   // one consumer per queue
      for (const q of consumed) expect(produced.has(q) || q.endsWith("-dlq"), q).toBe(true);
    });

    it(`${e}: service and DO targets name a Worker deployed in ${e}`, () => {
      const names = new Set(envBlocks(e).map((b) => b.block.name));
      for (const { path, block } of envBlocks(e)) {
        for (const s of block.services ?? []) expect(names, path).toContain(s.service);
        for (const d of block.durable_objects?.bindings ?? [])
          if (d.script_name) expect(names, path).toContain(d.script_name);
      }
    });

    it(`${e}: identical observability block`, () => {
      const blocks = new Set(envBlocks(e).map((b) => JSON.stringify(b.block.observability)));
      expect(blocks.size).toBe(1);
    });
  }
});
```

Run it inside `check`. The alternative is to generate every config from one manifest. That is
heavier, and worth it only when the test's allow-lists start to sprawl.

## 6. Separate configs by purpose

| Config | Used by | Contains | Must not |
|---|---|---|---|
| `wrangler.jsonc` `env.dev` / `env.prod` | deploy | real names, ids, routes, public vars | carry `USE_FAKE_*`, dev-route or seed flags |
| `wrangler.jsonc` `env.test` | `CLOUDFLARE_ENV=test vite dev` (Playwright) | test vars, fake-layer flags | be deployable (never in a deploy script) |
| `wrangler.integration.jsonc` | `@cloudflare/vitest-plugin` (layer 2) | the real queues, Workflows, D1 and R2, plus the **real** consumer Workers as auxiliary Workers | model a topology that no longer ships (test-only twin consumers) |

**Rule.** The integration config models the **deployed topology**. If production splits a
consumer into `q-consumer-index`, the integration pool runs that Worker, not a branch of `w-app`
that pretends to be it.

Why: one integration config kept modelling the old single-Worker shape after the split. The suite
stayed green while it tested code paths that no deployed Worker ran.

How to check: compare the queue consumers and service targets in the integration config with the
deployed configs. The same consistency test can include it under a pseudo-env.

Only the env that local e2e actually selects needs an `env.test` block. Auxiliary Workers that e2e
never loads (the fake layer bypasses their queues) do not need one. **Delete unreachable env
blocks**, because they rot unseen.

## 7. `CLOUDFLARE_ENV` vs `--env` with the Vite plugin

With `@cloudflare/vite-plugin`, the env is chosen **at build time** by `CLOUDFLARE_ENV`. The build
writes a **flattened** `dist/<worker>/wrangler.json` that contains only the active env at the top
level. That flattened file, not your source config, is what ships.

**Rules.**
- Set `CLOUDFLARE_ENV` on the **build** step. `wrangler deploy` reads the flattened output and needs
  no env selection; if you also pass it to deploy, it must be the **same** value.
- Never let `CLOUDFLARE_ENV` leak from a shell profile or a job-wide env into unrelated commands.
- Commands that read the **source** config (`wrangler d1 migrations apply`, `wrangler secret put`,
  non-Vite Workers) take `--env <e>` explicitly. `--env` takes precedence over `CLOUDFLARE_ENV`.

Why: in one failure, a leaked `CLOUDFLARE_ENV` reached `wrangler deploy` with a value that did not
match the build. The deploy landed under a derived name (`<name>-<env>`), so a second Worker took
over the Workflows and broke queue-consumer triggers the real one owned. Current wrangler validates
that the deploy env matches the build env and fails instead. That still breaks the deploy, so keep
the variable scoped.

How to check:
- `grep -rn CLOUDFLARE_ENV .github/ scripts/ package.json apps/*/package.json` finds it only on
  build commands and local e2e/dev scripts.
- After a build, `jq .name dist/*/wrangler.json` prints the expected `{env}-…` names.

Inspect the flattened artifact when you debug a deploy. Do not reason from the source config.

## 8. `compatibility_date`: aligned and deliberate

**Rule.** All Workers that run the shared `core` package use the same `compatibility_date`. If they
cannot, run core's tests under each date. **A bump is a runtime change.** It gets its own commit,
and a config comment lists the flags it turns on that touch your code.

Why: a date bump silently opts the Worker into every compatibility flag that became default in
between. One jump enabled dozens of flags, and several changed observable behavior (redirect
header handling, Durable Object storage/alarm semantics, WebSocket defaults). With split dates, the
same `core` function behaved differently in the HTTP Worker and in the consumers.

Also, the local runtime bundled with your pinned wrangler supports dates only up to its own release;
for a newer date it warns and falls back, so local runs no longer test the date you deploy. Bump
wrangler before you bump the date.

How to check: the consistency test (§5) asserts one date. Review a date bump the way you would
review a dependency upgrade: read the flags it enables.

## 9. Delete what nobody tunes

**Rule.** Remove the following:
- env blocks no command selects
- top-level `vars` that every env overrides
- env "knobs" that appear in no config, test or script, or are set only to their code default

A knob nobody turns becomes a module constant.

Why: dead config looks like live config. It suggests a value is tunable or an env is real, and
readers lose time keeping it in sync. In one cleanup, several unreachable `env.test` blocks and
unused knobs went in a single commit; one knob was set in every env to the code's own default.

How to check: for each `vars` key, `grep -rn KEY apps packages` must find a reader and a reason for
it to differ per env.

## 10. Local dev: one command, the whole fleet

**Rule.** `vite dev` in the UI app (`w-app`) is the only dev command. The other Workers it talks to
are loaded through `auxiliaryWorkers` in **one** Miniflare instance, on shared persisted state.

```ts
// apps/w-app/vite.config.ts
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

const isE2E = process.env.CLOUDFLARE_ENV === "test";
const aux = (app: string) => ({ configPath: path.resolve(__dirname, `../${app}/wrangler.jsonc`) });

export default defineConfig({
  plugins: [
    cloudflare(
      isE2E
        ? { persistState: false }            // e2e: ephemeral, fake durable layer, no consumers
        : { auxiliaryWorkers: ["q-consumer-enrich", "q-consumer-index",
            "q-consumer-analytics", "wf-vendorx-fetch", "cron-reaper"].map(aux) },
    ),
  ],
});
```

Why: the docs recommend a single dev command whenever producer and consumer live in different
Workers, or a DO/Workflow is reached through `script_name`. A consumer started in its own
`wrangler dev` was never wired to the producer and received nothing. Separate processes on separate state also mean two
databases that disagree.

Facts to design around:
- **Auxiliary Workers do not inherit the entry Worker's `.dev.vars`.** Each loads the `.dev.vars`
  next to its own config. Commit a `.dev.vars.example` per Worker that needs secrets. One local
  enrich consumer failed every batch with a vendor auth error because its key lived only in the
  entry Worker's file.
- Crons do not fire on their own in dev. Trigger the handler with
  `curl localhost:<port>/cdn-cgi/local/scheduled` and wrap that in a script (`pnpm cron:run`). Check
  that your plugin version reaches an auxiliary Worker's handler this way. If it does not, unit-test
  the scheduled module directly, never through a dev route that could ship.
- A paid vendor Worker running as an auxiliary Worker bills for real once you give it a real token,
  including for synthetic seed ids. Without a token, its declining path must be a no-op.
- Only the entry Worker is deployed by `wrangler deploy`. Each auxiliary Worker deploys from its own
  `dist/<worker>/wrangler.json` or its own lane.
- An admin console runs its own `vite dev` with the owner (`w-app`) as one of **its** auxiliary
  Workers, so its RPC binding reaches the real `WorkerEntrypoint` instead of a fake that drifts
  ([topology](topology.md#second-app-admin-shape)).

How to check: `pnpm dev` boots, and the log lists every auxiliary Worker. Enqueue one id and watch
the consumer log it.

## 11. Migrate before boot; local state is disposable

**Rule.** The dev and e2e scripts run `wrangler d1 migrations apply <db> --local --env <e>` against
the **same persist path** the dev server uses, **before** the server starts. Nothing applies schema
on the request path. Local and dev databases can be wiped and rebuilt; production never is.

```jsonc
// apps/w-app/package.json
"dev": "pnpm migrate:local && vite dev",
"migrate:local": "wrangler d1 migrations apply dev-acme-db --local --env dev --persist-to ../../.wrangler/state"
```

Why: a persisted local database falls behind the migrations, and the first symptom is a confusing
runtime "no such column". Request-path schema init is the worse fix. In production, a memoized init
whose promise hung kept half the API hanging until redeploy. See rule 12.

Guard destructive local operations (wipe, reseed) with a check that refuses non-local targets.
Keep e2e state **ephemeral** (`persistState: false`). A persisted e2e database accumulated
seeded data across runs until local FTS queries slowed from milliseconds to seconds and tripped
test timeouts. Ephemeral state has no file to migrate, so e2e global setup applies the **same
migration files** before the first test, for example through the test-only seed route, which never
ships (rule 25).

How to check: `grep -rn "CREATE TABLE\|initSchema" apps/*/worker apps/*/src` finds nothing outside
migrations and test-only setup. Delete `.wrangler/state`, run `pnpm dev`, and the app works.

## 12. Vars and secrets

| Kind | Where | Committed |
|---|---|---|
| Public config (origins, feature flags, client ids) | `env.<e>.vars` | yes |
| Secrets, local | `apps/<w>/.dev.vars` (per Worker) | no (`.dev.vars*` in `.gitignore`), but `.dev.vars.example` yes |
| Secrets, e2e / integration | **generated** `.dev.vars.test` or fixed fake values in the test config | generated file no, generator yes |
| Secrets, deployed | `wrangler secret put NAME --env <e>` | no |

Note: when `.dev.vars.<env>` exists, it is loaded **instead of** `.dev.vars`, not merged. Pick
either `.dev.vars` or `.env` files, not both.

**Rule.** Parse vars once in the composition root (rule 9). Then a missing core secret fails at the
first request with its name, not deep inside a handler. Use `wrangler types` to generate `Env`
rather than hand-writing an interface of optional fields.

Why: a secret committed in `vars` is public to everyone with repo access, and a secret read lazily
deep in a handler fails as a confusing runtime error on the first request that needs it.

How to check: `git ls-files | grep -E '\.dev\.vars($|\.)' | grep -v example` is empty.

## 13. SPA fallback and stale tabs

With `not_found_handling: "single-page-application"` and an array `run_worker_first`, any request
outside those patterns that matches no asset gets `/index.html` with **200 `text/html`**. That
includes a hashed JS chunk deleted by the last deploy.
An open tab that lazy-loads `/assets/route-abc123.js` after a deploy receives HTML. The dynamic
import fails with a MIME or parse error, and the route goes blank.

**Rules.**
- Treat a failed dynamic import as "new version available": catch it once and reload. With Vite,
  listen for `vite:preloadError` and call `location.reload()`, with a guard against reload loops.
- Keep `run_worker_first` to the API prefix (`["/api/*"]`). An honest 404 for `/assets/*` misses
  would need `"/assets/*"` in that list, which bills a Worker invocation for every asset request.
  Negative (`!`) patterns only carve exclusions out of positive ones; they cannot route misses
  anywhere. The reload handler is the cheaper fix.

```ts
// apps/w-app/src/main.tsx
window.addEventListener("vite:preloadError", (e) => {
  if (sessionStorage.getItem("reloaded-for-chunk")) return;
  sessionStorage.setItem("reloaded-for-chunk", "1");
  e.preventDefault();
  location.reload();
});
```

How to check: build, open the app, rebuild with a changed route component, deploy locally
(`vite preview`), and navigate to that route in the old tab. It reloads rather than going blank.

## Checklist

- [ ] One `wrangler.jsonc` per deployable; named envs with explicit `name`; top level never deployed
- [ ] Non-inheritable keys, `assets` and `observability` repeated per env; inheritable keys once
- [ ] Service, DO and Workflow targets use env-qualified deployed names
- [ ] Consistency test (or manifest generation) covers D1 ids, queues, targets, dates,
      observability, env vocabulary
- [ ] `CLOUDFLARE_ENV` only on build and local dev/e2e; `--env` on source-config commands
- [ ] One `compatibility_date` across core-sharing Workers; bumps reviewed flag by flag
- [ ] Integration config runs the deployed topology; no test-only twins
- [ ] One `vite dev` with `auxiliaryWorkers`; per-Worker `.dev.vars.example`
- [ ] Migrations before boot; e2e state ephemeral; no request-path DDL
- [ ] No dead env blocks, top-level vars or untuned knobs
- [ ] Stale-chunk reload handler in every SPA
