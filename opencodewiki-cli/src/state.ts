/**
 * Run state, git delta, and plan discovery.
 *
 * State lives at `<wiki>/.state.json` and is committed with the wiki. Git is the source of truth
 * for "what changed": the recorded `gitHead` is the commit the wiki was last reconciled against,
 * so an update run is exactly `git log <gitHead>..HEAD` plus any plans touched in that range.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { walkWiki } from "./wiki.js";

const run = promisify(execFile);

export const STATE_FILE = ".state.json";
export const FORMAT_VERSION = 1;

export type RunCommand = "init" | "update" | "repair";
export type RunStatus = "running" | "complete" | "interrupted";

export interface RunState {
  formatVersion: number;
  okfVersion: string;
  command: RunCommand;
  status: RunStatus;
  /** Commit the wiki was last reconciled against. */
  gitHead: string | null;
  updatedAt: string;
  /** Phase the run reached, so a resumed run knows where to pick up. */
  phase?: string;
  model?: string;
  /** Hash of wiki content, used to decide whether anything actually changed. */
  contentHash?: string;
  /** Questions the wiki could not answer, fed back into the next update run. */
  coverageGaps?: { question: string; at: string }[];
}

export async function git(
  repoRoot: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run("git", ["-C", repoRoot, ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "" };
  }
}

export async function currentHead(repoRoot: string): Promise<string | null> {
  const result = await git(repoRoot, ["rev-parse", "HEAD"]);
  return result.ok ? result.stdout : null;
}

export async function isGitRepo(repoRoot: string): Promise<boolean> {
  const result = await git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout === "true";
}

export function statePath(wikiRoot: string): string {
  return path.join(wikiRoot, STATE_FILE);
}

export async function readState(wikiRoot: string): Promise<RunState | null> {
  const raw = await readFile(statePath(wikiRoot), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as RunState;
  } catch {
    return null;
  }
}

