/**
 * Mermaid fence validation.
 *
 * A diagram that fails to parse renders as a raw error block on GitHub, which is worse than no
 * diagram. Rather than fail the run, an invalid fence is degraded to a plain `text` fence and
 * stamped with the parser's own message, so a later pass can repair it from a real diagnosis.
 *
 * mermaid is a browser library, so it needs DOM globals before it will load in Node. That shim is
 * why the import is lazy and memoized: paying jsdom's startup cost on a wiki with no diagrams would
 * be pure waste.
 */

import { readFile, writeFile } from "node:fs/promises";
import { walkWiki } from "./wiki.js";

export interface MermaidIssue {
  file: string;
  index: number;
  error: string;
}

export interface MermaidReport {
  fencesChecked: number;
  issues: MermaidIssue[];
  degradedFiles: string[];
  /** Which validator actually ran, so a clean report is never silently weaker than it looks. */
  parser: "mermaid" | "heuristic";
}

export interface MermaidFence {
  /** Index into the source string where the opening fence line starts. */
  start: number;
  /** Index just past the closing fence line. */
  end: number;
  indent: string;
  marker: string;
  code: string;
}

const FENCE_LINE_RE = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^\s`~]*)[ \t]*$/;

/**
 * Finds mermaid fences without a markdown parser.
 *
 * Tracks *every* fence, not just mermaid ones, so a ```mermaid block nested inside an untagged
 * example block is correctly treated as example text rather than a diagram to validate.
 */
export function extractMermaidFences(markdown: string): MermaidFence[] {
  const fences: MermaidFence[] = [];
  const lines = markdown.split("\n");

  let offset = 0;
  let open: { marker: string; indent: string; lang: string; start: number; bodyAt: number } | null =
    null;

  for (const line of lines) {
    const lineLength = line.length + 1;
    const match = FENCE_LINE_RE.exec(line);

    if (match) {
      const [, indent = "", marker = "", lang = ""] = match;
      if (open === null) {
        open = { marker, indent, lang: lang.toLowerCase(), start: offset, bodyAt: offset + lineLength };
      } else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && lang === "") {
        if (open.lang === "mermaid") {
          fences.push({
            start: open.start,
            end: offset + lineLength,
            indent: open.indent,
            marker: open.marker,
            code: markdown.slice(open.bodyAt, offset).replace(/\r?\n$/, ""),
          });
        }
        open = null;
      }
    }
    offset += lineLength;
  }
  return fences;
}

/**
 * Label-safety rules, used when the real parser is unavailable.
 *
 * These are the breakages that actually occur in generated diagrams, not a grammar: unescaped
 * angle brackets, pipes and semicolons inside labels, and reserved words used as identifiers.
 */
