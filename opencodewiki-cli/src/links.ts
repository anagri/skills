/**
 * Internal link and heading-anchor validation.
 *
 * Broken links are stamped in place rather than failing the run. A wiki with one bad href is still
 * overwhelmingly useful, and the stamp is a machine-findable repair instruction a later pass acts
 * on — failing hard would throw away a whole run's work over a typo.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { splitFrontmatter } from "./okf.js";
import { walkWiki } from "./wiki.js";

export interface LinkIssue {
  file: string;
  href: string;
  reason: string;
}

export interface LinkReport {
  linksChecked: number;
  issues: LinkIssue[];
  stampedFiles: string[];
}

const STAMP_PREFIX = "opencodewiki: broken internal link";
const STAMP_RE = new RegExp(`[ \\t]*<!--\\s*${STAMP_PREFIX}[\\s\\S]*?-->`, "g");

/** Inline links only; reference definitions and images are out of scope. */
const LINK_RE = /(?<!!)\[(?:[^\]\\]|\\.)*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const CODE_FENCE_RE = /^([ \t]*)(`{3,}|~{3,})/;

function isExternal(href: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(href) ||
    href.startsWith("//") ||
    href.startsWith("mailto:") ||
    href.startsWith("#") === false && href.startsWith("/") === false && href.includes("://")
  );
}

/**
 * GitHub's heading slug algorithm.
 *
 * Two details are load-bearing and routinely got wrong: combining marks are kept (so accented
 * headings keep their accents rather than collapsing), and each whitespace character maps to its
 * own hyphen instead of runs collapsing to one. Getting either wrong produces anchors that look
 * right and resolve to nothing.
 */
export function headingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/gu, "-");
}

export function extractHeadings(markdown: string): string[] {
  const slugs: string[] = [];
  const counts = new Map<string, number>();
  let fence: string | null = null;

  for (const line of markdown.split("\n")) {
    const fenceMatch = CODE_FENCE_RE.exec(line);
    if (fenceMatch?.[2]) {
      const marker = fenceMatch[2];
      if (fence === null) fence = marker;
      else if (marker.startsWith(fence[0] ?? "") && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!heading?.[1]) continue;

    const base = headingSlug(heading[1].replace(/\s+#+\s*$/, ""));
    if (base === "") continue;
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    slugs.push(seen === 0 ? base : `${base}-${seen}`);
  }
  return slugs;
}

/**
 * Blanks out everything that isn't prose, preserving length so offsets stay valid against the
 * original text.
 *
 * Front matter, fenced code and inline code spans are all replaced with spaces. Inline spans matter
 * more than they look: a page documenting a link format writes `` `[@title](/kind/id)` `` in
 * backticks, and treating that as a real link would stamp a "broken link" correction into prose
 * that is perfectly correct.
 */
export function maskNonProse(content: string): string {
  const out = content.split("");
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i += 1) {
      if (out[i] !== "\n") out[i] = " ";
    }
  };

  const split = splitFrontmatter(content);
  if (split.hasFrontmatter) blank(0, content.length - split.body.length);

  // Fenced blocks, line by line.
  let offset = 0;
  let fence: string | null = null;
  for (const line of content.split("\n")) {
    const lineLength = line.length + 1;
    const fenceMatch = CODE_FENCE_RE.exec(line);
    if (fenceMatch?.[2]) {
      const marker = fenceMatch[2];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      blank(offset, offset + lineLength);
    } else if (fence !== null) {
      blank(offset, offset + lineLength);
    }
    offset += lineLength;
  }

  // Inline code spans: a run of N backticks closes on the next run of exactly N.
  const masked = out.join("");
  const spanRe = /(`+)(?:[^`]|(?!\1)`)*?\1/g;
  for (const match of masked.matchAll(spanRe)) {
    if (match.index === undefined) continue;
    blank(match.index, match.index + match[0].length);
  }

  return out.join("");
}

export function stripStamps(content: string): string {
  return content.replace(STAMP_RE, "");
}

function renderStamp(href: string, reason: string): string {
  const safe = reason.replace(/--+/gu, "-").replace(/>/g, "&gt;");
  return ` <!-- ${STAMP_PREFIX}: ${href} — ${safe} -->`;
}

