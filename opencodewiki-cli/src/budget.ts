/**
 * budget — per-chamber altitude rules, enforced mechanically.
 *
 * The two chambers fail in opposite directions, so they get opposite rules.
 *
 * An **architecture** chamber drifts toward being a code inventory: a table per handler, a symbol
 * catalogue in front matter, a source entry per file, a sequence diagram of one call path. Every one
 * of those is a fact a parser recomputes from HEAD, so writing it down buys nothing and guarantees
 * drift. But a page with no anchors at all is unactionable, so code references have a FLOOR here.
 *
 * A **functional** chamber drifts the other way: it slides into developer vocabulary and starts
 * describing the system instead of the person using it. A functional page explains what someone can
 * do and the value they get. It may point at an implementation, but only at app/package/folder
 * granularity and only a handful of times — so code references have a CEILING here, and file-level
 * or symbol-level pointers are rejected outright.
 *
 * These checks are deliberately NOT part of `validateConcept`, which is spec-faithful to OKF v0.2
 * and must stay that way. They are house rules layered on top, merged into the same report so the
 * authoring hook — which surfaces error-severity issues for the file just written — nags the writer
 * while the page is still cheap to fix.
 *
 * Chamber comes from the page's PATH, not its front matter: in practice almost no generated page
 * declared `opencodewiki.chamber`, so a front-matter-keyed rule would have silently passed on nearly
 * all of them.
 */

import type { OkfIssue } from "./okf.js";

export interface ChamberBudget {
  /** Body lines, excluding front matter — see the note on `maxLines` below. */
  maxLines: number;
  maxInvariants: number;
  maxDiagrams: number;
  /** Cap on `sources` entries of a code kind. Plans never count. */
  maxSources: number;
  /**
   * When true, inline prose references share the `maxSources` budget and must be module-granular
   * too. The functional chamber works this way: a reader should be pointed at roughly where
   * something lives a handful of times, not walked through it.
   */
  countProseTowardSources: boolean;
  /** Below this many inline references a page is too abstract to act on. 0 disables the floor. */
  minProseRefs: number;
  allowSymbols: boolean;
  /** Whether prose may name a function or member. Architecture may; functional may not. */
  allowFineGrainedProse: boolean;
  bannedDiagramKinds: string[];
}

/**
 * `maxLines` counts BODY lines, excluding front matter. Two reasons. Front-matter length is a
 * mechanical function of the reference count, which `maxCodeRefs` already caps — counting it twice
 * punishes a page for citing its evidence. And `finalize` canonicalises front matter *after* the
 * page is written, so a total-line budget moves under the writer's feet: pages authored just under the
 * cap came back from normalize over it and failed a rule they had satisfied.
 */
export const ARCHITECTURE_BUDGET: ChamberBudget = {
  maxLines: 150,
  maxInvariants: 3,
  maxDiagrams: 1,
  maxSources: 10,
  countProseTowardSources: false,
  minProseRefs: 8,
  allowSymbols: false,
  allowFineGrainedProse: true,
  bannedDiagramKinds: ["sequenceDiagram"],
};

/**
 * The functional chamber describes the product, not the system. It has no code-reference floor —
 * a page that never mentions an implementation is perfectly good functional writing — and a hard
 * ceiling of five, at app/package/folder granularity, so a reader is pointed at roughly where
 * something lives without the page turning into developer documentation.
 */
export const FUNCTIONAL_BUDGET: ChamberBudget = {
  maxLines: 150,
  maxInvariants: 3,
  maxDiagrams: 1,
  maxSources: 5,
  countProseTowardSources: true,
  minProseRefs: 0,
  allowSymbols: false,
  allowFineGrainedProse: false,
  bannedDiagramKinds: [],
};

const BUDGETS: Record<string, ChamberBudget> = {
  architecture: ARCHITECTURE_BUDGET,
  functional: FUNCTIONAL_BUDGET,
};

