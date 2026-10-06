/**
 * Aggregate reporting and the finalize pipeline.
 *
 * Pass order is not arbitrary and mirrors what openwiki arrived at:
 *   fmt → mermaid → index → links
 * Front matter first because index generation reads `description` out of it; links last because
 * index generation creates links that then need validating.
 */

import { readFile, writeFile } from "node:fs/promises";
import { checkBudgets } from "./budget.js";
import { checkLinks, type LinkReport } from "./links.js";
import { validateMermaid, type MermaidReport } from "./mermaid.js";
import {
  deriveTrustTier,
  isStale,
  normalizeConcept,
  validateConcept,
  type OkfIssue,
  type TrustTier,
} from "./okf.js";
import { syncIndexes } from "./wiki.js";
import { walkWiki } from "./wiki.js";

export interface OkfReport {
  pages: number;
  issues: OkfIssue[];
  invalidCount: number;
  /** Pages whose front matter this tool synthesized and which still need grounding. */
  needsGrounding: string[];
  trust: Record<TrustTier, number>;
  stale: string[];
  /** Distinct `type` values. One value across the whole wiki means the field carries no signal. */
  distinctTypes: string[];
}

export interface WikiReport {
  wiki: string;
  okf: OkfReport;
  links: LinkReport;
  mermaid: MermaidReport;
  /** Aggregate: 0 clean, 2 findings. */
  findings: number;
}

export interface FmtResult {
  changed: string[];
  unchanged: number;
  issues: OkfIssue[];
}

export async function formatWiki(
  wikiRoot: string,
  options: { check?: boolean; defaultType?: string } = {},
): Promise<FmtResult> {
  const { check = false, defaultType } = options;
  const tree = await walkWiki(wikiRoot);
  const changed: string[] = [];
  const issues: OkfIssue[] = [];
  let unchanged = 0;

  for (const page of tree.pages) {
    const result = normalizeConcept(page.content, { file: page.rel, defaultType });
    issues.push(...result.issues);
    if (!result.changed) {
      unchanged += 1;
      continue;
    }
    changed.push(page.rel);
    if (!check) await writeFile(page.abs, result.content, "utf8");
  }
  return { changed, unchanged, issues };
}

export async function reportOkf(
  wikiRoot: string,
  options: { requireRouting?: boolean } = {},
): Promise<OkfReport> {
  const tree = await walkWiki(wikiRoot);
  const issues: OkfIssue[] = [];
  const needsGrounding: string[] = [];
  const stale: string[] = [];
  const trust: Record<TrustTier, number> = {
    unverified: 0,
    "machine-confirmed": 0,
    "human-reviewed": 0,
  };
  const types = new Set<string>();

  for (const page of tree.pages) {
    const pageIssues = validateConcept(page.content, {
      file: page.rel,
      requireRouting: options.requireRouting ?? false,
    });
    issues.push(...pageIssues);
    issues.push(...checkBudgets(page.rel, page.content, page.frontmatter));
    if (page.type) types.add(page.type);
    trust[deriveTrustTier(page.frontmatter.verified)] += 1;
    if (isStale(page.frontmatter.stale_after)) stale.push(page.rel);
    if (page.frontmatter.opencodewiki_generated === true) needsGrounding.push(page.rel);
  }

  return {
    pages: tree.pages.length,
    issues,
    invalidCount: issues.filter((issue) => issue.severity === "error").length,
    needsGrounding,
    trust,
    stale,
    distinctTypes: [...types].sort(),
  };
}

export async function buildReport(
  wikiRoot: string,
  options: { repoRoot?: string; requireRouting?: boolean } = {},
): Promise<WikiReport> {
  const okf = await reportOkf(wikiRoot, { requireRouting: options.requireRouting ?? false });
  const links = await checkLinks(wikiRoot, { repoRoot: options.repoRoot, stamp: false });
  const mermaid = await validateMermaid(wikiRoot, { degrade: false });

  const findings = okf.invalidCount + links.issues.length + mermaid.issues.length;
  return { wiki: wikiRoot, okf, links, mermaid, findings };
}

export interface FinalizeResult {
  formatted: string[];
  mermaid: MermaidReport;
  indexesWritten: string[];
  links: LinkReport;
  /** True when this pass changed nothing, which is what a second run must report. */
  idempotent: boolean;
}

export async function finalizeWiki(
  wikiRoot: string,
  options: { repoRoot?: string; defaultType?: string } = {},
): Promise<FinalizeResult> {
  const fmt = await formatWiki(wikiRoot, { defaultType: options.defaultType });
  const mermaid = await validateMermaid(wikiRoot, { degrade: true });
  const indexes = await syncIndexes(wikiRoot);
  const links = await checkLinks(wikiRoot, { repoRoot: options.repoRoot, stamp: true });

  return {
    formatted: fmt.changed,
    mermaid,
    indexesWritten: indexes.written,
    links,
    idempotent:
      fmt.changed.length === 0 &&
      mermaid.degradedFiles.length === 0 &&
      indexes.written.length === 0 &&
      links.stampedFiles.length === 0,
  };
}

/** Checks that a path a caller intends to write stays inside the wiki. */
export async function guardPaths(
  wikiRoot: string,
  candidates: string[],
): Promise<{ allowed: string[]; blocked: string[] }> {
  const allowed: string[] = [];
  const blocked: string[] = [];
  const { resolve, relative, isAbsolute } = await import("node:path");
  for (const candidate of candidates) {
    const target = resolve(candidate);
    const rel = relative(resolve(wikiRoot), target);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) allowed.push(candidate);
    else blocked.push(candidate);
  }
  return { allowed, blocked };
}

export async function readIfExists(file: string): Promise<string | null> {
  return readFile(file, "utf8").catch(() => null);
}
