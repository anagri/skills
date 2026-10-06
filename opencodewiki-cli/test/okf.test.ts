import { describe, expect, it } from "vitest";
import {
  deriveTrustTier,
  isStale,
  joinFrontmatter,
  normalizeConcept,
  parseConcept,
  splitFrontmatter,
  validateConcept,
} from "../src/okf.js";

const page = (frontmatter: string, body = "# Title\n\nSome prose.\n"): string =>
  `---\n${frontmatter}\n---\n\n${body}`;

describe("splitFrontmatter", () => {
  it("separates front matter from body", () => {
    const result = splitFrontmatter(page("type: Reference"));
    expect(result.hasFrontmatter).toBe(true);
    expect(result.yaml).toBe("type: Reference");
    expect(result.body).toBe("# Title\n\nSome prose.\n");
  });

  it("treats an unterminated block as no front matter rather than throwing", () => {
    const result = splitFrontmatter("---\ntype: Reference\n\n# Title\n");
    expect(result.hasFrontmatter).toBe(false);
    expect(result.body).toContain("type: Reference");
  });

  it("remembers CRLF so writes do not silently convert the file", () => {
    expect(splitFrontmatter("---\r\ntype: X\r\n---\r\n\r\nbody\r\n").eol).toBe("\r\n");
    expect(splitFrontmatter(page("type: X")).eol).toBe("\n");
  });
});

describe("validateConcept", () => {
  it("accepts a document carrying only type, which the spec calls fully conformant", () => {
    const issues = validateConcept(page("type: Reference"));
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("reports a missing type as the one real conformance failure", () => {
    const issues = validateConcept(page("title: No type here"));
    expect(issues.map((issue) => issue.code)).toContain("missing_type");
  });

  it("never errors on unknown extra keys, which producers are allowed to add", () => {
    const issues = validateConcept(page("type: Reference\nsomething_bespoke: 42"));
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  it("rejects a status outside the lifecycle enum", () => {
    const issues = validateConcept(page("type: Reference\nstatus: retired"));
    expect(issues.map((issue) => issue.code)).toContain("invalid_status");
  });

  it("requires stale_after to be an absolute date, not a TTL", () => {
    const issues = validateConcept(page("type: Reference\nstale_after: 30d"));
    expect(issues.map((issue) => issue.code)).toContain("invalid_stale_after");
  });

  it("requires resource on every source entry", () => {
    const issues = validateConcept(page("type: Reference\nsources:\n  - title: no resource"));
    expect(issues.map((issue) => issue.code)).toContain("invalid_sources");
  });

  it("accepts a bare verified mapping, which consumers must treat as a one-element list", () => {
    const issues = validateConcept(
      page("type: Reference\nverified: { by: human:reviewer, at: 2026-08-14T00:00:00Z }"),
    );
    expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });
});

describe("deriveTrustTier", () => {
  it("is unverified with no verification recorded", () => {
    expect(deriveTrustTier(undefined)).toBe("unverified");
  });

  it("is machine-confirmed when only non-human actors verified", () => {
    expect(deriveTrustTier([{ by: "process:opencodewiki-qa", at: "2026-08-14T00:00:00Z" }])).toBe(
      "machine-confirmed",
    );
  });

  it("is human-reviewed as soon as any human actor appears", () => {
    expect(
      deriveTrustTier([{ by: "process:opencodewiki-qa" }, { by: "human:reviewer" }]),
    ).toBe("human-reviewed");
  });

  it("treats a bare mapping as a one-element list", () => {
    expect(deriveTrustTier({ by: "human:reviewer" })).toBe("human-reviewed");
  });
});

describe("isStale", () => {
  it("is stale once today reaches the date", () => {
    expect(isStale("2026-01-01", new Date("2026-08-14T00:00:00Z"))).toBe(true);
    expect(isStale("2027-01-01", new Date("2026-08-14T00:00:00Z"))).toBe(false);
  });

  it("is never stale without a date", () => {
    expect(isStale(undefined)).toBe(false);
  });
});

describe("normalizeConcept", () => {
  it("synthesizes front matter for a page that has none, keeping the body", () => {
    const result = normalizeConcept("# Search\n\nHow search works.\n", { file: "search.md" });
    expect(result.changed).toBe(true);
    expect(result.content).toContain("type: Reference");
    expect(result.content).toContain("title: Search");
    expect(result.content).toContain("opencodewiki_generated: true");
    expect(result.content).toContain("How search works.");
  });

  it("preserves unknown producer keys through a round trip", () => {
    const source = page("type: Reference\nopencodewiki:\n  symbols: [foo, bar]\nweird_key: keep me");
    const result = normalizeConcept(source, { file: "x.md" });
    expect(result.content).toContain("weird_key: keep me");
    expect(result.content).toContain("symbols:");
  });

  it("orders known keys canonically so output is stable", () => {
    const result = normalizeConcept(page("status: stable\ntitle: T\ntype: Reference"), {
      file: "x.md",
    });
    const yaml = splitFrontmatter(result.content).yaml;
    expect(yaml.indexOf("type:")).toBeLessThan(yaml.indexOf("title:"));
    expect(yaml.indexOf("title:")).toBeLessThan(yaml.indexOf("status:"));
  });

  it("is idempotent — normalizing twice changes nothing the second time", () => {
    const once = normalizeConcept(page("title: T\ntype: Reference"), { file: "x.md" });
    const twice = normalizeConcept(once.content, { file: "x.md" });
    expect(twice.content).toBe(once.content);
    expect(twice.changed).toBe(false);
  });

  it("clears the synthesized marker once the page has grounded metadata", () => {
    const source = page(
      "type: Concept\ntitle: Real title\ndescription: A real description.\nopencodewiki_generated: true",
    );
    const result = normalizeConcept(source, { file: "x.md" });
    expect(result.content).not.toContain("opencodewiki_generated");
  });

  it("keeps the marker while the page is still ungrounded", () => {
    const result = normalizeConcept(page("type: Reference\nopencodewiki_generated: true"), {
      file: "x.md",
    });
    expect(result.content).toContain("opencodewiki_generated");
  });
});

describe("parseConcept", () => {
  it("reports unparseable YAML instead of throwing", () => {
    const parsed = parseConcept("---\ntype: [unclosed\n---\n\nbody\n", "x.md");
    expect(parsed.doc).toBeNull();
    expect(parsed.issues.map((issue) => issue.code)).toContain("invalid_yaml");
  });

  it("rejects a non-mapping root", () => {
    const parsed = parseConcept("---\n- a\n- b\n---\n\nbody\n", "x.md");
    expect(parsed.issues.map((issue) => issue.code)).toContain("invalid_yaml_root");
  });
});

describe("joinFrontmatter", () => {
  it("round-trips back to the same shape", () => {
    const built = joinFrontmatter("type: Reference", "# Title\n", "\n");
    expect(built).toBe("---\ntype: Reference\n---\n\n# Title\n");
  });
});