/**
 * The decision log is the one page whose content is entirely non-derivable — a rejected alternative
 * exists nowhere in the tree, because an abandoned attempt and a deliberate rejection are
 * byte-identical there. Capping it to satisfy a rule aimed at code inventory would destroy the most
 * valuable material in the chamber to protect against the least valuable, so it gets its own budget.
 */
const PER_PAGE_LINE_OVERRIDES: Record<string, number> = {
  "architecture/decisions.md": 250,
};

/** An individual source file. A module-level reference ends in `/`; a manifest is its own boundary. */
const SOURCE_FILE_REF = /\.(ts|tsx|js|jsx|mjs|cjs|sql|py|go|rs|astro|css|vue|rb|java|kt|swift)$/i;

/**
 * Anything ending in a recognised extension is a FILE, not a member access — `package.json` and
 * `wrangler.jsonc` are root artifacts the contract explicitly permits, and must not be mistaken for
 * `Storage.search`. Checked before the symbol pattern for exactly that reason.
 */
const ANY_FILE_REF = /\.[A-Za-z0-9]{1,6}$/;
const MANIFEST_EXT = /\.(json|jsonc|ya?ml|toml|lock|md|txt|sh)$/i;

/** A reference at function or member granularity — `doThing()`, `Storage.search`, `mod::fn`. */
const SYMBOL_REF = /(?:\(\)$|^[A-Za-z_$][\w$]*(?:\.|::)[\w$]+$)/;

function isSourceFile(ref: string): boolean {
  return SOURCE_FILE_REF.test(ref);
}

function isSymbol(ref: string): boolean {
  if (ANY_FILE_REF.test(ref) && MANIFEST_EXT.test(ref)) return false;
  return SYMBOL_REF.test(ref);
}

/**
 * A backticked token that names code rather than a user-visible thing. Deliberately conservative:
 * it must look like a path with a directory segment, or an identifier with call parens, or a
 * dotted/`::`-joined member. A bare word in backticks (`sync`, `refresh`) is a product term, not a
 * symbol, and must not trip this.
 */
const CODE_TOKEN = /^(?:[\w.@-]+\/[\w./@-]+|[A-Za-z_$][\w$]*\(\)|[A-Za-z_$][\w$]*(?:\.|::)[\w$]+)$/;

