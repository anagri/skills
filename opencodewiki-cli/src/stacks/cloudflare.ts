/**
 * cloudflare — a stack adapter reading `wrangler.jsonc` into deployment facts.
 *
 * Two things about wrangler configs shape this file. Bindings inside an `env` block are
 * non-inheritable, so every environment repeats its own full set and the union across envs is the
 * only honest answer. And queue names are conventionally environment-prefixed (`dev-x`, `prod-x`),
 * so producer and consumer of the same logical queue do not match until the prefix is stripped —
 * without that, the queue graph comes out empty.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { StackResult, TopologyIssue, WorkspaceMember } from "../architecture.js";

export interface CloudflareDeployable {
  member: string;
  name?: string;
  envs: string[];
  bindings: { d1: string[]; r2: string[]; kv: string[]; services: string[] };
  queues: { produces: string[]; consumes: string[] };
  crons: string[];
  workflows: string[];
  assets: boolean;
}

export interface QueueEdge {
  queue: string;
  producers: string[];
  consumers: string[];
  deadLetter: boolean;
}

export interface CloudflareFacts {
  deployables: CloudflareDeployable[];
  queues: QueueEdge[];
  datastores: { binding: string; kind: string; boundBy: string[] }[];
}

/**
 * JSONC is JSON plus comments and trailing commas. A regex cannot do this safely — `//` inside a
 * string literal is a URL, not a comment — so scan character by character and track string state.
 */
function stripJsonc(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] ?? "";
    const next = raw[index + 1] ?? "";

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < raw.length && raw[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < raw.length && !(raw[index] === "*" && raw[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    out += char;
  }

  return out.replace(/,(\s*[}\]])/g, "$1");
}