export function heuristicError(code: string): string | null {
  const withoutComments = code.replace(/^\s*%%.*$/gm, "");
  const body = withoutComments.trim();
  if (body === "") return "empty diagram";

  // Only bracketed label text is inspected. Checking whole lines would flag every sequence arrow
  // (`->>`, `-->>`, `--x`) as an unescaped angle bracket and degrade valid diagrams.
  const labels = [...body.matchAll(/\[([^\]\n]*)\]|\{([^}\n]*)\}/g)].map(
    (match) => match[1] ?? match[2] ?? "",
  );
  if (labels.some((label) => /[<>]/.test(label))) {
    return "unescaped angle bracket in a label; write 'Promise of User' instead of generics";
  }
  if (labels.some((label) => /[;|]/.test(label))) {
    return "semicolon or pipe inside a node label";
  }
  const reserved = /(^|\s)(?:participant|actor)\s+(note|end|loop|alt|opt|par|and|else|class|state)(\s|$)/i;
  if (reserved.test(body)) {
    return "reserved mermaid keyword used as a participant name";
  }
  if (/(^|\s)end\s*[[({]/i.test(body)) {
    return "'end' used as a node id";
  }
  return null;
}

type MermaidModule = { parse: (text: string) => Promise<unknown> };
let mermaidPromise: Promise<MermaidModule | null> | null = null;

async function loadMermaid(): Promise<MermaidModule | null> {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = (async () => {
    try {
      const { JSDOM } = await import("jsdom");
      const dom = new JSDOM("<!doctype html><html><body></body></html>");
      const globals = globalThis as Record<string, unknown>;
      // mermaid reaches for these at import time. `navigator` is deliberately left alone: Node
      // defines it read-only, and assigning to it throws.
      globals.window ??= dom.window;
      globals.document ??= dom.window.document;
      globals.DOMPurify ??= undefined;
      const mod = (await import("mermaid")) as unknown as { default?: MermaidModule };
      const mermaid = mod.default ?? (mod as unknown as MermaidModule);
      if (typeof mermaid?.parse !== "function") return null;
      return mermaid;
    } catch {
      return null;
    }
  })();
  return mermaidPromise;
}

export interface ValidateMermaidOptions {
  degrade?: boolean;
}

const STAMP_PREFIX = "opencodewiki: mermaid parse failed";

function renderStamp(error: string): string {
  const safe = error.replace(/-{2,}/gu, "-").replace(/>/g, "&gt;").replace(/\s+/g, " ").trim();
  return `<!-- ${STAMP_PREFIX}: ${safe} -->`;
}

export async function validateMermaid(
  wikiRoot: string,
  options: ValidateMermaidOptions = {},
): Promise<MermaidReport> {
  const { degrade = false } = options;
  const tree = await walkWiki(wikiRoot);
  const issues: MermaidIssue[] = [];
  const degradedFiles: string[] = [];
  let fencesChecked = 0;

  const withFences = tree.pages
    .map((page) => ({ page, fences: extractMermaidFences(page.content) }))
    .filter((entry) => entry.fences.length > 0);

  if (withFences.length === 0) {
    return { fencesChecked: 0, issues: [], degradedFiles: [], parser: "heuristic" };
  }

  const mermaid = await loadMermaid();
  const parser: "mermaid" | "heuristic" = mermaid ? "mermaid" : "heuristic";

  for (const { page, fences } of withFences) {
    const failures: { fence: MermaidFence; error: string }[] = [];

    for (const [index, fence] of fences.entries()) {
      fencesChecked += 1;
      let error: string | null = null;
      if (mermaid) {
        try {
          await mermaid.parse(fence.code);
        } catch (thrown) {
          error = (thrown as Error)?.message ?? String(thrown);
        }
      } else {
        error = heuristicError(fence.code);
      }
      if (error !== null) {
        issues.push({ file: page.rel, index, error });
        failures.push({ fence, error });
      }
    }

    if (!degrade || failures.length === 0) continue;

    // Splice from the end so earlier offsets stay valid.
    let next = page.content;
    for (const { fence, error } of failures.slice().reverse()) {
      const original = next.slice(fence.start, fence.end);
      const replaced = original.replace(/^([ \t]*)(`{3,}|~{3,})[ \t]*mermaid[ \t]*$/m, "$1$2text");
      next =
        next.slice(0, fence.start) +
        `${fence.indent}${renderStamp(error)}\n` +
        replaced +
        next.slice(fence.end);
    }
    if (next !== page.content) {
      await writeFile(page.abs, next, "utf8");
      degradedFiles.push(page.rel);
    }
  }

  return { fencesChecked, issues, degradedFiles, parser };
}

/** Reads a single file and validates it, for the `mermaid check <file>` path. */
export async function validateMermaidFile(file: string): Promise<MermaidIssue[]> {
  const content = await readFile(file, "utf8");
  const fences = extractMermaidFences(content);
  if (fences.length === 0) return [];
  const mermaid = await loadMermaid();
  const issues: MermaidIssue[] = [];
  for (const [index, fence] of fences.entries()) {
    let error: string | null = null;
    if (mermaid) {
      try {
        await mermaid.parse(fence.code);
      } catch (thrown) {
        error = (thrown as Error)?.message ?? String(thrown);
      }
    } else {
      error = heuristicError(fence.code);
    }
    if (error !== null) issues.push({ file, index, error });
  }
  return issues;
}
