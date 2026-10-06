import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectTopology } from "../src/architecture.js";

let repo: string;

function write(rel: string, body: string): void {
  const target = path.join(repo, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "opencodewiki-arch-"));

  write("pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n");
  write("package.json", JSON.stringify({ name: "root", private: true }));

  write("packages/core/package.json", JSON.stringify({ name: "@x/core" }));
  write("packages/contracts/package.json", JSON.stringify({ name: "@x/contracts" }));

  // The product worker: serves assets, hosts workflows, and is both producer and consumer.
  // Comments and a trailing comma are deliberate — real wrangler configs carry both.
  write("apps/web/package.json", JSON.stringify({ name: "web", dependencies: { "@x/core": "workspace:*" } }));
  write(
    "apps/web/wrangler.jsonc",
    `{
  // The product surface. Note the URL below: "//" inside a string must not be read as a comment.
  "name": "web",
  "docs": "https://example.com/guide",
  /* block comment */
  "env": {
    "dev": {
      "name": "dev-web",
      "assets": { "directory": "./dist" },
      "d1_databases": [{ "binding": "DB" }, { "binding": "SEARCH_DB" }],
      "workflows": [{ "class_name": "IngestionWorkflow" }],
      "queues": {
        "producers": [{ "queue": "dev-app-index" }, { "queue": "dev-app-jobs" }],
        "consumers": [{ "queue": "dev-app-jobs" }],
      },
    },
    "production": {
      "name": "prod-web",
      "assets": { "directory": "./dist" },
      "d1_databases": [{ "binding": "DB" }, { "binding": "SEARCH_DB" }],
      "workflows": [{ "class_name": "IngestionWorkflow" }],
      "queues": {
        "producers": [{ "queue": "prod-app-index" }, { "queue": "prod-app-jobs" }],
        "consumers": [{ "queue": "prod-app-jobs" }],
      },
    },
  },
}
`,
  );

  for (const name of ["indexer", "metrics"]) {
    write(`apps/q-${name}/package.json`, JSON.stringify({ name: `q-${name}` }));
    write(
      `apps/q-${name}/wrangler.jsonc`,
      `{
  "name": "q-${name}",
  "env": {
    "dev": { "name": "dev-q-${name}", "queues": { "consumers": [{ "queue": "dev-app-index" }] } },
    "production": { "name": "prod-q-${name}", "queues": { "consumers": [{ "queue": "prod-app-index" }] } }
  }
}
`,
    );
  }

  // One workflow host, deliberately the only member with this prefix.
  write("apps/w-reports/package.json", JSON.stringify({ name: "w-reports" }));
  write(
    "apps/w-reports/wrangler.jsonc",
    `{
  "name": "w-reports",
  "env": {
    "dev": {
      "name": "dev-w-reports",
      "triggers": { "crons": ["*/10 * * * *"] },
      "workflows": [{ "class_name": "ReportsWorkflow" }]
    }
  }
}
`,
  );
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("detectTopology", () => {
  it("discovers pnpm workspace members and internal dependency edges", async () => {
    const report = await detectTopology(repo);
    expect(report.workspace.tool).toBe("pnpm");
    expect(report.workspace.members.map((m) => m.path)).toEqual([
      "apps/q-indexer",
      "apps/q-metrics",
      "apps/w-reports",
      "apps/web",
      "packages/contracts",
      "packages/core",
    ]);
    // Only workspace-internal edges are recorded; registry deps belong to a graph tool.
    expect(report.dependencyEdges).toEqual([
      { from: "apps/web", to: "packages/core", internal: true },
    ]);
  });

  it("parses JSONC with comments and trailing commas, and does not eat // inside a string", async () => {
    const report = await detectTopology(repo);
    const cf = report.stacks.cloudflare as { deployables: { member: string; assets: boolean }[] };
    const web = cf.deployables.find((d) => d.member === "apps/web");
    expect(web?.assets).toBe(true);
    expect(report.issues.filter((i) => i.message.includes("unparsable"))).toEqual([]);
  });

  it("unions non-inheritable bindings across env blocks", async () => {
    const report = await detectTopology(repo);
    const cf = report.stacks.cloudflare as {
      deployables: { member: string; envs: string[]; bindings: { d1: string[] } }[];
    };
    const web = cf.deployables.find((d) => d.member === "apps/web");
    expect(web?.envs).toEqual(["dev", "production"]);
    expect(web?.bindings.d1).toEqual(["DB", "SEARCH_DB"]);
  });

  it("collapses env-prefixed queue names even when the env key and the prefix disagree", async () => {
    // env.production deploys prod-* resources. Stripping by env key alone would leave
    // `prod-app-index` uncollapsed and the queue graph would double.
    const report = await detectTopology(repo);
    const cf = report.stacks.cloudflare as {
      queues: { queue: string; producers: string[]; consumers: string[] }[];
    };
    expect(cf.queues.map((q) => q.queue).sort()).toEqual(["app-index", "app-jobs"]);

    const index = cf.queues.find((q) => q.queue === "app-index");
    expect(index?.producers).toEqual(["apps/web"]);
    expect(index?.consumers.sort()).toEqual(["apps/q-indexer", "apps/q-metrics"]);
  });

  it("records a deployable that both produces and consumes the same queue", async () => {
    const report = await detectTopology(repo);
    const cf = report.stacks.cloudflare as {
      queues: { queue: string; producers: string[]; consumers: string[] }[];
    };
    const jobs = cf.queues.find((q) => q.queue === "app-jobs");
    expect(jobs?.producers).toEqual(["apps/web"]);
    expect(jobs?.consumers).toEqual(["apps/web"]);
  });

  it("reports a single-member prefix at low confidence rather than asserting a rule", async () => {
    const report = await detectTopology(repo);
    const w = report.candidateKinds.find((k) => k.id === "apps/w-*");
    expect(w).toBeDefined();
    expect(w?.n).toBe(1);
    expect(w?.confidence).toBe("low");

    const q = report.candidateKinds.find((k) => k.id === "apps/q-*");
    expect(q?.n).toBe(2);
    expect(q?.confidence).toBe("medium");
  });

  it("proposes prefix and capability groupings as separate signals", async () => {
    const report = await detectTopology(repo);
    const capability = report.candidateKinds.find((k) => k.signals.some((s) => s.startsWith("capabilities:")));
    expect(capability).toBeDefined();
    // Agreement between two independent signals is itself evidence, so they are not merged away.
    const q = report.candidateKinds.find((k) => k.id === "apps/q-*");
    expect(q?.signals).toContain('name prefix "q-"');
  });

  it("returns generic-only output for a repo with no stack manifests", async () => {
    const plain = mkdtempSync(path.join(tmpdir(), "opencodewiki-plain-"));
    try {
      writeFileSync(path.join(plain, "pnpm-workspace.yaml"), "packages:\n  - libs/*\n");
      mkdirSync(path.join(plain, "libs", "one"), { recursive: true });
      writeFileSync(path.join(plain, "libs", "one", "package.json"), JSON.stringify({ name: "one" }));

      const report = await detectTopology(plain);
      expect(report.workspace.members.map((m) => m.path)).toEqual(["libs/one"]);
      expect(report.stacks.cloudflare).toBeUndefined();
      expect(report.issues).toEqual([]);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