export function chamberOf(rel: string): string | null {
  const head = rel.split("/")[0] ?? "";
  return head === "architecture" || head === "functional" ? head : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * House-rule checks for one page. Returns `OkfIssue`-shaped findings so they merge into the existing
 * report and reach the authoring hook without a second channel.
 */
export function checkBudgets(
  rel: string,
  content: string,
  frontmatter: Record<string, unknown>,
): OkfIssue[] {
  const chamber = chamberOf(rel);
  if (chamber === null) return [];
  const budget = BUDGETS[chamber];
  if (budget === undefined) return [];

  const issues: OkfIssue[] = [];
  const at = (message: string, field?: string): OkfIssue => ({
    code: "budget_exceeded",
    field,
    message,
    severity: "error",
    file: rel,
  });

  const fmMatch = /^---\n[\s\S]*?\n---\n/.exec(content);
  const body = content.slice(fmMatch?.[0]?.length ?? 0);

  const lineCap = PER_PAGE_LINE_OVERRIDES[rel] ?? budget.maxLines;
  const lines = body.split("\n").length;
  if (lines > lineCap) {
    issues.push(
      at(
        `${lines} lines of prose exceeds the ${lineCap}-line ${chamber} budget (front matter is not counted). Cut the enumerations rather than requesting an exemption.`,
      ),
    );
  }

  // Plans record intent, not implementation, so they never spend the reference budget.
  const sources = Array.isArray(frontmatter.sources) ? frontmatter.sources : [];
  const codeSources = sources
    .filter((entry) => asRecord(entry).kind !== "plan")
    .map((entry) => asRecord(entry).resource)
    .filter((resource): resource is string => typeof resource === "string");

  const proseRefs = [...body.matchAll(/`([^`\n]+)`/g)]
    .map((match) => match[1] ?? "")
    .filter((token) => CODE_TOKEN.test(token));

  // `sources` must always be module-granular: a page's evidence trail is what a regeneration
  // follows, and a file path there rots on the next move.
  const fineSources = codeSources.filter((ref) => isSourceFile(ref) || isSymbol(ref));
  if (fineSources.length > 0) {
    issues.push(
      at(
        `sources must be module-granular on a ${chamber} page; ${fineSources.length} name an individual file or function (e.g. ${fineSources[0]}). Point at the app, package or folder instead.`,
        "sources",
      ),
    );
  }

  // Prose granularity is chamber-specific. Architecture may name a load-bearing symbol; a functional
  // page may not, because a function name means nothing to someone describing what a person can do.
  if (!budget.allowFineGrainedProse) {
    const fineProse = proseRefs.filter((ref) => isSourceFile(ref) || isSymbol(ref));
    if (fineProse.length > 0) {
      issues.push(
        at(
          `a ${chamber} page must not name an individual file or function; ${fineProse.length} found (e.g. ${fineProse[0]}). Point at the app, package or folder instead.`,
        ),
      );
    }
  }

  const counted = budget.countProseTowardSources
    ? new Set([...codeSources, ...proseRefs].map((ref) => ref.replace(/\/$/, "")))
    : new Set(codeSources.map((ref) => ref.replace(/\/$/, "")));
  if (counted.size > budget.maxSources) {
    const scope = budget.countProseTowardSources
      ? "code references (front matter and prose counted together; plan sources are exempt)"
      : "sources";
    issues.push(
      at(
        `${counted.size} ${scope} exceeds the cap of ${budget.maxSources} for a ${chamber} page. Keep the few a reader would actually follow.`,
        "sources",
      ),
    );
  }

  const distinctProse = new Set(proseRefs.map((ref) => ref.replace(/\/$/, "")));
  if (budget.minProseRefs > 0 && distinctProse.size < budget.minProseRefs) {
    issues.push({
      code: "budget_thin",
      message: `only ${distinctProse.size} inline code references; an ${chamber} page needs at least ${budget.minProseRefs} anchors to be actionable. Naming a module is not the same as enumerating it.`,
      severity: "warning",
      file: rel,
    });
  }

  const producer = asRecord(frontmatter.opencodewiki);
  if (!budget.allowSymbols && producer.symbols !== undefined) {
    issues.push(
      at(
        `opencodewiki.symbols must be absent on a ${chamber} page — a symbol catalogue is what a code-graph tool answers live.`,
        "opencodewiki.symbols",
      ),
    );
  }

  const invariants = Array.isArray(producer.invariants) ? producer.invariants : [];
  if (invariants.length > budget.maxInvariants) {
    issues.push(
      at(
        `${invariants.length} invariants exceeds the cap of ${budget.maxInvariants}.`,
        "opencodewiki.invariants",
      ),
    );
  }

  const fences = [...content.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  if (fences.length > budget.maxDiagrams) {
    issues.push(at(`${fences.length} diagrams exceeds the cap of ${budget.maxDiagrams} per ${chamber} page.`));
  }
  for (const banned of budget.bannedDiagramKinds) {
    if (fences.some((fence) => fence.trimStart().startsWith(banned))) {
      issues.push(
        at(
          `${banned} is banned in the ${chamber} chamber: its participants are functions and calls, which a graph tool traces live and correctly. Use a structural diagram whose every label names something that exists when no code is running.`,
        ),
      );
    }
  }

  // A fenced code block is implementation by definition, and has no place in a product description.
  if (chamber === "functional") {
    const fenceLangs = [...body.matchAll(/^```([a-z]*)\s*$/gm)]
      .map((match) => match[1] ?? "")
      .filter((_, index) => index % 2 === 0);
    if (fenceLangs.some((lang) => lang !== "mermaid")) {
      issues.push(
        at(
          "a functional page must not contain a code block. Describe what a person can do and the value they get; the implementation belongs to the architecture chamber and the code itself.",
        ),
      );
    }
  }

  return issues;
}
