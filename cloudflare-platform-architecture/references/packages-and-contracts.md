# Packages & contracts

Rules 5–8 in depth: how shared code is tiered, how wire shapes and API types get exactly one home,
how layering is enforced, and how one read layer serves every surface. Example product: **acme**
(ingest documents → enrich → index for search).

```
packages/
  contracts/    zero deps: structural ports + wire types (queue messages, RPC shapes)
  core/         domain + storage + handlers + producers; depends on contracts (+ zod, drizzle)
  api-client/   browser-safe: generated OpenAPI types + typed fetch client + zod request schemas
  test-utils/   in-memory D1, fake R2/queue/step; devDependency ONLY
apps/
  w-app  w-admin  q-consumer-enrich  q-consumer-index  q-consumer-analytics
  wf-vendorx-fetch  cron-reaper  pages-website
```

Dependency graph (arrows = "imports"):

```
contracts ◄── core ◄── apps/*
    ▲          ▲
    │          └── test-utils (devDependency of core and apps)
    └───────────── test-utils
api-client ◄── apps/w-app (SPA side), apps/w-admin (SPA side)
```

## 1. Three tiers (rule 5)

**Rule.** `contracts` is a leaf with zero dependencies. `core` holds all non-UI logic and depends on
`contracts`. `test-utils` depends on `contracts` (never on `core`) and appears only in
`devDependencies`.

Why: the first version of a test package usually imports the production package to get a `D1Like`
type, while production tests import the test package — a cycle. And a test package carrying a
native module (an in-memory SQLite driver) leaks into a Worker bundle the moment it is a runtime
dependency, failing the deploy or bloating the script.

How to check:

```bash
# contracts has no dependencies of any kind except dev typing
jq -e '(.dependencies // {}) == {} and (.peerDependencies // {}) == {}' packages/contracts/package.json
# test-utils is never a runtime dependency anywhere
grep -l '"@acme/test-utils"' apps/*/package.json packages/*/package.json \
  | xargs -I{} jq -e '(.dependencies // {}) | has("@acme/test-utils") | not' {}
# test-utils does not import core
! grep -rn "from '@acme/core" packages/test-utils/src
```

### What goes in `contracts`

Structural ports — the minimum surface `core` calls, typed without `@cloudflare/workers-types`:

```ts
// packages/contracts/src/ports.ts
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch<T = unknown>(stmts: D1StatementLike[]): Promise<{ results: T[] }[]>;
}
export interface QueueLike<M> {
  send(body: M, opts?: { delaySeconds?: number }): Promise<void>;
  sendBatch(msgs: { body: M; delaySeconds?: number }[]): Promise<void>;
}
export interface StepLike {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
}
export interface WorkflowLike<P> {
  create(opts: { id?: string; params: P }): Promise<{ id: string }>;
}
```

The real `D1Database`, `Queue<M>` and `Workflow<P>` satisfy these structurally, so the composition
root passes `env.DB` straight in, and tests pass in-memory fakes from `test-utils`. Where a runtime
signature is stricter than the port (`WorkflowStep.do` constrains `T` to serializable values and
has config overloads), the composition root wraps it in a one-line adapter rather than widening the
port to the runtime type. Drizzle's D1 driver is constructed in the app's storage adapter from
`env.DB`; `core` sees only the port or the Drizzle instance it is handed. Plus every wire
type (section 3). Nothing else: no functions with logic, no zod, no constants that are policy.

Keep ports narrow. If `core` needs `R2Bucket` or `WorkflowStep`, add the method it calls to a port
— a leaked runtime type is how the core quietly starts requiring workerd to typecheck.

## 2. Packages as TypeScript source; subpath exports per runtime surface

**Rule.** Workspace packages ship `.ts` source, not build output. `exports` points at `./src/*.ts`;
each consumer compiles it under its own tsconfig (`moduleResolution: "bundler"`). Wrangler,
Vite and vitest all bundle TS source directly — no `build` step, no stale `dist/`.

**Rule.** When one package serves more than one runtime, split by subpath export, one per surface:

