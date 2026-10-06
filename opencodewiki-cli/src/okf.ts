/**
 * OKF v0.2 concept documents.
 *
 * Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 *
 * Two spec rules shape this whole module and are easy to violate by accident:
 *
 *   1. `type` is the ONLY required field. A document carrying just `type` is fully conformant,
 *      so nothing here may reject a page for a missing optional family.
 *   2. Producers may add any keys, and consumers "SHOULD preserve unknown keys when round-tripping".
 *      So every mutation goes through the yaml Document API rather than re-serializing a plain
 *      object, which would silently drop anything we don't have a type for.
 */

import { Document, isMap, parseDocument, type YAMLMap } from "yaml";

export const OKF_VERSION = "0.2";

/** Reserved by the spec; these are never concept documents. */
export const RESERVED_FILENAMES = new Set(["index.md", "log.md"]);

/** Marker left on front matter this tool synthesized, so a later pass can enrich it. */
export const GENERATED_MARKER = "opencodewiki_generated";

/** Our producer identity, in the spec's `<producer>/<version>` actor form. */
export function producerActor(model?: string): string {
  return model ? `opencodewiki/${model}` : "opencodewiki";
}

export type OkfStatus = "draft" | "stable" | "deprecated";
const STATUS_VALUES: readonly string[] = ["draft", "stable", "deprecated"];

export type TrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

export interface OkfActorRef {
  by: string;
  at?: string;
}

export interface OkfSource {
  resource: string;
  id?: string;
  title?: string;
  author?: string;
  usage_count?: number;
  last_modified?: string;
  /** Producer extension: lets a consumer weigh a plan differently from a source file. */
  kind?: "code" | "test" | "plan" | "doc" | "config" | "other";
}

export interface IssueLocation {
  file?: string;
  line?: number;
}

export type IssueCode =
  | "missing_opening_delimiter"
  | "missing_closing_delimiter"
  | "invalid_yaml"
  | "invalid_yaml_root"
  | "missing_type"
  | "invalid_field"
  | "invalid_tags"
  | "invalid_status"
  | "invalid_stale_after"
  | "invalid_actor"
  | "invalid_sources"
  | "reserved_has_frontmatter"
  | "generated_marker_present"
  /** Producer extensions: chamber altitude rules, not OKF conformance. See budget.ts. */
  | "budget_exceeded"
  | "budget_thin";

export interface OkfIssue extends IssueLocation {
  code: IssueCode;
  field?: string;
  message: string;
  /** A conformance failure per the spec, versus a quality signal we add on top. */
  severity: "error" | "warning";
}

