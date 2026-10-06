import { describe, expect, it } from "vitest";
import { ARCHITECTURE_BUDGET, FUNCTIONAL_BUDGET, chamberOf, checkBudgets } from "../src/budget.js";

/** Eight module-granular anchors: enough to clear the architecture floor, under its ceiling. */
const ANCHORS = Array.from({ length: 8 }, (_, i) => `\`apps/thing-${i}/\``).join(" ");

function page(body: string, lines = 20, anchors = ANCHORS): string {
  const filler = Array.from({ length: Math.max(0, lines) }, (_, i) => `line ${i}`).join("\n");
  // Front matter is deliberately included so the tests prove it is NOT counted toward the budget.
  return `---\ntype: Convention\ntitle: T\n---\n\n# Page\n\n${anchors}\n\n${body}\n\n${filler}\n`;
}

const messages = (issues: { message: string }[]): string => issues.map((i) => i.message).join(" | ");
const errors = (issues: { severity: string }[]) => issues.filter((i) => i.severity === "error");

describe("chamberOf", () => {
  it("derives the chamber from the path, not front matter", () => {
    expect(chamberOf("architecture/overview.md")).toBe("architecture");
    expect(chamberOf("functional/search.md")).toBe("functional");
    expect(chamberOf("quickstart.md")).toBeNull();
  });

  it("ignores pages outside both chambers", () => {
    expect(checkBudgets("quickstart.md", page("body", 900), {})).toEqual([]);
  });
});

describe("architecture chamber", () => {
  it("flags a page over the line budget, counting prose only", () => {
    expect(messages(checkBudgets("architecture/a.md", page("body", 400), {}))).toContain("150-line");
    expect(errors(checkBudgets("architecture/a.md", page("body", 20), {}))).toEqual([]);
  });

  it("gives the decision log a raised line budget", () => {
    const long = page("body", 200);
    expect(messages(checkBudgets("architecture/decisions.md", long, {}))).not.toContain("line");
    expect(messages(checkBudgets("architecture/other.md", long, {}))).toContain("150-line");
  });

  it("rejects file-level references and caps the total", () => {
    const fileLevel = checkBudgets("architecture/a.md", page("body"), {
      sources: [{ resource: "packages/core/src/index.ts", kind: "code" }],
    });
    expect(messages(fileLevel)).toContain("module-granular");

    const tooMany = checkBudgets("architecture/a.md", page("body"), {
      sources: Array.from({ length: 12 }, (_, i) => ({ resource: `packages/p${i}/`, kind: "code" })),
    });
    expect(messages(tooMany)).toContain("exceeds the cap of 10");

    // Architecture prose is NOT counted against the sources cap — naming load-bearing symbols is
    // part of its contract, and 8 anchors is its floor.
    const proseHeavy = checkBudgets("architecture/a.md", page("body"), {
      sources: [{ resource: "apps/one/", kind: "code" }],
    });
    expect(errors(proseHeavy)).toEqual([]);
  });

  it("warns when a page has too few anchors to act on", () => {
    const bare = checkBudgets("architecture/a.md", page("body", 20, "no anchors here"), {});
    const thin = bare.find((i) => i.code === "budget_thin");
    expect(thin?.severity).toBe("warning");
    expect(errors(bare)).toEqual([]);
  });

  it("bans a sequence diagram but allows a structural one", () => {
    const seq = page("```mermaid\nsequenceDiagram\n  A->>B: call\n```");
    expect(messages(checkBudgets("architecture/a.md", seq, {}))).toContain("sequenceDiagram");

    const er = page("```mermaid\nerDiagram\n  ORDER ||--o{ LINE_ITEM : has\n```");
    expect(messages(checkBudgets("architecture/a.md", er, {}))).not.toContain("sequenceDiagram");
  });

  it("passes a page that respects every budget", () => {
    const good = page("```mermaid\nerDiagram\n  A ||--o{ B : x\n```", 60);
    expect(
      checkBudgets("architecture/a.md", good, {
        sources: [{ resource: "plans/a.md", kind: "plan" }],
        opencodewiki: { invariants: ["only one writer touches the index"] },
      }),
    ).toEqual([]);
  });
});