```json
{
  "name": "@acme/core",
  "type": "module",
  "exports": {
    ".":         "./src/index.ts",
    "./domain":  "./src/domain/index.ts",
    "./storage": "./src/storage/index.ts"
  },
  "dependencies": { "@acme/contracts": "workspace:*", "drizzle-orm": "…", "zod": "…" },
  "devDependencies": { "@acme/test-utils": "workspace:*" }
}
```

| Subpath | Runtime surface | Who may import it |
|---|---|---|
| `.` | workerd (wires adapters that touch `cloudflare:*`) | Worker entrypoints / composition roots |
| `./domain` | runtime-neutral | Node scripts, codegen, tests, any worker |
| `./storage` | any runtime that is handed a D1 port | workers, Node tests over in-memory D1 |

Why: a Node script (OpenAPI generator, seed builder, migration helper) that imports the package root
drags in `cloudflare:workers` and dies with an unresolvable specifier. A browser bundle that reaches
a server barrel pulls in drizzle and the storage layer.

How to check: a Node-run script imports only runtime-neutral subpaths —

```bash
! grep -rn "from '@acme/core'" apps/*/scripts packages/*/scripts   # root barrel is workerd-only
```

Avoid `export * from '@acme/contracts'` re-exports in `core`: consumers then import contract types
from `core`, gaining a phantom dependency that breaks when a consumer only depends on `contracts`.
Import from the home package.

## 3. Wire types: one home, id-only, evolved safely (rule 6)

**Rule.** Every shape that crosses a deployable boundary — queue message, RPC method signature,
Workflow params — is declared once in `contracts` and imported by producer and consumer.

```ts
// packages/contracts/src/messages.ts
/** id-only: the consumer re-reads the row when it applies the message. */
export type IndexMessage =
  | { kind: 'document'; documentId: string }
  | { kind: 'collection'; collectionId: string }
  | { kind: 'purge'; documentId: string };

export interface EnrichMessage {
  documentId: string;
  /** Absent ⇒ false. Paid vendor fetch is opt-in; old producers must never trigger spend. */
  vendorFetch?: boolean;
}
```

- **Id-only.** Messages carry ids; the consumer reads current state when it applies. At-least-once
  delivery, reordering and duplicates then converge on the same result, and a message enqueued
  before a deploy never carries a stale snapshot.
- **Evolve by optional field or union variant.** Producer and consumer deploy independently and
  old messages stay in flight across both deploys. A new field is optional, and its **absent value
  is the safe one** (no spend, no deletion, no side effect). A new behaviour is a new `kind`
  variant; the consumer's `switch` gets an exhaustive `never` default that acks-and-logs unknown
  kinds instead of retrying them forever.
- **Audit every producer** when you add a field: a flag whose default is "on" silently changes the
  meaning of every message an un-updated producer sends.

How to check:

```bash
# no wire type is redeclared outside contracts
grep -rnE "(interface|type) (IndexMessage|EnrichMessage|AnalyticsMessage)\b" apps packages \
  | grep -v packages/contracts/
# every producer of a message is listed when the type changes
grep -rn "QueueLike<EnrichMessage>" packages/core/src apps/*/src
```

RPC between workers follows the same rule: the `WorkerEntrypoint` class lives in the owning worker,
its method parameter and return types live in `contracts` as an interface the class implements, and
the caller types its service binding with that interface — never by importing the other app.

## 4. API types are generated, never hand-written (rule 7)

**Rule.** The server is the source; types flow one way:

```
route (createRoute + zod)  ─►  scripts/gen-openapi.ts  ─►  openapi.json (committed)
                                                            │ openapi-typescript
                                                            ▼
                                      packages/api-client/src/schema.d.ts (committed)
                                                            │ openapi-fetch createClient<paths>
                                                            ▼
                                                   SPA / admin / CLI callers
```

1. Declare routes code-first with `@hono/zod-openapi` (`createRoute` + `app.openapi`), so one zod
   schema drives runtime validation and the spec. Tie response schemas to domain types:
   `export const DocumentSummary = z.object({...}) satisfies z.ZodType<DocumentSummaryRow>;` — a
   renamed field breaks the build instead of the client.
