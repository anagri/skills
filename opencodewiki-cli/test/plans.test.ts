import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexPlans } from "../src/state.js";

/**
 * These run against a real git repository because the behaviour under test *is* git behaviour:
 * how a directory move is recorded, and what `--follow` can see through. A mocked git would only
 * prove the mock agrees with itself.
 */

let repo: string;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

/**
 * Bodies must be genuinely distinct. `git log --follow` re-derives renames from content
 * similarity, so near-identical fixture files get mis-paired and each plan ends up following
 * another plan's history — an artifact of toy fixtures that real plans, hundreds of distinct
 * lines each, never trigger.
 */
function commitPlan(dir: string, name: string, subject: string, alsoTouch: string[] = []): void {
  const body = Array.from({ length: 40 }, (_, line) => `${name} line ${line} ${subject}`).join("\n");
  writeFileSync(path.join(repo, dir, name), `# ${name}\n\n## Context\n\n${body}\n`);
  for (const extra of alsoTouch) {
    const target = path.join(repo, extra);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "// source\n");
  }
  git("add", "-A");
  git("commit", "-q", "-m", subject);
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "opencodewiki-plans-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");

  mkdirSync(path.join(repo, "docs", "claude-plans"), { recursive: true });

  // Each plan lands in its own commit, the way real authoring works.
  commitPlan("docs/claude-plans", "alpha.md", "feat(chat): message reactions", ["src/chat.ts"]);
  commitPlan("docs/claude-plans", "beta.md", "fix(search): empty query handling", ["src/search.ts"]);
  commitPlan("docs/claude-plans", "gamma.md", "docs: notes only");
  commitPlan("docs/claude-plans", "delta.md", "feat(chat): threads", ["src/threads.ts"]);
  commitPlan("docs/claude-plans", "epsilon.md", "perf(export): batch writes", ["src/export.ts"]);
  commitPlan("docs/claude-plans", "zeta.md", "feat(export): csv download", ["src/csv.ts"]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("indexPlans before any move", () => {
  it("reads the date, scope and change kind from each plan's own add-commit", async () => {
    const index = await indexPlans(repo, "docs/claude-plans");
    expect(index.planCount).toBe(6);
    expect(index.undated).toEqual([]);

    const scopes = new Set(index.plans.map((plan) => plan.scope));
    expect(scopes).toContain("chat");
    expect(scopes).toContain("search");
    expect(scopes).toContain("export");

    const alpha = index.plans.find((plan) => plan.file.endsWith("alpha.md"));
    expect(alpha?.changeKind).toBe("feat");
    expect(alpha?.subject).toBe("feat(chat): message reactions");
  });

  it("distinguishes a plan that shipped with source from a docs-only commit", async () => {
    const index = await indexPlans(repo, "docs/claude-plans");
    const alpha = index.plans.find((plan) => plan.file.endsWith("alpha.md"));
    const gamma = index.plans.find((plan) => plan.file.endsWith("gamma.md"));
    expect(alpha?.shippedWith).toBeGreaterThan(0);
    expect(gamma?.shippedWith).toBe(0);
  });

  it("orders plans oldest first, because later intent supersedes earlier intent", async () => {
    const index = await indexPlans(repo, "docs/claude-plans");
    const dates = index.plans.map((plan) => plan.addedAt ?? "");
    expect([...dates].sort()).toEqual(dates);
  });
});

describe("indexPlans after the plans directory is moved", () => {
  beforeAll(() => {
    // git records a directory move as delete+add, not a rename — which is exactly what makes this
    // dangerous: the naive lookup finds an add-commit for every file and looks successful.
    mkdirSync(path.join(repo, "plans"), { recursive: true });
    git("mv", ...["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].map((n) => `docs/claude-plans/${n}.md`), "plans");
    git("commit", "-q", "-m", "moving plan folder");
  });

  it("still attributes each plan to its original commit, not the move", async () => {
    const index = await indexPlans(repo, "plans");
    expect(index.planCount).toBe(6);

    const subjects = index.plans.map((plan) => plan.subject);
    expect(subjects).not.toContain("moving plan folder");
    expect(subjects).toContain("feat(chat): message reactions");
  });

  it("keeps distinct add-commits rather than collapsing onto the move commit", async () => {
    const index = await indexPlans(repo, "plans");
    // Asserting on distinct commits rather than timestamps: a fixture commits faster than the
    // one-second resolution of a git author date, so identical timestamps prove nothing either way.
    const commits = new Set(index.plans.map((plan) => plan.addedIn));
    expect(commits.size).toBe(6);

    const moveSha = git("rev-parse", "HEAD");
    expect([...commits]).not.toContain(moveSha);
  });

  it("keeps real scopes rather than collapsing to one unscoped bucket", async () => {
    const index = await indexPlans(repo, "plans");
    const scopes = new Set(index.plans.map((plan) => plan.scope));
    expect(scopes.size).toBeGreaterThan(1);
    expect(scopes).toContain("chat");
  });

  it("keeps the realisation signal varying, not uniform across every plan", async () => {
    const index = await indexPlans(repo, "plans");
    const values = new Set(index.plans.map((plan) => plan.shippedWith));
    // The regression gave every plan the same count, taken from the move commit.
    expect(values.size).toBeGreaterThan(1);
    expect(index.plans.find((plan) => plan.file.endsWith("gamma.md"))?.shippedWith).toBe(0);
  });
});
