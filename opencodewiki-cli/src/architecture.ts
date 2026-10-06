/**
 * architecture — a deterministic topology fact-sheet for the repository being documented.
 *
 * The wiki must not store facts a parser can recompute from HEAD. This module is the parser: it
 * reads the workspace layout, the internal dependency edges, and whatever a stack adapter can learn
 * from deployment manifests, and hands the result to the wiki generator as ground truth.
 *
 * It deliberately stops short of naming things. It can see that three workers share a prefix and a
 * binding shape; it cannot know that cluster is called "queue consumer", that one member is the one
 * to copy, or that a prefix with a single member is a convention rather than a coincidence. Those
 * are judgements, and they belong to the model that reads this file — which is why candidate kinds
 * carry `n` and `confidence` instead of a verdict.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { detectCloudflare } from "./stacks/cloudflare.js";

export const TOPOLOGY_FORMAT_VERSION = 1;

export interface WorkspaceMember {
  /** Repo-relative, POSIX separators — `apps/web`. */
  path: string;
  /** Declared package name, or the directory basename when no manifest names it. */
  name: string;
  /** Top-level directory the member sits under — `apps`, `packages`. */
  group: string;
}

export interface DependencyEdge {
  from: string;
  to: string;
  /** True when the target is another workspace member rather than a registry package. */
  internal: boolean;
}

export interface CandidateKind {
  id: string;
  members: string[];
  n: number;
  /** Why these members were grouped — the evidence, not a conclusion. */
  signals: string[];
  confidence: "high" | "medium" | "low";
}

export interface TopologyIssue {
  path?: string;
  message: string;
  severity: "error" | "warning";
}

export interface TopologyReport {
  formatVersion: number;
  workspace: { tool: string; members: WorkspaceMember[] };
  dependencyEdges: DependencyEdge[];
  stacks: Record<string, unknown>;
  candidateKinds: CandidateKind[];
  issues: TopologyIssue[];
}

/** A stack adapter turns deployment manifests into facts. Registered by name so more can be added. */
export interface StackAdapter {
  name: string;
  detect(repoRoot: string, members: WorkspaceMember[]): Promise<StackResult | null>;
}

export interface StackResult {
  facts: unknown;
  /** Per-member capability tags the clusterer uses as grouping evidence. */
  capabilities: Map<string, string[]>;
  issues: TopologyIssue[];
}

const ADAPTERS: StackAdapter[] = [{ name: "cloudflare", detect: detectCloudflare }];

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  const raw = await readFile(file, "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Expand a workspace glob. Supports the forms real manifests use — `apps/*`, `packages/**`, and a
 * leading `!` exclusion — and nothing more. A general glob engine would be a dependency we do not
 * need for four patterns.
 */
async function expandGlob(repoRoot: string, pattern: string): Promise<string[]> {
  const segments = pattern.split("/").filter((segment) => segment.length > 0);
  let frontier = [""];

  for (const segment of segments) {
    const next: string[] = [];
    for (const base of frontier) {
      const abs = path.join(repoRoot, base);
      if (segment === "*" || segment === "**") {
        const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") continue;
          const rel = base === "" ? entry.name : `${base}/${entry.name}`;
          next.push(rel);
          if (segment === "**") next.push(...(await expandGlob(repoRoot, `${rel}/**`)));
        }
        continue;
      }
      const rel = base === "" ? segment : `${base}/${segment}`;
      const info = await stat(path.join(repoRoot, rel)).catch(() => null);
      if (info?.isDirectory()) next.push(rel);
    }
    frontier = next;
  }

  return frontier.filter((entry) => entry.length > 0);
}

async function discoverMembers(
  repoRoot: string,
): Promise<{ tool: string; members: WorkspaceMember[]; issues: TopologyIssue[] }> {
  const issues: TopologyIssue[] = [];
  let tool = "none";
  const patterns: string[] = [];

  const pnpmRaw = await readFile(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8").catch(() => null);
  if (pnpmRaw !== null) {
    tool = "pnpm";
    try {
      const parsed: unknown = parseYaml(pnpmRaw);
      if (parsed !== null && typeof parsed === "object") {
        patterns.push(...asStringArray((parsed as Record<string, unknown>).packages));
      }
    } catch {
      issues.push({ path: "pnpm-workspace.yaml", message: "unparsable YAML", severity: "warning" });
    }
  }

  if (patterns.length === 0) {
    const rootPkg = await readJson(path.join(repoRoot, "package.json"));
    const workspaces = rootPkg?.workspaces;
    const list = Array.isArray(workspaces)
      ? asStringArray(workspaces)
      : asStringArray((workspaces as Record<string, unknown> | undefined)?.packages);
    if (list.length > 0) {
      if (tool === "none") tool = "npm";
      patterns.push(...list);
    }
  }

  if (patterns.length === 0) {
    const cargo = await readFile(path.join(repoRoot, "Cargo.toml"), "utf8").catch(() => null);
    if (cargo !== null && /^\s*\[workspace\]/m.test(cargo)) {
      tool = "cargo";
      const block = /members\s*=\s*\[([^\]]*)\]/m.exec(cargo);
      for (const match of block?.[1]?.matchAll(/"([^"]+)"/g) ?? []) {
        if (match[1] !== undefined) patterns.push(match[1]);
      }
    }
  }

  if (patterns.length === 0) {
    const goWork = await readFile(path.join(repoRoot, "go.work"), "utf8").catch(() => null);
    if (goWork !== null) {
      tool = "go";
      for (const match of goWork.matchAll(/^\s*(?:use\s+)?\.?\/?(\S+)/gm)) {
        const candidate = match[1];
        if (candidate !== undefined && !candidate.startsWith("go ") && candidate !== "use" && candidate !== "(") {
          patterns.push(candidate);
        }
      }
    }
  }

  const includes = patterns.filter((pattern) => !pattern.startsWith("!"));
  const excludes = new Set<string>();
  for (const pattern of patterns.filter((entry) => entry.startsWith("!"))) {
    for (const dir of await expandGlob(repoRoot, pattern.slice(1))) excludes.add(dir);
  }

  const seen = new Set<string>();
  const members: WorkspaceMember[] = [];
  for (const pattern of includes) {
    for (const dir of await expandGlob(repoRoot, pattern)) {
      if (seen.has(dir) || excludes.has(dir)) continue;
      seen.add(dir);
      const pkg = await readJson(path.join(repoRoot, dir, "package.json"));
      const declared = pkg?.name;
      members.push({
        path: dir,
        name: typeof declared === "string" ? declared : path.basename(dir),
        group: dir.includes("/") ? (dir.split("/")[0] ?? "") : "",
      });
    }
  }

  members.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { tool, members, issues };
}

