/**
 * Bundle walking, index generation, and the update log.
 *
 * `index.md` and `log.md` are reserved documents (OKF §8, §9): they are generated here and must
 * never be hand-authored, which is why the model is told to leave them alone. Keeping them
 * deterministic is what lets a wiki live in git without every run producing navigation churn.
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { OKF_VERSION, parseConcept, RESERVED_FILENAMES } from "./okf.js";

/** Never treated as concepts, and never listed in an index. */
const EXCLUDED_FILES = new Set([...RESERVED_FILENAMES, "INSTRUCTIONS.md"]);

const INDEX_FILE = "index.md";
const LOG_FILE = "log.md";

export interface WikiPage {
  /** Path relative to the bundle root, POSIX separators. */
  rel: string;
  abs: string;
  title: string;
  description?: string;
  type?: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

export interface WikiTree {
  root: string;
  pages: WikiPage[];
  /** Every directory in the bundle, root first, parents before children. */
  directories: string[];
}

function isHidden(name: string): boolean {
  return name.startsWith(".");
}

/** Codepoint ordering. `localeCompare` would make output depend on the machine's ICU data. */
function byCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function walkWiki(root: string): Promise<WikiTree> {
  const pages: WikiPage[] = [];
  const directories: string[] = [];

  async function visit(dirAbs: string, dirRel: string): Promise<void> {
    directories.push(dirRel);
    let entries;
    try {
      entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    const names = entries.map((entry) => entry.name).sort(byCodepoint);

    for (const name of names) {
      if (isHidden(name)) continue;
      const abs = path.join(dirAbs, name);
      const rel = dirRel === "" ? name : `${dirRel}/${name}`;
      const info = await stat(abs).catch(() => null);
      if (info === null) continue;

      if (info.isDirectory()) {
        await visit(abs, rel);
        continue;
      }
      if (!name.toLowerCase().endsWith(".md")) continue;
      if (EXCLUDED_FILES.has(name)) continue;

      const content = await readFile(abs, "utf8");
      const parsed = parseConcept(content, rel);
      const data = parsed.data;
      pages.push({
        rel,
        abs,
        title:
          typeof data.title === "string" && data.title.trim()
            ? data.title.trim()
            : name.replace(/\.md$/i, ""),
        description: typeof data.description === "string" ? data.description.trim() : undefined,
        type: typeof data.type === "string" ? data.type : undefined,
        frontmatter: data,
        content,
      });
    }
  }

  await visit(root, "");
  return { root, pages, directories };
}

/** Percent-encodes each path segment while leaving separators intact. */
function encodeHref(relative: string): string {
  return relative
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function escapeLabel(label: string): string {
  return label.replace(/([[\]])/g, "\\$1");
}

interface IndexEntry {
  label: string;
  href: string;
  description?: string;
}

function renderSection(heading: string, entries: IndexEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((entry) => {
    const link = `- [${escapeLabel(entry.label)}](${entry.href})`;
    return entry.description ? `${link} - ${entry.description}` : link;
  });
  return `# ${heading}\n\n${lines.join("\n")}\n`;
}

export function renderIndex(
  files: IndexEntry[],
  dirs: IndexEntry[],
  isRoot: boolean,
): string {
  // Only the bundle-root index may carry front matter, and only `okf_version` (OKF §8).
  const header = isRoot ? `---\nokf_version: "${OKF_VERSION}"\n---\n\n` : "";
  const sections = [renderSection("Files", files), renderSection("Directories", dirs)].filter(
    (section) => section.length > 0,
  );
  if (sections.length === 0) return `${header}# Files\n`;
  return header + sections.join("\n");
}

export interface IndexSyncResult {
  written: string[];
  unchanged: string[];
}

/**
 * Regenerates every directory index.
 *
 * Writes only when content actually differs, so re-running is a no-op in git. That idempotence is
 * the property the whole finalize pass is checked against.
 */
export async function syncIndexes(root: string): Promise<IndexSyncResult> {
  const tree = await walkWiki(root);
  const written: string[] = [];
  const unchanged: string[] = [];

  const pagesByDir = new Map<string, WikiPage[]>();
  for (const page of tree.pages) {
    const dir = page.rel.includes("/") ? page.rel.slice(0, page.rel.lastIndexOf("/")) : "";
    const list = pagesByDir.get(dir) ?? [];
    list.push(page);
    pagesByDir.set(dir, list);
  }

  const childDirs = new Map<string, string[]>();
  for (const dir of tree.directories) {
    if (dir === "") continue;
    const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
    const list = childDirs.get(parent) ?? [];
    list.push(dir);
    childDirs.set(parent, list);
  }

  for (const dir of tree.directories) {
    const files: IndexEntry[] = (pagesByDir.get(dir) ?? [])
      .slice()
      .sort((a, b) => byCodepoint(a.rel, b.rel))
      .map((page) => ({
        label: page.title,
        href: encodeHref(page.rel.slice(dir === "" ? 0 : dir.length + 1)),
        description: page.description,
      }));

    const dirs: IndexEntry[] = (childDirs.get(dir) ?? [])
      .slice()
      .sort(byCodepoint)
      .map((child) => {
        const name = child.slice(dir === "" ? 0 : dir.length + 1);
        return { label: name, href: `${encodeHref(name)}/` };
      });

    // A directory with neither pages nor subdirectories gets no index at all.
    if (files.length === 0 && dirs.length === 0) continue;

    const target = path.join(root, dir, INDEX_FILE);
    const next = renderIndex(files, dirs, dir === "");
    const current = await readFile(target, "utf8").catch(() => null);
    if (current === next) {
      unchanged.push(path.relative(root, target));
      continue;
    }
    await writeFile(target, next, "utf8");
    written.push(path.relative(root, target));
  }

  return { written, unchanged };
}

export type LogKind = "Creation" | "Update" | "Deprecation" | "Initialization";

export interface LogEntry {
  kind: LogKind;
  /** Markdown, typically containing a link to the affected concept. */
  text: string;
}

const LOG_HEADING = "# Update Log";

/**
 * Prepends entries under today's date, newest date first (OKF §9).
 *
 * The log is the wiki's own history: for a repo wiki it answers "what did the last run actually
 * change", which is the question a developer asks when a page they relied on has moved.
 */
export async function appendLog(
  root: string,
  entries: LogEntry[],
  today = new Date(),
): Promise<boolean> {
  if (entries.length === 0) return false;

  const date = today.toISOString().slice(0, 10);
  const target = path.join(root, LOG_FILE);
  const existing = (await readFile(target, "utf8").catch(() => null)) ?? `${LOG_HEADING}\n`;

  const rendered = entries.map((entry) => `- **${entry.kind}**: ${entry.text}`).join("\n");
  const heading = `## ${date}`;

  let next: string;
  if (existing.includes(`\n${heading}\n`)) {
    // Same-day rerun: extend the existing date section rather than opening a second one.
    next = existing.replace(`${heading}\n`, `${heading}\n${rendered}\n`);
  } else {
    const body = existing.slice(existing.indexOf("\n") + 1).replace(/^\n+/, "");
    next = `${LOG_HEADING}\n\n${heading}\n${rendered}\n${body ? `\n${body}` : ""}`;
  }

  if (next === existing) return false;
  await writeFile(target, next, "utf8");
  return true;
}