export interface SplitResult {
  /** Raw YAML text between the delimiters, without them. */
  yaml: string;
  /** Everything after the closing delimiter. */
  body: string;
  hasFrontmatter: boolean;
  /** Line-ending style of the source, so writes don't silently convert CRLF files. */
  eol: "\n" | "\r\n";
}

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function detectEol(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Splits front matter from body without a markdown parser.
 *
 * A file with an opening `---` but no closing one is reported as `hasFrontmatter: false` with the
 * whole text as body; the caller decides whether that is an error. Treating it as "no front matter"
 * rather than throwing keeps every downstream pass total.
 */
export function splitFrontmatter(content: string): SplitResult {
  const eol = detectEol(content);
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return { yaml: "", body: content, hasFrontmatter: false, eol };
  return {
    yaml: match[1] ?? "",
    // Drop the blank separator line so split/join are symmetric and round-trips are stable.
    body: content.slice(match[0].length).replace(/^(?:\r?\n)+/, ""),
    hasFrontmatter: true,
    eol,
  };
}

function normalizeEol(text: string, eol: "\n" | "\r\n"): string {
  const lf = text.replace(/\r\n/g, "\n");
  return eol === "\n" ? lf : lf.replace(/\n/g, "\r\n");
}

export function joinFrontmatter(yamlText: string, body: string, eol: "\n" | "\r\n"): string {
  const trimmed = yamlText.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const block = `---\n${trimmed}\n---\n\n`;
  const cleanBody = body.replace(/\r\n/g, "\n").replace(/^\n+/, "");
  return normalizeEol(block + cleanBody, eol);
}

export interface ParsedConcept {
  doc: Document.Parsed | null;
  data: Record<string, unknown>;
  split: SplitResult;
  issues: OkfIssue[];
}

export function parseConcept(content: string, file?: string): ParsedConcept {
  const split = splitFrontmatter(content);
  const issues: OkfIssue[] = [];

  if (!split.hasFrontmatter) {
    issues.push({
      code: content.startsWith("---") ? "missing_closing_delimiter" : "missing_opening_delimiter",
      message: content.startsWith("---")
        ? "Front matter opens with --- but never closes."
        : "File does not begin with a --- front matter block.",
      severity: "error",
      file,
    });
    return { doc: null, data: {}, split, issues };
  }

  let doc: Document.Parsed;
  try {
    doc = parseDocument(split.yaml, { keepSourceTokens: true });
  } catch (error) {
    issues.push({
      code: "invalid_yaml",
      message: `Front matter is not parseable YAML: ${(error as Error).message}`,
      severity: "error",
      file,
    });
    return { doc: null, data: {}, split, issues };
  }

  if (doc.errors.length > 0) {
    issues.push({
      code: "invalid_yaml",
      message: `Front matter is not parseable YAML: ${doc.errors[0]?.message ?? "unknown error"}`,
      severity: "error",
      file,
    });
    return { doc: null, data: {}, split, issues };
  }

  const value = doc.toJS() as unknown;
  if (value !== null && (typeof value !== "object" || Array.isArray(value))) {
    issues.push({
      code: "invalid_yaml_root",
      message: "Front matter must be a YAML mapping.",
      severity: "error",
      file,
    });
    return { doc: null, data: {}, split, issues };
  }

  return { doc, data: (value ?? {}) as Record<string, unknown>, split, issues };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACTOR_RE = /^(?:human:[\w.@-]+|process:[\w./-]+|[\w.-]+\/[\w.-]+|[\w.-]+)$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateActorRefs(
  value: unknown,
  field: string,
  file: string | undefined,
  issues: OkfIssue[],
): void {
  // The spec requires consumers to treat a bare mapping as a one-element list.
  const entries = Array.isArray(value) ? value : [value];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      issues.push({
        code: "invalid_field",
        field,
        message: `${field} entries must be mappings with a 'by' key.`,
        severity: "error",
        file,
      });
      continue;
    }
    const by = (entry as Record<string, unknown>).by;
    if (!isNonEmptyString(by)) {
      issues.push({
        code: "invalid_actor",
        field,
        message: `${field}.by is required and must be a non-empty actor string.`,
        severity: "error",
        file,
      });
    } else if (!ACTOR_RE.test(by)) {
      issues.push({
        code: "invalid_actor",
        field,
        message: `${field}.by "${by}" does not match the actor convention (<producer>/<version>, human:<id>, process:<id>).`,
        severity: "warning",
        file,
      });
    }
    const at = (entry as Record<string, unknown>).at;
    if (at !== undefined && !isNonEmptyString(at)) {
      issues.push({
        code: "invalid_field",
        field: `${field}.at`,
        message: `${field}.at must be an ISO 8601 datetime string.`,
        severity: "error",
        file,
      });
    }
  }
}

export interface ValidateOptions {
  file?: string;
  /**
   * Routing metadata opencodewiki needs but OKF does not mandate. Off by default so plain
   * conformance checking stays spec-faithful; the plugin turns it on for generated pages.
   */
  requireRouting?: boolean;
}

/**
 * Validates a concept document against OKF v0.2.
 *
 * Only genuine conformance failures are `severity: "error"`. Everything the spec calls optional is
 * at most a warning, because the spec explicitly forbids rejecting a document for a missing
 * optional family, an unknown `type`, or unknown extra keys.
 */