async function dependencyEdges(repoRoot: string, members: WorkspaceMember[]): Promise<DependencyEdge[]> {
  const byName = new Map(members.map((member) => [member.name, member.path]));
  const edges: DependencyEdge[] = [];

  for (const member of members) {
    const pkg = await readJson(path.join(repoRoot, member.path, "package.json"));
    if (pkg === null) continue;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const block = pkg[field];
      if (block === null || typeof block !== "object") continue;
      for (const dep of Object.keys(block as Record<string, unknown>)) {
        const target = byName.get(dep);
        // Registry packages are the graph tool's business; only internal edges shape the wiki.
        if (target !== undefined) edges.push({ from: member.path, to: target, internal: true });
      }
    }
  }

  return edges;
}

function confidenceFor(n: number): CandidateKind["confidence"] {
  return n >= 3 ? "high" : n === 2 ? "medium" : "low";
}

/**
 * Propose groupings, never decide them. Two independent signals — a shared name prefix and a shared
 * capability set — are emitted separately even when they cover the same members, because agreement
 * between them is itself evidence and the model should be able to see it.
 */
function proposeKinds(members: WorkspaceMember[], capabilities: Map<string, string[]>): CandidateKind[] {
  const candidates = new Map<string, CandidateKind>();

  const add = (id: string, memberPaths: string[], signals: string[]): void => {
    const key = memberPaths.slice().sort().join("|");
    const existing = candidates.get(key);
    if (existing !== undefined) {
      for (const signal of signals) if (!existing.signals.includes(signal)) existing.signals.push(signal);
      return;
    }
    candidates.set(key, {
      id,
      members: memberPaths,
      n: memberPaths.length,
      signals,
      confidence: confidenceFor(memberPaths.length),
    });
  };

  const byPrefix = new Map<string, string[]>();
  const byCapability = new Map<string, string[]>();

  for (const member of members) {
    const base = path.basename(member.path);
    const head = base.includes("-") ? base.slice(0, base.indexOf("-")) : null;
    if (head !== null) {
      const key = `${member.group}/${head}`;
      byPrefix.set(key, [...(byPrefix.get(key) ?? []), member.path]);
    }
    const caps = (capabilities.get(member.path) ?? []).slice().sort();
    const key = `${member.group}/${caps.length > 0 ? caps.join("+") : "no-manifest"}`;
    byCapability.set(key, [...(byCapability.get(key) ?? []), member.path]);
  }

  for (const [key, paths] of byPrefix) {
    const head = key.slice(key.indexOf("/") + 1);
    // A one-member prefix is only worth proposing when the prefix is terse enough to look deliberate.
    if (paths.length < 2 && head.length > 2) continue;
    add(`${key}-*`, paths, [`name prefix "${head}-"`]);
  }

  for (const [key, paths] of byCapability) {
    const caps = key.slice(key.indexOf("/") + 1);
    if (caps === "no-manifest") continue;
    add(key, paths, [`capabilities: ${caps.split("+").join(", ")}`]);
  }

  return [...candidates.values()].sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : 1));
}

export async function detectTopology(
  repoRoot: string,
  options: { stacks?: string[] } = {},
): Promise<TopologyReport> {
  const { tool, members, issues } = await discoverMembers(repoRoot);
  const edges = await dependencyEdges(repoRoot, members);

  const stacks: Record<string, unknown> = {};
  const capabilities = new Map<string, string[]>();
  const wanted = options.stacks;

  for (const adapter of ADAPTERS) {
    if (wanted !== undefined && !wanted.includes(adapter.name)) continue;
    const result = await adapter.detect(repoRoot, members).catch(() => null);
    if (result === null) continue;
    stacks[adapter.name] = result.facts;
    for (const [member, caps] of result.capabilities) {
      capabilities.set(member, [...(capabilities.get(member) ?? []), ...caps]);
    }
    issues.push(...result.issues);
  }

  return {
    formatVersion: TOPOLOGY_FORMAT_VERSION,
    workspace: { tool, members },
    dependencyEdges: edges,
    stacks,
    candidateKinds: proposeKinds(members, capabilities),
    issues,
  };
}