2. Generate the spec **offline**: the script imports the app factory (`createApp(deps)`), never the
   Worker entry, builds it with stub deps and a fixed config, and writes
   `app.getOpenAPIDocument(...)` deterministically. Dev/test routes are not registered, so they
   never enter the spec.
3. Generate client types with `openapi-typescript openapi.json -o packages/api-client/src/schema.d.ts`
   and wrap with `openapi-fetch`:

```ts
// packages/api-client/src/index.ts
import createClient from 'openapi-fetch';
import type { paths } from './schema';
export const createApiClient = (baseUrl: string) => createClient<paths>({ baseUrl });
export type { paths, components } from './schema';
```

4. `check` regenerates both and diffs:

```jsonc
// apps/w-app/package.json
"gen:openapi":   "tsx scripts/gen-openapi.ts && openapi-typescript openapi.json -o ../../packages/api-client/src/schema.d.ts",
"check:openapi": "pnpm gen:openapi && git diff --exit-code -- openapi.json ../../packages/api-client/src/schema.d.ts"
```

Mark the turbo task `"cache": false` — a cached green says nothing about the files on disk.

Fallback when the spec cannot cover a surface (streaming, MCP, a framework without OpenAPI): a script
copies the server's generated or source types into `api-client`, and `check` reruns it and diffs.
Still generated; never edited by hand.

Why: hand-mirrored response DTOs in the SPA type-check forever while the server drifts; nothing ties
them together. The review that shaped this skill found every response type, status union and error
code map duplicated by hand in the client — correct that day, unguarded from then on.

How to check:

```bash
pnpm check:openapi                                          # regenerate + diff
grep -rnE "fetch(Json)?<[A-Z]" apps/*/src | wc -l           # unchecked fetch<T> casts → should trend to 0
grep -rnE "^export (interface|type) \w+(Response|Dto)\b" apps/*/src   # hand-written response types
```

Bring every surface a client reads into the spec, including admin and any anonymous/demo routes;
an endpoint outside the spec is an endpoint with hand-written client types.

### Browser-safe request schemas

**Rule.** Request parameter schemas (and their enum tuples, max page sizes, `.describe()` texts)
live once, as plain zod, in a browser-safe module (`@acme/api-client/params` or a separate
`api-schemas` package). Add `.openapi()` metadata only in the route layer, so the module never
imports `@hono/zod-openapi`.

```ts
// packages/api-client/src/params.ts — plain zod only
export const DOCUMENT_SORTS = ['newest', 'oldest', 'title'] as const;
export const DocumentSearchParams = z.object({
  q: z.string().optional().describe('Full-text query. Omit to list everything in scope.'),
  sort: z.enum(DOCUMENT_SORTS).default('newest'),
  page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
});
```

