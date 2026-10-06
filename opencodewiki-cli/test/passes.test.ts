import { describe, expect, it } from "vitest";
import { extractHeadings, headingSlug, maskNonProse, stripStamps } from "../src/links.js";
import { extractMermaidFences, heuristicError } from "../src/mermaid.js";
import { renderIndex } from "../src/wiki.js";

describe("headingSlug", () => {
  it("lowercases and hyphenates", () => {
    expect(headingSlug("Task Routing")).toBe("task-routing");
  });

  it("drops punctuation but keeps word characters", () => {
    expect(headingSlug("What's the `plan`?")).toBe("whats-the-plan");
  });

  it("keeps combining marks rather than stripping accents", () => {
    expect(headingSlug("Café Menu")).toBe("café-menu");
  });

  it("maps each whitespace character to its own hyphen, not one per run", () => {
    // GitHub does not collapse runs; getting this wrong yields anchors that resolve to nothing.
    expect(headingSlug("a  b")).toBe("a--b");
  });
});

describe("extractHeadings", () => {
  it("de-duplicates repeated headings the way GitHub does", () => {
    expect(extractHeadings("# Setup\n\n## Setup\n\n### Setup\n")).toEqual([
      "setup",
      "setup-1",
      "setup-2",
    ]);
  });

  it("ignores headings inside fenced code", () => {
    expect(extractHeadings("# Real\n\n```\n# Not a heading\n```\n")).toEqual(["real"]);
  });
});

describe("maskNonProse", () => {
  it("preserves length so match offsets stay valid", () => {
    const source = "text `code` more\n";
    expect(maskNonProse(source)).toHaveLength(source.length);
  });

  it("blanks inline code spans so documented link syntax is not treated as a link", () => {
    // The exact false positive found on a real wiki: a page describing a link format.
    const source = "embedded as `[@title](/kind/id)` links\n";
    expect(maskNonProse(source)).not.toContain("/kind/id");
  });

  it("blanks fenced code but keeps surrounding prose", () => {
    const masked = maskNonProse("before\n```\n[x](/y)\n```\nafter\n");
    expect(masked).toContain("before");
    expect(masked).toContain("after");
    expect(masked).not.toContain("/y");
  });

  it("blanks front matter", () => {
    expect(maskNonProse("---\ntype: Reference\n---\n\nbody\n")).not.toContain("Reference");
  });
});

describe("stripStamps", () => {
  it("removes a stamp so re-running does not accumulate them", () => {
    const stamped = "See [x](y) <!-- opencodewiki: broken internal link: y — gone -->\n";
    expect(stripStamps(stamped)).toBe("See [x](y)\n");
  });
});

describe("extractMermaidFences", () => {
  it("finds a mermaid fence", () => {
    const fences = extractMermaidFences("text\n\n```mermaid\ngraph TD\nA-->B\n```\n");
    expect(fences).toHaveLength(1);
    expect(fences[0]?.code).toBe("graph TD\nA-->B");
  });

  it("ignores a mermaid fence nested inside an untagged example block", () => {
    // Otherwise a page documenting how to write diagrams gets its examples validated as diagrams.
    const source = "````\n```mermaid\nnot real\n```\n````\n";
    expect(extractMermaidFences(source)).toHaveLength(0);
  });

  it("finds several fences in one page", () => {
    const source = "```mermaid\nA\n```\n\ntext\n\n```mermaid\nB\n```\n";
    expect(extractMermaidFences(source)).toHaveLength(2);
  });

  it("ignores non-mermaid fences", () => {
    expect(extractMermaidFences("```ts\nconst a = 1;\n```\n")).toHaveLength(0);
  });
});

describe("heuristicError", () => {
  it("passes a clean diagram", () => {
    expect(heuristicError("sequenceDiagram\n  A->>B: hello")).toBeNull();
  });

  it("flags an empty diagram", () => {
    expect(heuristicError("\n  \n")).toBe("empty diagram");
  });

  it("flags unescaped angle brackets in a label", () => {
    expect(heuristicError("flowchart TD\n  A[returns Promise<User>]")).toContain("angle bracket");
  });

  it("flags a reserved keyword used as a participant", () => {
    expect(heuristicError("sequenceDiagram\n  participant Note")).toContain("reserved");
  });
});

describe("renderIndex", () => {
  const files = [{ label: "Quickstart", href: "quickstart.md", description: "Entry point." }];
  const dirs = [{ label: "architecture", href: "architecture/" }];

  it("declares okf_version only at the bundle root", () => {
    expect(renderIndex(files, dirs, true)).toContain('okf_version: "0.2"');
  });

  it("gives a nested index no front matter at all", () => {
    const nested = renderIndex(files, [], false);
    expect(nested.startsWith("---")).toBe(false);
    expect(nested).not.toContain("okf_version");
  });

  it("lists files and directories in separate sections", () => {
    const rendered = renderIndex(files, dirs, false);
    expect(rendered).toContain("# Files");
    expect(rendered).toContain("# Directories");
    expect(rendered).toContain("- [Quickstart](quickstart.md) - Entry point.");
    expect(rendered).toContain("- [architecture](architecture/)");
  });

  it("omits the description separator when there is no description", () => {
    expect(renderIndex([{ label: "A", href: "a.md" }], [], false)).toContain("- [A](a.md)\n");
  });
});
