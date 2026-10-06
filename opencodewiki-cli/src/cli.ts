#!/usr/bin/env node
/**
 * opencodewiki — deterministic passes over an OKF v0.2 repository wiki.
 *
 * Exit codes are part of the contract, because the plugin branches on them:
 *   0  clean / nothing to report
 *   1  tool or usage error (bad arguments, not a git repo, unreadable wiki)
 *   2  findings — the tool worked, the wiki has problems
 *   3  nothing to do (no changes since the last run)
 *
 * Keeping "the tool broke" and "the wiki is dirty" on different codes matters: conflating them
 * makes a broken install look like a wiki that needs work.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { detectTopology } from "./architecture.js";
import { checkLinks } from "./links.js";
import { validateMermaid } from "./mermaid.js";
import { OKF_VERSION, producerActor } from "./okf.js";
import { buildReport, finalizeWiki, formatWiki, guardPaths, reportOkf } from "./report.js";
import {
  computeDelta,
  contentHash,
  currentHead,
  FORMAT_VERSION,
  indexPlans,
  isGitRepo,
  readState,
  resolvePlansDir,
  writeState,
  type RunState,
} from "./state.js";
import { writePlanConvention } from "./agents-md.js";
import { appendLog, syncIndexes } from "./wiki.js";

/** Kept in step with package.json by the release checklist; there is no bundler to inject it. */
const PACKAGE_VERSION = "0.1.1";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_FINDINGS = 2;
const EXIT_NOTHING = 3;

interface Args {
  command: string;
  sub: string | null;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(body, next);
      index += 1;
    } else {
      flags.set(body, true);
    }
  }

  const command = positionals.shift() ?? "help";
  const known = new Set(["okf", "index", "links", "mermaid", "state", "plans", "log", "architecture"]);
  const sub = known.has(command) ? (positionals.shift() ?? null) : null;
  return { command, sub, positionals, flags };
}