export async function writeState(wikiRoot: string, state: RunState): Promise<void> {
  await writeFile(statePath(wikiRoot), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * Content hash over the whole bundle.
 *
 * Path and byte length are folded in alongside content so a rename or truncation registers as a
 * change even when the surviving bytes are identical.
 */
export async function contentHash(wikiRoot: string): Promise<string> {
  const tree = await walkWiki(wikiRoot);
  const hash = createHash("sha256");
  for (const page of [...tree.pages].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    hash.update(`file:${page.rel}\0${Buffer.byteLength(page.content)}\0`);
    hash.update(page.content);
  }
  return hash.digest("hex");
}

export interface DeltaResult {
  /** No previous run recorded; the caller should init rather than update. */
  needsInit: boolean;
  /** Nothing to do: HEAD unchanged, tree clean, previous run completed. */
  noop: boolean;
  reason: string;
  fromHead: string | null;
  toHead: string | null;
  changedFiles: { status: string; file: string }[];
  changedPlans: string[];
  dirty: boolean;
}

/**
 * Decides whether an update run has anything to do.
 *
 * A previous run left `interrupted` always counts as work, regardless of git state — that is the
 * case where the wiki is known incomplete and the commit pointer cannot be trusted.
 */
export async function computeDelta(
  repoRoot: string,
  wikiRoot: string,
  plansDir: string | null,
): Promise<DeltaResult> {
  const state = await readState(wikiRoot);
  const head = await currentHead(repoRoot);

  const status = await git(repoRoot, ["status", "--porcelain"]);
  const dirty = status.ok && status.stdout.length > 0;

  if (state === null || state.gitHead === null) {
    return {
      needsInit: state === null,
      noop: false,
      reason: state === null ? "no recorded run" : "no recorded gitHead",
      fromHead: null,
      toHead: head,
      changedFiles: [],
      changedPlans: [],
      dirty,
    };
  }

  if (state.status === "interrupted") {
    return {
      needsInit: false,
      noop: false,
      reason: "previous run interrupted",
      fromHead: state.gitHead,
      toHead: head,
      changedFiles: await changedBetween(repoRoot, state.gitHead, head),
      changedPlans: [],
      dirty,
    };
  }

  const changedFiles = await changedBetween(repoRoot, state.gitHead, head);
  const changedPlans =
    plansDir === null
      ? []
      : changedFiles
          .map((entry) => entry.file)
          .filter((file) => file.startsWith(`${plansDir.replace(/^\.\//, "").replace(/\/$/, "")}/`));

  const noop = state.gitHead === head && !dirty && changedFiles.length === 0;
  return {
    needsInit: false,
    noop,
    reason: noop ? "HEAD unchanged and tree clean" : "source changes since last run",
    fromHead: state.gitHead,
    toHead: head,
    changedFiles,
    changedPlans,
    dirty,
  };
}

async function changedBetween(
  repoRoot: string,
  from: string,
  to: string | null,
): Promise<{ status: string; file: string }[]> {
  if (to === null || from === to) return [];
  const result = await git(repoRoot, ["diff", "--name-status", `${from}..${to}`]);
  if (!result.ok || result.stdout === "") return [];
  return result.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((parts): parts is [string, ...string[]] => parts.length >= 2)
    .map((parts) => ({ status: parts[0], file: parts[parts.length - 1] ?? "" }))
    .filter((entry) => entry.file !== "");
}

export interface PlanFile {
  /** Repo-relative path. */
  file: string;
  /** Author date of the commit that added the file — the plan's true position in the timeline. */
  addedAt: string | null;
  addedIn: string | null;
  /** Subject of that commit: a one-line statement of what actually shipped with the plan. */
  subject: string | null;
  /** Conventional-commit type, e.g. feat / fix / perf / refactor / docs. */
  changeKind: string | null;
  /** Conventional-commit scope, e.g. auth / search / billing. The authoritative feature grouping. */
  scope: string | null;
  /**
   * Source files changed in the same commit. A plan landing alongside real source changes is
   * evidence it was realised, which is otherwise indistinguishable from an abandoned attempt.
   */
  shippedWith: number;
  title: string | null;
  sections: string[];
  bytes: number;
}

export interface PlanCluster {
  /** Conventional-commit scope, or `unscoped`. */
  feature: string;
  plans: PlanFile[];
  latest: string;
}

export interface PlanBatch {
  id: string;
  files: string[];
  bytes: number;
  /** Inclusive date range covered, so a digest knows where it sits in the timeline. */
  from: string | null;
  to: string | null;
}

export interface PlanIndex {
  plansDir: string;
  planCount: number;
  /** Every plan, oldest first. */
  plans: PlanFile[];
  clusters: PlanCluster[];
  /**
   * Chronological batches, oldest first. Later batches describe more recent intent and supersede
   * earlier ones, so they must be digested in this order.
   */
  batches: PlanBatch[];
  /** Plans with no add-commit — untracked, or added outside this repository's history. */
  undated: string[];
}

/**
 * Reads `plansDirectory` from `.claude/settings.json`.
 *
 * Only repo-local directories are honoured. A plans store in the home directory belongs to the
 * developer across every project, so ingesting it would pull unrelated projects' design intent into
 * this repo's wiki.
 */
export async function resolvePlansDir(repoRoot: string): Promise<string | null> {
  for (const name of ["settings.local.json", "settings.json"]) {
    const raw = await readFile(path.join(repoRoot, ".claude", name), "utf8").catch(() => null);
    if (raw === null) continue;
    try {
      const parsed = JSON.parse(raw) as { plansDirectory?: unknown };
      const value = parsed.plansDirectory;
      if (typeof value !== "string" || value.trim() === "") continue;
      if (value.startsWith("~") || path.isAbsolute(value)) continue;
      const resolved = path.resolve(repoRoot, value);
      const rel = path.relative(repoRoot, resolved);
      if (rel.startsWith("..")) continue;
      const info = await stat(resolved).catch(() => null);
      if (info?.isDirectory()) return rel;
    } catch {
      continue;
    }
  }
  return null;
}


/** Roughly the number of plans one digest agent reads comfortably in a single context. */
const BATCH_TARGET = 20;

/** Source directories worth counting as evidence that a plan actually shipped. */
const NON_SOURCE = /^(?:docs?|\.github|\.claude)\//;

interface AddCommit {
  sha: string;
  date: string;
  subject: string;
}

/**
 * Reads, for every plan, the commit that introduced it.
 *
 * Plan filenames are auto-generated from the opening words of a prompt, so they carry no reliable
 * date or feature. Git does: the add-commit gives the true chronology, and where the project uses
 * conventional commits its scope names the feature far better than any filename heuristic could.
 */
/**
 * A commit adding at least this many plan files at once is treated as a bulk operation rather than
 * ordinary authoring, and every file in it is re-resolved through `--follow`.
 *
 * The motivating case: moving a plans directory is recorded by git as delete+add, not a rename, so
 * the bulk pass happily attributes every plan to the move commit. That is worse than finding
 * nothing — the run then reports "0 with no add-commit" and hands every downstream consumer one
 * date, one scope, and a uniform realisation signal, all of which look like real data.
 *
 * Re-resolving is safe even for a genuine bulk add: `--follow` simply returns the same commit.
 */
const BULK_ADD_THRESHOLD = 5;

/** How many `--follow` lookups to run at once. Each spawns a git process. */
const FOLLOW_CONCURRENCY = 8;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

async function readAddCommits(
  repoRoot: string,
  plansDir: string,
): Promise<{ byFile: Map<string, AddCommit>; filesByCommit: Map<string, string[]> }> {
  const byFile = new Map<string, AddCommit>();
  const log = await git(repoRoot, [
    "log",
    "--diff-filter=A",
    "--name-only",
    "--format=%x00%H%x09%aI%x09%s",
    "--",
    plansDir,
  ]);
  if (!log.ok) return { byFile, filesByCommit: new Map() };

  for (const block of log.stdout.split("\u0000")) {
    if (block.trim() === "") continue;
    const [header = "", ...rest] = block.split("\n");
    const [sha = "", date = "", ...subjectParts] = header.split("\t");
    if (sha === "") continue;
    const commit: AddCommit = { sha, date, subject: subjectParts.join("\t") };
    for (const line of rest) {
      const file = line.trim();
      // git log lists newest first, so only the first sighting is the true add.
      if (file.endsWith(".md") && !byFile.has(file)) byFile.set(file, commit);
    }
  }

  // Re-resolve anything attributed to a bulk commit, so a directory move does not flatten the
  // whole corpus onto one date.
  const perCommit = new Map<string, string[]>();
  for (const [file, commit] of byFile) {
    const list = perCommit.get(commit.sha) ?? [];
    list.push(file);
    perCommit.set(commit.sha, list);
  }
  const suspect = [...perCommit.values()]
    .filter((files) => files.length >= BULK_ADD_THRESHOLD)
    .flat();

  if (suspect.length > 0) {
    const resolved = await mapWithConcurrency(suspect, FOLLOW_CONCURRENCY, (file) =>
      followAddCommit(repoRoot, file).then((commit) => ({ file, commit })),
    );
    for (const { file, commit } of resolved) {
      if (commit !== null) byFile.set(file, commit);
    }
  }

  // Only now is the commit set final, so sibling lookup happens last.
  const filesByCommit = new Map<string, string[]>();
  const shas = [...new Set([...byFile.values()].map((commit) => commit.sha))];
  for (let at = 0; at < shas.length; at += 200) {
    const chunk = shas.slice(at, at + 200);
    const show = await git(repoRoot, [
      "show",
      "--no-walk",
      "--name-only",
      "--format=%x00%H",
      ...chunk,
    ]);
    if (!show.ok) continue;
    for (const block of show.stdout.split("\u0000")) {
      if (block.trim() === "") continue;
      const [sha = "", ...rest] = block.split("\n");
      if (sha.trim() === "") continue;
      filesByCommit.set(
        sha.trim(),
        rest.map((line) => line.trim()).filter((line) => line !== ""),
      );
    }
  }
  return { byFile, filesByCommit };
}

/** Per-file rename-aware lookup: the only way to see through a rename, and single-file only. */
async function followAddCommit(repoRoot: string, file: string): Promise<AddCommit | null> {
  const result = await git(repoRoot, [
    "log",
    "--follow",
    "--diff-filter=A",
    "-1",
    "--format=%H%x09%aI%x09%s",
    "--",
    file,
  ]);
  if (!result.ok || result.stdout === "") return null;
  const [sha = "", date = "", ...subject] = result.stdout.split("\t");
  if (sha === "") return null;
  return { sha, date, subject: subject.join("\t") };
}

const CONVENTIONAL_RE = /^(\w+)(?:\(([^)]+)\))?!?:\s*(.*)$/;

export async function indexPlans(repoRoot: string, plansDir: string): Promise<PlanIndex> {
  const abs = path.resolve(repoRoot, plansDir);
  const names = (await readdir(abs).catch(() => [])).filter((name) =>
    name.toLowerCase().endsWith(".md"),
  );
  const { byFile, filesByCommit } = await readAddCommits(repoRoot, plansDir);

  const plans: PlanFile[] = [];
  for (const name of names) {
    const rel = path.posix.join(plansDir, name);
    const content = await readFile(path.join(abs, name), "utf8").catch(() => "");
    // A file renamed after it was first committed is recorded under its original path, so the
    // bulk pass misses it. `--follow` works per-file only, which is why it is a fallback and not
    // the primary query.
    const commit = byFile.get(rel) ?? (await followAddCommit(repoRoot, rel));
    const conventional = commit ? CONVENTIONAL_RE.exec(commit.subject) : null;
    const siblings = commit ? (filesByCommit.get(commit.sha) ?? []) : [];

    plans.push({
      file: rel,
      addedAt: commit?.date ?? null,
      addedIn: commit?.sha ?? null,
      subject: commit?.subject ?? null,
      changeKind: conventional?.[1] ?? null,
      scope: conventional?.[2] ?? null,
      shippedWith: siblings.filter(
        (file) => !file.startsWith(`${plansDir}/`) && !NON_SOURCE.test(file),
      ).length,
      title: /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? null,
      sections: [...content.matchAll(/^##\s+(.+)$/gm)].map((match) => (match[1] ?? "").trim()),
      bytes: Buffer.byteLength(content),
    });
  }

  // Oldest first: the corpus is a timeline, and later intent supersedes earlier intent.
  plans.sort((a, b) => (a.addedAt ?? "").localeCompare(b.addedAt ?? "") || a.file.localeCompare(b.file));

  const byScope = new Map<string, PlanFile[]>();
  for (const plan of plans) {
    const key = plan.scope ?? "unscoped";
    const list = byScope.get(key) ?? [];
    list.push(plan);
    byScope.set(key, list);
  }

  const clusters: PlanCluster[] = [...byScope.entries()]
    .map(([feature, list]) => ({
      feature,
      plans: list,
      latest: list[list.length - 1]?.file ?? "",
    }))
    .sort((a, b) => b.plans.length - a.plans.length || a.feature.localeCompare(b.feature));

  return {
    plansDir,
    planCount: plans.length,
    plans,
    clusters,
    batches: buildBatches(plans),
    undated: plans.filter((plan) => plan.addedAt === null).map((plan) => plan.file),
  };
}

/**
 * Chops the chronological plan list into fixed-size batches, oldest first.
 *
 * Batches are strictly chronological rather than grouped by feature, because the ordering is the
 * point: a digest of batch N+1 describes intent that supersedes batch N. Grouping by feature would
 * scramble the timeline and lose which decision came last.
 */
function buildBatches(plans: PlanFile[]): PlanBatch[] {
  const batches: PlanBatch[] = [];
  for (let at = 0; at < plans.length; at += BATCH_TARGET) {
    const chunk = plans.slice(at, at + BATCH_TARGET);
    batches.push({
      id: `batch-${String(batches.length + 1).padStart(2, "0")}`,
      files: chunk.map((plan) => plan.file),
      bytes: chunk.reduce((sum, plan) => sum + plan.bytes, 0),
      from: chunk[0]?.addedAt ?? null,
      to: chunk[chunk.length - 1]?.addedAt ?? null,
    });
  }
  return batches;
}
