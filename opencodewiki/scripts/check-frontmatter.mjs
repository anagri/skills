#!/usr/bin/env node
/**
 * PostToolUse hook: report OKF conformance problems the moment a wiki page is written.
 *
 * This is the native equivalent of the middleware openwiki wrapped around every tool call, and it
 * is strictly better in one way: it costs no prompt tokens and fires regardless of what the model
 * believes it is doing. openwiki spends roughly forty-five lines of system prompt on front-matter
 * rules and still only gets probabilistic compliance.
 *
 * Safety comes first. This runs on *every* Write and Edit in the session, most of which have
 * nothing to do with a wiki. Every failure path exits 0 with no output: a hook that breaks someone's
 * editing session to complain about markdown metadata is far worse than one that occasionally stays
 * quiet. Silence is always an acceptable answer here.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Give up rather than hold up a write. */
const TIMEOUT_MS = 5000;

function quit() {
  process.exit(0);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Walks up from the edited file looking for a wiki that contains it. */
function findWikiRoot(filePath) {
  let dir = path.dirname(path.resolve(filePath));
  const { root } = path.parse(dir);
  while (true) {
    if (path.basename(dir) === "opencodewiki" && existsSync(path.join(dir, ".state.json"))) {
      return dir;
    }
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

async function main() {
  const raw = await readStdin().catch(() => "");
  if (raw.trim() === "") quit();

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    quit();
  }

  const input = payload?.tool_input ?? payload?.toolInput ?? {};
  const filePath = input.file_path ?? input.filePath ?? input.path;
  if (typeof filePath !== "string" || !filePath.toLowerCase().endsWith(".md")) quit();

  // Reserved documents are generated; complaining about them would be noise.
  const base = path.basename(filePath);
  if (base === "index.md" || base === "log.md" || base === "INSTRUCTIONS.md") quit();

  const wikiRoot = findWikiRoot(filePath);
  if (wikiRoot === null) quit();

  let stdout;
  try {
    ({ stdout } = await run("opencodewiki", ["okf", "validate", "--wiki", wikiRoot, "--json"], {
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    // Exit code 2 means findings, which is exactly the case worth reporting.
    stdout = error?.stdout ?? "";
    if (stdout.trim() === "") quit();
  }

  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    quit();
  }

  const relative = path.relative(wikiRoot, path.resolve(filePath));
  const mine = (report.issues ?? []).filter(
    (issue) => issue.file === relative && issue.severity === "error",
  );
  if (mine.length === 0) quit();

  const lines = mine.slice(0, 5).map((issue) => `- ${issue.message}`);
  process.stdout.write(
    JSON.stringify({
      systemMessage: [
        `OKF front matter in ${relative} is not conformant:`,
        ...lines,
        "Fix it in the page, or run `opencodewiki fmt` to repair what can be repaired deterministically.",
      ].join("\n"),
    }),
  );
  process.exit(0);
}

main().catch(quit);