export function validateConcept(content: string, options: ValidateOptions = {}): OkfIssue[] {
  const { file, requireRouting = false } = options;
  const parsed = parseConcept(content, file);
  const issues = [...parsed.issues];
  if (parsed.doc === null) return issues;

  const data = parsed.data;

  if (!isNonEmptyString(data.type)) {
    issues.push({
      code: "missing_type",
      field: "type",
      message: "type is required and must be a non-empty string.",
      severity: "error",
      file,
    });
  }

  for (const field of ["title", "description", "resource"] as const) {
    if (data[field] !== undefined && !isNonEmptyString(data[field])) {
      issues.push({
        code: "invalid_field",
        field,
        message: `${field} must be a non-empty string when present.`,
        severity: "error",
        file,
      });
    }
  }

  if (data.tags !== undefined) {
    const tags = data.tags;
    if (!Array.isArray(tags) || tags.some((tag) => !isNonEmptyString(tag))) {
      issues.push({
        code: "invalid_tags",
        field: "tags",
        message: "tags must be a list of non-empty strings.",
        severity: "error",
        file,
      });
    }
  }

  if (data.status !== undefined && !STATUS_VALUES.includes(String(data.status))) {
    issues.push({
      code: "invalid_status",
      field: "status",
      message: `status must be one of ${STATUS_VALUES.join(", ")}.`,
      severity: "error",
      file,
    });
  }

  if (data.stale_after !== undefined && !ISO_DATE_RE.test(String(data.stale_after))) {
    issues.push({
      code: "invalid_stale_after",
      field: "stale_after",
      message: "stale_after must be an absolute date in YYYY-MM-DD form.",
      severity: "error",
      file,
    });
  }

  if (data.generated !== undefined) validateActorRefs(data.generated, "generated", file, issues);
  if (data.verified !== undefined) validateActorRefs(data.verified, "verified", file, issues);

  if (data.sources !== undefined) {
    if (!Array.isArray(data.sources)) {
      issues.push({
        code: "invalid_sources",
        field: "sources",
        message: "sources must be a list.",
        severity: "error",
        file,
      });
    } else {
      for (const [index, source] of data.sources.entries()) {
        if (typeof source !== "object" || source === null || Array.isArray(source)) {
          issues.push({
            code: "invalid_sources",
            field: `sources[${index}]`,
            message: "each source must be a mapping.",
            severity: "error",
            file,
          });
          continue;
        }
        if (!isNonEmptyString((source as Record<string, unknown>).resource)) {
          issues.push({
            code: "invalid_sources",
            field: `sources[${index}].resource`,
            message: "sources[].resource is required.",
            severity: "error",
            file,
          });
        }
      }
    }
  }

  if (data[GENERATED_MARKER] === true) {
    issues.push({
      code: "generated_marker_present",
      field: GENERATED_MARKER,
      message:
        "Front matter was synthesized by the tool and still needs a grounded type, title and description.",
      severity: "warning",
      file,
    });
  }

  if (requireRouting) {
    if (!Array.isArray(data.sources) || data.sources.length === 0) {
      issues.push({
        code: "invalid_sources",
        field: "sources",
        message: "A generated page must cite at least one source.",
        severity: "error",
        file,
      });
    }
    const ext = data.opencodewiki;
    if (typeof ext !== "object" || ext === null || Array.isArray(ext)) {
      issues.push({
        code: "invalid_field",
        field: "opencodewiki",
        message: "A generated page must carry the opencodewiki routing extension.",
        severity: "error",
        file,
      });
    }
  }

  return issues;
}

/** Trust tier per spec §5.3: derived only from `verified`, never asserted directly. */
export function deriveTrustTier(verified: unknown): TrustTier {
  if (verified === undefined || verified === null) return "unverified";
  const entries = Array.isArray(verified) ? verified : [verified];
  let sawAny = false;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const by = (entry as Record<string, unknown>).by;
    if (!isNonEmptyString(by)) continue;
    sawAny = true;
    if (by.startsWith("human:")) return "human-reviewed";
  }
  return sawAny ? "machine-confirmed" : "unverified";
}

/** Stale when today has reached the date, per spec §6: a plain date comparison, no TTL maths. */
export function isStale(staleAfter: unknown, today = new Date()): boolean {
  if (!isNonEmptyString(staleAfter) || !ISO_DATE_RE.test(staleAfter)) return false;
  const iso = today.toISOString().slice(0, 10);
  return iso >= staleAfter;
}