export interface CheckLinksOptions {
  /** Repository root, so repo-relative hrefs like `../src/foo.ts` can be resolved too. */
  repoRoot?: string;
  stamp?: boolean;
}

/**
 * Resolves every relative link in the bundle, then optionally stamps the broken ones.
 *
 * Links pointing outside the wiki into repository source are validated as well — a page citing a
 * file that no longer exists is exactly the stale claim this tool exists to catch.
 */
export async function checkLinks(
  wikiRoot: string,
  options: CheckLinksOptions = {},
): Promise<LinkReport> {
  const { repoRoot, stamp = false } = options;
  const tree = await walkWiki(wikiRoot);
  const issues: LinkIssue[] = [];
  const stampedFiles: string[] = [];
  let linksChecked = 0;

  const headingsCache = new Map<string, string[]>();
  async function headingsOf(absPath: string): Promise<string[]> {
    const cached = headingsCache.get(absPath);
    if (cached) return cached;
    const text = await readFile(absPath, "utf8").catch(() => "");
    const slugs = extractHeadings(splitFrontmatter(text).body);
    headingsCache.set(absPath, slugs);
    return slugs;
  }

  for (const page of tree.pages) {
    const original = page.content;
    const cleaned = stripStamps(original);
    // Masked text is the same length as `cleaned`, so match indices are valid positions in it.
    const scannable = maskNonProse(cleaned);
    const ownHeadings = extractHeadings(splitFrontmatter(cleaned).body);
    const pageDir = path.dirname(page.abs);
    const pageIssues: { href: string; reason: string; at: number }[] = [];

    for (const match of scannable.matchAll(LINK_RE)) {
      const href = match[1];
      if (!href || isExternal(href) || match.index === undefined) continue;
      linksChecked += 1;
      const at = match.index + match[0].length;

      const [target, anchor] = href.split("#", 2) as [string, string | undefined];

      // Pure in-page anchor.
      if (target === "") {
        if (anchor && !ownHeadings.includes(decodeAnchor(anchor))) {
          pageIssues.push({ href, reason: "no matching heading in this page", at });
        }
        continue;
      }

      let decoded: string;
      try {
        decoded = decodeURIComponent(target);
      } catch {
        // A malformed escape is itself the defect; report rather than crash the pass.
        pageIssues.push({ href, reason: "href contains an invalid percent-escape", at });
        continue;
      }

      // A leading `/` is bundle-relative per OKF §7, not filesystem-absolute.
      const base = decoded.startsWith("/") ? wikiRoot : pageDir;
      const relative = decoded.startsWith("/") ? decoded.slice(1) : decoded;
      const resolved = path.resolve(base, relative);

      const containedInWiki = isInside(resolved, wikiRoot);
      const containedInRepo = repoRoot ? isInside(resolved, repoRoot) : false;
      if (!containedInWiki && !containedInRepo) {
        pageIssues.push({ href, reason: "resolves outside the repository", at });
        continue;
      }

      const info = await stat(resolved).catch(() => null);
      if (info === null) {
        pageIssues.push({ href, reason: "target does not exist", at });
        continue;
      }

      if (anchor && info.isFile() && resolved.toLowerCase().endsWith(".md")) {
        const slugs = await headingsOf(resolved);
        if (!slugs.includes(decodeAnchor(anchor))) {
          pageIssues.push({ href, reason: `no heading anchor "${anchor}" in target`, at });
        }
      }
    }

    for (const issue of pageIssues) {
      issues.push({ file: page.rel, href: issue.href, reason: issue.reason });
    }

    if (!stamp) continue;

    // Insert from the end so earlier offsets stay valid.
    let next = cleaned;
    for (const issue of [...pageIssues].sort((a, b) => b.at - a.at)) {
      next = next.slice(0, issue.at) + renderStamp(issue.href, issue.reason) + next.slice(issue.at);
    }
    if (next !== original) {
      await writeFile(page.abs, next, "utf8");
      stampedFiles.push(page.rel);
    }
  }

  return { linksChecked, issues, stampedFiles };
}

function decodeAnchor(anchor: string): string {
  try {
    return decodeURIComponent(anchor).toLowerCase();
  } catch {
    return anchor.toLowerCase();
  }
}

function isInside(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