describe("functional chamber", () => {
  it("caps code references at five, counting prose and front matter together", () => {
    // 8 prose anchors alone already breaks it — the architecture floor is the functional ceiling.
    expect(messages(checkBudgets("functional/a.md", page("body"), {}))).toContain("exceeds the cap of 5");

    const ok = page("body", 20, "`apps/web/` and `packages/core/`");
    expect(errors(checkBudgets("functional/a.md", ok, {}))).toEqual([]);
  });

  it("counts front matter and prose against one shared budget", () => {
    const twoInProse = page("body", 20, "`apps/one/` `apps/two/`");
    const withSources = checkBudgets("functional/a.md", twoInProse, {
      sources: Array.from({ length: 4 }, (_, i) => ({ resource: `packages/p${i}/`, kind: "code" })),
    });
    // 2 + 4 = 6 distinct, over 5 — neither half alone would have failed.
    expect(messages(withSources)).toContain("exceeds the cap of 5");
  });

  it("does not count plan sources toward the code budget", () => {
    const withPlans = checkBudgets("functional/a.md", page("body", 20, "`apps/web/`"), {
      sources: [
        { resource: "apps/web/", kind: "code" },
        ...Array.from({ length: 9 }, (_, i) => ({ resource: `plans/p${i}.md`, kind: "plan" })),
      ],
    });
    expect(errors(withPlans)).toEqual([]);
  });

  it("rejects a file-level or symbol-level reference", () => {
    const file = checkBudgets("functional/a.md", page("body", 20, "`apps/web/src/App.tsx`"), {});
    expect(messages(file)).toContain("individual file or function");

    const symbol = checkBudgets("functional/a.md", page("body", 20, "`readSearchResults()`"), {});
    expect(messages(symbol)).toContain("file or function");

    const member = checkBudgets("functional/a.md", page("body", 20, "`Storage.searchDocuments`"), {});
    expect(messages(member)).toContain("file or function");
  });

  it("does not treat an ordinary product term in backticks as a code reference", () => {
    // `sync` and `refresh` are words a user sees, not symbols.
    const terms = page("A user can `sync` or `refresh`.", 20, "no anchors");
    expect(checkBudgets("functional/a.md", terms, {})).toEqual([]);
  });

  it("has no code-reference floor — a page may name no implementation at all", () => {
    const pure = page("A person can search their orders.", 20, "no anchors at all");
    expect(checkBudgets("functional/a.md", pure, {})).toEqual([]);
    expect(FUNCTIONAL_BUDGET.minProseRefs).toBe(0);
  });

  it("rejects a code block outright", () => {
    const withCode = page("```ts\nconst x = 1;\n```", 20, "no anchors");
    expect(messages(checkBudgets("functional/a.md", withCode, {}))).toContain("must not contain a code block");

    const withMermaid = page("```mermaid\nflowchart TD\n  A-->B\n```", 20, "no anchors");
    expect(messages(checkBudgets("functional/a.md", withMermaid, {}))).not.toContain("code block");
  });

  it("requires symbols to be absent, like architecture", () => {
    const withSymbols = checkBudgets("functional/a.md", page("body", 20, "no anchors"), {
      opencodewiki: { symbols: ["someThing"] },
    });
    expect(withSymbols.some((i) => i.field === "opencodewiki.symbols")).toBe(true);
  });
});

describe("the budgets are exported so docs and prompts cannot drift from them", () => {
  it("architecture has a code-reference floor, functional has none", () => {
    expect(ARCHITECTURE_BUDGET.minProseRefs).toBe(8);
    expect(ARCHITECTURE_BUDGET.maxSources).toBe(10);
    expect(ARCHITECTURE_BUDGET.countProseTowardSources).toBe(false);
    expect(FUNCTIONAL_BUDGET.minProseRefs).toBe(0);
    expect(FUNCTIONAL_BUDGET.maxSources).toBe(5);
    expect(FUNCTIONAL_BUDGET.countProseTowardSources).toBe(true);
  });

  it("architecture may name a symbol in prose; functional may not", () => {
    expect(ARCHITECTURE_BUDGET.allowFineGrainedProse).toBe(true);
    expect(FUNCTIONAL_BUDGET.allowFineGrainedProse).toBe(false);
  });

  it("neither chamber allows a symbol catalogue in front matter", () => {
    for (const budget of [ARCHITECTURE_BUDGET, FUNCTIONAL_BUDGET]) {
      expect(budget.allowSymbols).toBe(false);
    }
  });
});