Three consumers import it: the Worker route (validation + spec), MCP/LLM tools
(`inputSchema: DocumentSearchParams.shape` — the `.describe()` strings *are* the model's docs), and
the SPA (enum tuples, limits). Why: two schemas for one endpoint drift — a tool that marked `q`
required while the route treated it optional made the model invent a wildcard that matched nothing.

How to check: `! grep -rn "@hono/zod-openapi" packages/api-client/src`, and
`rg -n 'z\.object\(' -g '*mcp*' apps packages/core` finds no second schema for an endpoint that already
has one in `params.ts`.

Pin LLM-facing tool metadata (names, descriptions, input schemas, annotations) as a snapshot
fixture; the text is behavioural contract, and a reworded description changes behaviour no wiring
test can see.

## 5. Layering is enforced by tooling (rule 8)

| Rule | Mechanism |
|---|---|
| `core` imports no `cloudflare:*`, no Hono, no `@cloudflare/workers-types` runtime types | Biome override on `packages/core/**` |
| `contracts` imports nothing but itself | grep test: no `from '[^.]` in `packages/contracts/src` |
| no app imports another app | Biome pattern on `apps/**` |
| browser code imports no server package | Biome override on `apps/*/src/**` (SPA side) |
| `env` is read only in the composition root / binding facade | grep test (Biome cannot see property reads) |
| `test-utils` only in devDependencies | package.json test (section 1) |

```jsonc
// biome.json (Biome 2.x: overrides take "includes"; confirm your version supports
// noRestrictedImports "patterns", otherwise list each specifier under "paths")
{
  "overrides": [
    {
      "includes": ["packages/core/src/**", "!**/*.test.ts"],
      "linter": { "rules": { "style": { "noRestrictedImports": {
        "level": "error",
        "options": {
          "paths": {
            "cloudflare:workers":   "core takes ports from @acme/contracts, not runtime bindings",
            "cloudflare:workflows": "core takes StepLike from @acme/contracts",
            "@cloudflare/workers-types": "use the structural ports in @acme/contracts",
            "hono": "HTTP belongs to the app's route layer"
          },
          "patterns": [{ "group": ["hono/*", "@hono/*"], "message": "HTTP belongs to the app's route layer" }]
        }
      } } } }
    },
    {
      // SPA source only: in UI apps the Worker lives in worker/, the browser bundle in src/
      "includes": ["apps/w-app/src/**", "apps/w-admin/src/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": {
        "level": "error",
        "options": {
          "paths": { "@acme/core": "browser code imports @acme/api-client only" },
          "patterns": [
            { "group": ["@acme/core/*", "@acme/test-utils", "@acme/test-utils/*"], "message": "server/test package in browser code" },
            { "group": ["../../*/src/**", "../../*/worker/**"], "message": "no app→app imports" }
          ]
        }
      } } } }
    },
    {
      "includes": ["apps/**", "!apps/w-app/src/**", "!apps/w-admin/src/**"],
      "linter": { "rules": { "style": { "noRestrictedImports": {
        "level": "error",
        "options": {
          "patterns": [{ "group": ["../../*/src/**", "../../*/worker/**", "@acme/w-*", "@acme/q-consumer-*"], "message": "no app→app imports: share via packages/ or RPC" }]
        }
      } } } }
    }
  ]
}
```

Scope the browser override to the SPA directories by name. A blanket `apps/*/src/**` also matches
non-UI workers (`q-consumer-*/src`), which must import `@acme/core`. Keep each file matched by
exactly one `noRestrictedImports` override (hence the negated globs) rather than relying on how
overlapping overrides combine options. Prove each override bites: add a deliberate violation and
confirm `biome lint` fails.

Where a rule is not an import (reading `env`, raw SQL outside `storage/`), use a vitest grep test
that runs in the normal unit suite:

```ts
// packages/core/src/layering.test.ts — runs under Node, cwd = packages/core
import { globSync, readFileSync } from 'node:fs'; // globSync: Node 22+
import { expect, it } from 'vitest';
const files = globSync('src/**/*.ts').filter((f) => !f.endsWith('.test.ts'));
it('scans something', () => expect(files.length).toBeGreaterThan(0)); // an empty glob passes vacuously

it.each(files)('%s reads no env and imports no runtime', (f) => {
  const src = readFileSync(f, 'utf8');
  expect(src).not.toMatch(/\benv\.[A-Z_]+/);
  expect(src).not.toMatch(/from ['"]cloudflare:/);
});
```

Why: "core is framework-free" written in a doc decays within weeks; the first violation compiles,
deploys and becomes precedent. Every layering sentence in `AGENTS.md` names the override or test
that enforces it.

## 6. Client data layer: minimal mutations + one invalidation map

**Rule.** TanStack Query owns server state; the UI store (Zustand or similar) holds UI state only
(selection, panels, drafts) — never a copy of a server row. Mutations return a minimal
`{ ok: true }` (or the new id); the client reconciles by invalidating, not by merging a response.

**Rule.** One function maps an action to the query keys it stales, built from a hierarchical key
factory. Every writer on the client — UI mutation hooks, an agent tool-call bridge, a realtime
push — calls it.

```ts
// apps/w-app/src/queries/invalidation.ts
export type Action =
  | { type: 'addCollection'; collectionId?: string }
  | { type: 'reindexDocument'; documentId: string };

export function invalidationsFor(a: Action): QueryKey[] {
  switch (a.type) {
    case 'addCollection':   return [keys.collections.all(), keys.usage()];
    case 'reindexDocument': return [keys.documents.detail(a.documentId), keys.usage()];
  }
}
```

Why: per-hook `invalidateQueries` calls diverge — a button refreshes the usage meter, the same action
via the agent does not. Writes that bypass the map (an agent tool, a background job finishing) are
the stale-UI bug class; route them through an `Action`.

How to check: `grep -rn "invalidateQueries(" apps/*/src | grep -v invalidation.ts` — every hit
should take its keys from `invalidationsFor`. Unit-test the map per action type.

Do not build a second client data layer (a hand-rolled cache, a store mirroring server rows) to fix
a perceived gap without first proving the query cache cannot express it.

## 7. One read layer behind every surface

**Rule.** Each read is one framework-free function over the storage port — no Hono, no request object —
returning a result envelope. REST handlers, MCP tools and an in-process agent are thin adapters.

```ts
// packages/core/src/reads/result.ts
export type ReadResult<T> = { ok: true; item: T } | { ok: false; status: 400 | 404; error: string };

// packages/core/src/reads/documents.ts
export async function readDocumentPage(s: Storage, user: UserId, p: DocumentSearchParams)
  : Promise<ReadResult<DocumentPage>> { … }
```

- REST: `const r = await readDocumentPage(...); return r.ok ? c.json(r.item) : c.json({ error: r.error }, r.status);`
- MCP: the tool calls the same function and maps `ok: false` to a tool error.
- In-process agent: connect to the same MCP server over an in-memory transport instead of defining
  tools twice.

Why: a page that shows data the agent cannot see (or vice versa) becomes structurally impossible,
and a new surface costs one adapter.

**Rule.** Never reshape a shared read for one consumer. Cap the render, not the request: a page
that wants 50 rows slices in the component; a request-side bound reuses an existing per-caller
parameter. Do not add a wire field whose only job is to say "partial" when totals (`total`,
`hasMore`) already say it. UI-only fields are listed by name so a REST-vs-MCP parity test strips
them deliberately.

How to check: a parity test calls each read through REST and MCP for the same seeded user and
asserts equal payloads (minus the named UI-only fields), with a precondition that the read
succeeded — a parity test over two empty results proves nothing.

## 8. Surface variants via slots, never `isX` flags

**Rule.** When two surfaces show the same UI (signed-in app vs public demo, user vs admin view),
share the components and express the difference as **unfilled slots** plus a scope context
(`<SurfaceScope api={demoApi}>`), never `isDemo` / `isAdmin` props threaded through the tree.

```tsx
<DocumentPage
  header={<DocumentHeader />}
  actions={canEdit ? <EditActions /> : null}   // demo leaves the slot empty
/>
```

Why: flags multiply into untestable branch combinations, and copied "lookalike" components drift
within one release. Query keys include the scope (`['document', id, scopeKey]`) so the two surfaces
never share cache entries.

How to check: `grep -rnE "\bis(Demo|Admin|Public)\b" apps/*/src` trends to zero; an e2e DOM-snapshot
parity diff renders the same seeded entity on both surfaces and fails on unexpected differences.

## Quick audit

| Check | Command / test | Severity if failing |
|---|---|---|
| contracts has zero deps | `jq` on package.json | H |
| test-utils only in devDependencies | `jq` loop | H |
| core imports no runtime/Hono, reads no `env` | Biome override + grep test | H |
| client response types generated and diffed | `check:openapi` in `check` | H |
| wire types declared once | grep for redeclarations | M |
| new message fields optional, safe default | review `contracts` diff | M |
| Node scripts use runtime-neutral subpaths | grep scripts imports | M |
| one invalidation map | grep `invalidateQueries(` | M |
| REST/MCP read parity test exists | test file present, asserts success | M |
| no `isX` surface flags | grep | L |

For Hono, Workers RPC and binding APIs themselves, see the `cloudflare`, `workers-best-practices`
and `wrangler` skills.