function parseJsonc(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(stripJsonc(raw));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Strip a leading environment prefix so `dev-app-index` and `prod-app-index` collapse to one
 * logical queue. The env *key* is not enough — a block keyed `production` routinely deploys
 * resources prefixed `prod-` — so the prefix set is derived from each env's own `name` as well.
 * Only those observed prefixes are stripped; a queue starting with another word keeps its name.
 */
function logicalQueue(name: string, envNames: string[]): string {
  for (const env of envNames) {
    if (name.startsWith(`${env}-`)) return name.slice(env.length + 1);
  }
  return name;
}

function collect(scope: Record<string, unknown>, into: CloudflareDeployable, envNames: string[]): void {
  const push = (target: string[], values: string[]): void => {
    for (const value of values) if (!target.includes(value)) target.push(value);
  };

  push(
    into.bindings.d1,
    list(scope.d1_databases)
      .map((entry) => entry.binding)
      .filter((entry): entry is string => typeof entry === "string"),
  );
  push(
    into.bindings.r2,
    list(scope.r2_buckets)
      .map((entry) => entry.binding)
      .filter((entry): entry is string => typeof entry === "string"),
  );
  push(
    into.bindings.kv,
    list(scope.kv_namespaces)
      .map((entry) => entry.binding)
      .filter((entry): entry is string => typeof entry === "string"),
  );
  push(
    into.bindings.services,
    list(scope.services)
      .map((entry) => entry.binding)
      .filter((entry): entry is string => typeof entry === "string"),
  );
  push(
    into.workflows,
    list(scope.workflows)
      .map((entry) => entry.class_name)
      .filter((entry): entry is string => typeof entry === "string"),
  );
  push(into.crons, strings(record(scope.triggers).crons));

  const queues = record(scope.queues);
  push(
    into.queues.produces,
    list(queues.producers)
      .map((entry) => entry.queue)
      .filter((entry): entry is string => typeof entry === "string")
      .map((queue) => logicalQueue(queue, envNames)),
  );
  push(
    into.queues.consumes,
    list(queues.consumers)
      .map((entry) => entry.queue)
      .filter((entry): entry is string => typeof entry === "string")
      .map((queue) => logicalQueue(queue, envNames)),
  );

  if (scope.assets !== undefined) into.assets = true;
}

export async function detectCloudflare(
  repoRoot: string,
  members: WorkspaceMember[],
): Promise<StackResult | null> {
  const deployables: CloudflareDeployable[] = [];
  const issues: TopologyIssue[] = [];
  const capabilities = new Map<string, string[]>();

  for (const member of members) {
    const rel = `${member.path}/wrangler.jsonc`;
    let file = path.join(repoRoot, rel);
    if ((await stat(file).catch(() => null)) === null) {
      file = path.join(repoRoot, member.path, "wrangler.json");
      if ((await stat(file).catch(() => null)) === null) continue;
    }

    const raw = await readFile(file, "utf8").catch(() => null);
    if (raw === null) continue;
    const config = parseJsonc(raw);
    if (config === null) {
      issues.push({ path: rel, message: "unparsable wrangler config", severity: "warning" });
      continue;
    }

    const envs = record(config.env);
    const envNames = Object.keys(envs);

    // Resource prefixes come from the env keys *and* each env's deployed `name`, because the two
    // routinely disagree — `env.production` deploying `prod-<worker>` is the common case.
    const prefixes = new Set<string>(envNames);
    for (const envName of envNames) {
      const deployedName = record(envs[envName]).name;
      if (typeof deployedName === "string" && deployedName.includes("-")) {
        prefixes.add(deployedName.slice(0, deployedName.indexOf("-")));
      }
    }
    const prefixList = [...prefixes].sort((a, b) => b.length - a.length);

    const deployable: CloudflareDeployable = {
      member: member.path,
      name: typeof config.name === "string" ? config.name : undefined,
      envs: envNames,
      bindings: { d1: [], r2: [], kv: [], services: [] },
      queues: { produces: [], consumes: [] },
      crons: [],
      workflows: [],
      assets: false,
    };

    // Top level first, then every env — env blocks are non-inheritable, so the union is the truth.
    collect(config, deployable, prefixList);
    for (const envName of envNames) collect(record(envs[envName]), deployable, prefixList);

    const caps: string[] = [];
    if (deployable.queues.consumes.length > 0) caps.push("queue-consumer");
    if (deployable.queues.produces.length > 0) caps.push("queue-producer");
    if (deployable.workflows.length > 0) caps.push("workflow-host");
    if (deployable.crons.length > 0) caps.push("cron");
    if (deployable.assets) caps.push("serves-assets");
    capabilities.set(member.path, caps);

    deployables.push(deployable);
  }

  if (deployables.length === 0) return null;

  const queueIndex = new Map<string, QueueEdge>();
  for (const deployable of deployables) {
    for (const queue of deployable.queues.produces) {
      const edge = queueIndex.get(queue) ?? {
        queue,
        producers: [],
        consumers: [],
        deadLetter: queue.endsWith("-dlq"),
      };
      edge.producers.push(deployable.member);
      queueIndex.set(queue, edge);
    }
    for (const queue of deployable.queues.consumes) {
      const edge = queueIndex.get(queue) ?? {
        queue,
        producers: [],
        consumers: [],
        deadLetter: queue.endsWith("-dlq"),
      };
      edge.consumers.push(deployable.member);
      queueIndex.set(queue, edge);
    }
  }

  const datastoreIndex = new Map<string, { binding: string; kind: string; boundBy: string[] }>();
  for (const deployable of deployables) {
    for (const [kind, bindings] of [
      ["d1", deployable.bindings.d1],
      ["r2", deployable.bindings.r2],
      ["kv", deployable.bindings.kv],
    ] as const) {
      for (const binding of bindings) {
        const key = `${kind}:${binding}`;
        const entry = datastoreIndex.get(key) ?? { binding, kind, boundBy: [] };
        entry.boundBy.push(deployable.member);
        datastoreIndex.set(key, entry);
      }
    }
  }

  const facts: CloudflareFacts = {
    deployables,
    queues: [...queueIndex.values()].sort((a, b) => (a.queue < b.queue ? -1 : 1)),
    datastores: [...datastoreIndex.values()].sort((a, b) => (a.binding < b.binding ? -1 : 1)),
  };

  return { facts, capabilities, issues };
}