function flagString(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagBool(args: Args, name: string): boolean {
  return args.flags.get(name) === true || args.flags.get(name) === "true";
}

function emit(args: Args, payload: unknown, human: () => string): void {
  if (flagBool(args, "json")) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${human()}\n`);
  }
}

function resolveRepoRoot(args: Args): string {
  return path.resolve(flagString(args, "repo") ?? process.cwd());
}

function resolveWikiRoot(args: Args): string {
  const repo = resolveRepoRoot(args);
  const wiki = flagString(args, "wiki") ?? "opencodewiki";
  return path.isAbsolute(wiki) ? wiki : path.resolve(repo, wiki);
}

const USAGE = `opencodewiki ${OKF_VERSION} — deterministic passes for an OKF v0.2 repository wiki

Usage: opencodewiki <command> [options]

Wiki passes
  okf validate            Report OKF v0.2 conformance without writing
  okf normalize           Repair and canonicalise front matter (alias: fmt)
  index sync              Regenerate every directory index.md
  links check             Resolve internal links and heading anchors
  links stamp             Same, but mark broken links in place
  mermaid check           Validate every mermaid fence
  mermaid degrade         Same, but convert failing fences to text
  finalize                normalize -> mermaid -> index -> links, in order
  report                  Aggregate report over the whole wiki
  verify                  report, but exits 2 on any finding (for gating)

Repository
  setup                   Create the wiki directory, brief stub, state file, and
                          write the plan check-in convention into CLAUDE.md/AGENTS.md
  state show|begin|stamp  Read or advance run state
  delta                   What changed since the last recorded run
  plans index             Discover and cluster Claude Code plans
  architecture detect     Emit a topology fact-sheet for the repository
  log add                 Append entries to the wiki update log
  guard <paths...>        Check paths stay inside the wiki

Options
  --repo <dir>            Repository root (default: cwd)
  --wiki <dir>            Wiki directory, relative to repo (default: opencodewiki)
  --json                  Machine-readable output
  --check                 Report what would change without writing
  --require-routing       Also require generated-page routing metadata
  --strict-mermaid        Fail if the real mermaid parser is unavailable

Mermaid validation uses the real parser when the optional mermaid and jsdom
packages are installed, and a label-safety heuristic otherwise. Every report
names which one ran.
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  // `--help` / `--version` arrive as flags, not positionals, so they need handling before dispatch.
  if (args.flags.has("help")) {
    process.stdout.write(USAGE);
    return EXIT_OK;
  }
  if (args.flags.has("version")) {
    emit(args, { version: PACKAGE_VERSION, okfVersion: OKF_VERSION, formatVersion: FORMAT_VERSION }, () =>
      `opencodewiki ${PACKAGE_VERSION} (OKF ${OKF_VERSION}, state format ${FORMAT_VERSION})`);
    return EXIT_OK;
  }

  const command = args.sub ? `${args.command} ${args.sub}` : args.command;

  switch (command) {
    case "help":
    case "--help":
      process.stdout.write(USAGE);
      return EXIT_OK;

    case "version-cmd":
    case "--version":
      emit(args, { okfVersion: OKF_VERSION, formatVersion: FORMAT_VERSION }, () =>
        `okf ${OKF_VERSION}, state format ${FORMAT_VERSION}`);
      return EXIT_OK;

    case "okf validate": {
      const report = await reportOkf(resolveWikiRoot(args), {
        requireRouting: flagBool(args, "require-routing"),
      });
      emit(args, report, () => {
        const lines = [
          `${report.pages} pages, ${report.invalidCount} conformance errors`,
          `types: ${report.distinctTypes.join(", ") || "(none)"}`,
          `trust: ${report.trust.unverified} unverified, ${report.trust["machine-confirmed"]} machine-confirmed, ${report.trust["human-reviewed"]} human-reviewed`,
        ];
        for (const issue of report.issues.slice(0, 40)) {
          lines.push(`  ${issue.severity === "error" ? "ERR " : "warn"} ${issue.file ?? ""}: ${issue.message}`);
        }
        if (report.issues.length > 40) lines.push(`  ... ${report.issues.length - 40} more`);
        return lines.join("\n");
      });
      return report.invalidCount > 0 ? EXIT_FINDINGS : EXIT_OK;
    }

    case "fmt":
    case "okf normalize": {
      const result = await formatWiki(resolveWikiRoot(args), {
        check: flagBool(args, "check"),
        defaultType: flagString(args, "default-type"),
      });
      emit(args, result, () =>
        `${result.changed.length} changed, ${result.unchanged} already canonical` +
        (result.changed.length ? `\n  ${result.changed.join("\n  ")}` : ""));
      return result.changed.length > 0 && flagBool(args, "check") ? EXIT_FINDINGS : EXIT_OK;
    }

    case "index sync": {
      const result = await syncIndexes(resolveWikiRoot(args));
      emit(args, result, () =>
        `${result.written.length} indexes written, ${result.unchanged.length} unchanged` +
        (result.written.length ? `\n  ${result.written.join("\n  ")}` : ""));
      return EXIT_OK;
    }

    case "links check":
    case "links stamp": {
      const report = await checkLinks(resolveWikiRoot(args), {
        repoRoot: resolveRepoRoot(args),
        stamp: args.sub === "stamp",
      });
      emit(args, report, () => {
        const lines = [`${report.linksChecked} links checked, ${report.issues.length} broken`];
        for (const issue of report.issues) lines.push(`  ${issue.file}: ${issue.href} — ${issue.reason}`);
        return lines.join("\n");
      });
      return report.issues.length > 0 ? EXIT_FINDINGS : EXIT_OK;
    }

    case "mermaid check":
    case "mermaid degrade": {
      const report = await validateMermaid(resolveWikiRoot(args), {
        degrade: args.sub === "degrade",
      });
      emit(args, report, () => {
        const lines = [
          `${report.fencesChecked} fences checked with the ${report.parser} validator, ${report.issues.length} invalid`,
        ];
        for (const issue of report.issues) lines.push(`  ${issue.file} #${issue.index}: ${issue.error}`);
        return lines.join("\n");
      });
      // The heuristic catches the common label breakages but is not a grammar. A caller that needs
      // an authoritative answer says so, rather than reading a clean report that is quietly weaker.
      if (flagBool(args, "strict-mermaid") && report.parser !== "mermaid" && report.fencesChecked > 0) {
        process.stderr.write(
          "strict mermaid requested but the parser is unavailable; install the optional mermaid and jsdom packages\n",
        );
        return EXIT_ERROR;
      }
      return report.issues.length > 0 ? EXIT_FINDINGS : EXIT_OK;
    }

    case "finalize": {
      const wiki = resolveWikiRoot(args);
      const result = await finalizeWiki(wiki, { repoRoot: resolveRepoRoot(args) });
      emit(args, result, () =>
        [
          `formatted ${result.formatted.length}`,
          `degraded ${result.mermaid.degradedFiles.length} (${result.mermaid.parser} validator)`,
          `indexes ${result.indexesWritten.length}`,
          `stamped ${result.links.stampedFiles.length}`,
          result.idempotent ? "no changes — already finalized" : "wiki updated",
        ].join(", "));
      return EXIT_OK;
    }

    case "report":
    case "verify": {
      const report = await buildReport(resolveWikiRoot(args), {
        repoRoot: resolveRepoRoot(args),
        requireRouting: flagBool(args, "require-routing"),
      });
      emit(args, report, () =>
        [
          `pages           ${report.okf.pages}`,
          `okf errors      ${report.okf.invalidCount}`,
          `distinct types  ${report.okf.distinctTypes.length} (${report.okf.distinctTypes.join(", ") || "none"})`,
          `trust           ${report.okf.trust.unverified}/${report.okf.trust["machine-confirmed"]}/${report.okf.trust["human-reviewed"]} unverified/machine/human`,
          `needs grounding ${report.okf.needsGrounding.length}`,
          `links           ${report.links.linksChecked} checked, ${report.links.issues.length} broken`,
          `mermaid         ${report.mermaid.fencesChecked} fences, ${report.mermaid.issues.length} invalid (${report.mermaid.parser})`,
          `findings        ${report.findings}`,
        ].join("\n"));
      if (
        command === "verify" &&
        flagBool(args, "strict-mermaid") &&
        report.mermaid.parser !== "mermaid" &&
        report.mermaid.fencesChecked > 0
      ) {
        process.stderr.write(
          "strict mermaid requested but the parser is unavailable; install the optional mermaid and jsdom packages\n",
        );
        return EXIT_ERROR;
      }
      return command === "verify" && report.findings > 0 ? EXIT_FINDINGS : EXIT_OK;
    }

    case "guard": {
      const result = await guardPaths(resolveWikiRoot(args), args.positionals);
      emit(args, result, () =>
        result.blocked.length === 0
          ? `all ${result.allowed.length} paths inside the wiki`
          : `blocked ${result.blocked.length}:\n  ${result.blocked.join("\n  ")}`);
      return result.blocked.length > 0 ? EXIT_FINDINGS : EXIT_OK;
    }

    case "setup": {
      const repo = resolveRepoRoot(args);
      if (!(await isGitRepo(repo))) {
        process.stderr.write(`not a git repository: ${repo}\n`);
        return EXIT_ERROR;
      }
      const wiki = resolveWikiRoot(args);
      await mkdir(wiki, { recursive: true });

      const brief = path.join(wiki, "INSTRUCTIONS.md");
      const { readIfExists } = await import("./report.js");
      if ((await readIfExists(brief)) === null) {
        await writeFile(brief, BRIEF_STUB, "utf8");
      }

      const existing = await readState(wiki);
      if (existing === null) {
        await writeState(wiki, {
          formatVersion: FORMAT_VERSION,
          okfVersion: OKF_VERSION,
          command: "init",
          status: "interrupted",
          gitHead: null,
          updatedAt: new Date().toISOString(),
          phase: "setup",
        });
      }
      const plansDir = await resolvePlansDir(repo);

      // The convention only earns its place when plans are actually being read, so it is written
      // when a plans directory exists (or the caller asks for it explicitly).
      const wantsConvention = plansDir !== null || flagBool(args, "plan-convention");
      const agentDocs = wantsConvention ? await writePlanConvention(repo) : [];

      emit(args, { wiki, brief, plansDir, created: existing === null, agentDocs }, () =>
        [
          `wiki at ${path.relative(repo, wiki)}`,
          `brief at ${path.relative(repo, brief)}`,
          `plans ${plansDir ?? "(plansDirectory not configured)"}`,
          ...agentDocs.map((doc) => `${doc.action} ${path.relative(repo, doc.file)} (plan check-in convention)`),
        ].join("\n"));
      return EXIT_OK;
    }

    case "state show": {
      const state = await readState(resolveWikiRoot(args));
      if (state === null) {
        emit(args, { state: null }, () => "no recorded run");
        return EXIT_NOTHING;
      }
      emit(args, state, () =>
        `${state.command} ${state.status} at ${state.updatedAt}, head ${state.gitHead ?? "(none)"}${state.phase ? `, phase ${state.phase}` : ""}`);
      return EXIT_OK;
    }

    case "state begin": {
      const repo = resolveRepoRoot(args);
      const wiki = resolveWikiRoot(args);
      const commandName = (flagString(args, "command") ?? "init") as RunState["command"];
      await mkdir(wiki, { recursive: true });
      const state: RunState = {
        formatVersion: FORMAT_VERSION,
        okfVersion: OKF_VERSION,
        command: commandName,
        status: "running",
        gitHead: await currentHead(repo),
        updatedAt: new Date().toISOString(),
        phase: flagString(args, "phase") ?? "start",
        model: flagString(args, "model"),
      };
      await writeState(wiki, state);
      emit(args, state, () => `began ${commandName} at ${state.gitHead ?? "(no head)"}`);
      return EXIT_OK;
    }

    case "state stamp": {
      const repo = resolveRepoRoot(args);
      const wiki = resolveWikiRoot(args);
      const previous = await readState(wiki);
      if (previous === null) {
        process.stderr.write("no state to stamp; run `opencodewiki state begin` first\n");
        return EXIT_ERROR;
      }
      const status = (flagString(args, "status") ?? "complete") as RunState["status"];
      const next: RunState = {
        ...previous,
        status,
        gitHead: await currentHead(repo),
        updatedAt: new Date().toISOString(),
        phase: flagString(args, "phase") ?? previous.phase,
        contentHash: await contentHash(wiki),
        model: flagString(args, "model") ?? previous.model,
      };
      await writeState(wiki, next);
      emit(args, next, () => `stamped ${status} at ${next.gitHead ?? "(no head)"}`);
      return EXIT_OK;
    }

    case "delta": {
      const repo = resolveRepoRoot(args);
      if (!(await isGitRepo(repo))) {
        process.stderr.write(`not a git repository: ${repo}\n`);
        return EXIT_ERROR;
      }
      const plansDir = await resolvePlansDir(repo);
      const delta = await computeDelta(repo, resolveWikiRoot(args), plansDir);
      emit(args, delta, () =>
        [
          `reason        ${delta.reason}`,
          `from..to      ${delta.fromHead?.slice(0, 8) ?? "(none)"}..${delta.toHead?.slice(0, 8) ?? "(none)"}`,
          `changed files ${delta.changedFiles.length}`,
          `changed plans ${delta.changedPlans.length}`,
          `worktree      ${delta.dirty ? "dirty" : "clean"}`,
        ].join("\n"));
      if (delta.needsInit) return EXIT_ERROR;
      return delta.noop ? EXIT_NOTHING : EXIT_OK;
    }

    case "plans index": {
      const repo = resolveRepoRoot(args);
      const plansDir = flagString(args, "plans-dir") ?? (await resolvePlansDir(repo));
      if (plansDir === null) {
        emit(args, { plansDir: null, clusters: [] }, () =>
          "plansDirectory is not configured in .claude/settings.json");
        return EXIT_NOTHING;
      }
      const payload = await indexPlans(repo, plansDir);
      const { clusters, batches, planCount: total } = payload;

      const out = flagString(args, "out");
      if (out) {
        await mkdir(path.dirname(path.resolve(repo, out)), { recursive: true });
        await writeFile(path.resolve(repo, out), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      }
      emit(args, payload, () =>
        [
          `${total} plans in ${plansDir}, ${payload.undated.length} with no add-commit`,
          `${clusters.length} scopes, ${batches.length} chronological batches (oldest first)`,
          ...clusters
            .slice(0, 20)
            .map((cluster) => `  ${cluster.feature.padEnd(24)} ${String(cluster.plans.length).padStart(3)}  latest ${path.basename(cluster.latest)}`),
          clusters.length > 20 ? `  ... ${clusters.length - 20} smaller clusters` : "",
        ]
          .filter(Boolean)
          .join("\n"));
      return EXIT_OK;
    }

    case "architecture detect": {
      const repo = resolveRepoRoot(args);
      const stacks = flagString(args, "stacks");
      const payload = await detectTopology(repo, {
        stacks: stacks === undefined ? undefined : stacks.split(",").map((entry) => entry.trim()),
      });

      const out = flagString(args, "out");
      if (out) {
        await mkdir(path.dirname(path.resolve(repo, out)), { recursive: true });
        await writeFile(path.resolve(repo, out), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      }

      emit(args, payload, () =>
        [
          `${payload.workspace.members.length} workspace members (${payload.workspace.tool}), ${payload.dependencyEdges.length} internal dependency edges`,
          `stacks detected: ${Object.keys(payload.stacks).join(", ") || "none"}`,
          `${payload.candidateKinds.length} candidate kinds:`,
          ...payload.candidateKinds.map(
            (kind) => `  ${kind.id.padEnd(34)} n=${String(kind.n).padStart(2)}  ${kind.confidence.padEnd(6)} ${kind.signals.join("; ")}`,
          ),
          payload.issues.length > 0 ? `${payload.issues.length} issues` : "",
        ]
          .filter(Boolean)
          .join("\n"));
      return EXIT_OK;
    }

    case "log add": {
      const wiki = resolveWikiRoot(args);
      const kind = (flagString(args, "kind") ?? "Update") as "Update" | "Creation" | "Deprecation";
      const text = args.positionals.join(" ").trim();
      if (text === "") {
        process.stderr.write("log add needs entry text\n");
        return EXIT_ERROR;
      }
      const wrote = await appendLog(wiki, [{ kind, text }]);
      emit(args, { wrote, kind, text }, () => (wrote ? "log updated" : "log unchanged"));
      return EXIT_OK;
    }

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return EXIT_ERROR;
  }
}

const BRIEF_STUB = `# opencodewiki brief

This file is yours, not the tool's. It is never regenerated.

Describe what this wiki should emphasise: which parts of the product matter, which areas are
changing, anything the generator should treat as out of scope. A few sentences is enough — it
steers emphasis, not structure.

The wiki always has two chambers:

- \`functional/\` — how each feature behaves right now, so a change can be planned without
  reconstructing behaviour from source.
- \`architecture/\` — the patterns this repository already follows, so new work lands in
  alignment with them instead of beside them.
`;

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`opencodewiki: ${(error as Error)?.stack ?? String(error)}\n`);
    process.exitCode = EXIT_ERROR;
  });

export { producerActor };