/**
 * Canonical key order. Core identity first, then where it came from, then how far to trust it,
 * then lifecycle — so the most-read fields sit at the top of the file. Unknown producer keys keep
 * their relative order and follow the known ones.
 */
const KEY_ORDER = [
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "sources",
  "usage_window",
  "generated",
  "verified",
  "status",
  "stale_after",
  "runtime",
  "parameters",
  "computation",
  "executor",
  "attester",
];

export interface NormalizeOptions {
  file?: string;
  /** Fallback `type` when a page has none and one must be synthesized. */
  defaultType?: string;
  /** Reorder keys into canonical order. */
  canonical?: boolean;
}

export interface NormalizeResult {
  content: string;
  changed: boolean;
  issues: OkfIssue[];
}

function titleFromBody(body: string, file?: string): string | undefined {
  const heading = /^#\s+(.+)$/m.exec(body);
  if (heading?.[1]) return heading[1].trim();
  if (file) {
    const base = file.split("/").pop()?.replace(/\.md$/, "") ?? "";
    if (base) return base.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return undefined;
}

function reorder(map: YAMLMap): void {
  const rank = (key: unknown): number => {
    const index = KEY_ORDER.indexOf(String(key));
    return index === -1 ? KEY_ORDER.length : index;
  };
  map.items.sort((a, b) => {
    const left = rank((a.key as { value?: unknown })?.value ?? a.key);
    const right = rank((b.key as { value?: unknown })?.value ?? b.key);
    return left - right;
  });
}

/**
 * Repairs a concept so it is always conformant, never rejected.
 *
 * A page missing `type` gets a synthesized one plus the `opencodewiki_generated` marker, rather
 * than being dropped or failing the run — the model can enrich it on a later pass, and the marker
 * is how it finds the pages that need enriching. Everything already present is preserved, including
 * keys this tool knows nothing about.
 */
export function normalizeConcept(content: string, options: NormalizeOptions = {}): NormalizeResult {
  const { file, defaultType = "Reference", canonical = true } = options;
  const parsed = parseConcept(content, file);
  const issues: OkfIssue[] = [];

  // Unparseable or absent front matter: synthesize a minimal block and keep the body intact.
  if (parsed.doc === null) {
    const body = parsed.split.hasFrontmatter ? parsed.split.body : content;
    const doc = new Document({});
    const map = doc.contents as YAMLMap;
    doc.set("type", defaultType);
    const title = titleFromBody(body, file);
    if (title) doc.set("title", title);
    doc.set(GENERATED_MARKER, true);
    void map;
    const next = joinFrontmatter(String(doc), body, parsed.split.eol);
    return {
      content: next,
      changed: next !== content,
      issues: [
        ...parsed.issues,
        {
          code: "generated_marker_present",
          field: GENERATED_MARKER,
          message: "Front matter was synthesized because it was missing or unparseable.",
          severity: "warning",
          file,
        },
      ],
    };
  }

  const doc = parsed.doc;
  let touched = false;

  if (!isNonEmptyString(parsed.data.type)) {
    doc.set("type", defaultType);
    doc.set(GENERATED_MARKER, true);
    touched = true;
    issues.push({
      code: "generated_marker_present",
      field: "type",
      message: `type was missing and defaulted to "${defaultType}".`,
      severity: "warning",
      file,
    });
  }

  // A grounded type makes the synthesized-metadata marker obsolete; clearing it here is what stops
  // the repair queue growing without bound.
  if (parsed.data[GENERATED_MARKER] === true && isNonEmptyString(parsed.data.type)) {
    const hasGroundedMetadata =
      isNonEmptyString(parsed.data.title) && isNonEmptyString(parsed.data.description);
    if (hasGroundedMetadata) {
      doc.delete(GENERATED_MARKER);
      touched = true;
    }
  }

  if (canonical && isMap(doc.contents)) {
    const before = String(doc);
    reorder(doc.contents);
    if (String(doc) !== before) touched = true;
  }

  const next = joinFrontmatter(String(doc), parsed.split.body, parsed.split.eol);
  return { content: next, changed: touched || next !== content, issues };
}
