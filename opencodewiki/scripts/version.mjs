#!/usr/bin/env node
/**
 * Reports which build of the plugin is actually loaded, and whether the CLI beside it is compatible.
 *
 * A version number alone cannot answer "did my reload work" — the number only changes when someone
 * remembers to bump it, and the whole reason for asking is usually that something did *not* update
 * as expected. So this also fingerprints the plugin's own files: two builds at the same version but
 * different content produce different fingerprints, which is the case a version string silently
 * hides.
 *
 * Resolves its own location rather than trusting CLAUDE_PLUGIN_ROOT, so it reports the build it is
 * part of even when invoked oddly.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Files that make up the plugin's behaviour. Anything else is incidental. */
const TRACKED = /\.(md|json|mjs|py|js)$/;
const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".git"]);

async function collect(dir, acc = []) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".claude-plugin") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collect(full, acc);
    } else if (TRACKED.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

async function fingerprint() {
  const files = (await collect(PLUGIN_ROOT)).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(PLUGIN_ROOT, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return { digest: hash.digest("hex").slice(0, 12), count: files.length };
}

async function newestMtime() {
  const files = await collect(PLUGIN_ROOT);
  let newest = 0;
  for (const file of files) {
    const info = await stat(file).catch(() => null);
    if (info && info.mtimeMs > newest) newest = info.mtimeMs;
  }
  return newest ? new Date(newest).toISOString() : null;
}

async function cliVersion() {
  try {
    const { stdout } = await run("opencodewiki", ["--version", "--json"], { timeout: 10000 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function main() {
  const manifestPath = path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json");
  let manifest = {};
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    process.stdout.write(`could not read ${manifestPath}\n`);
    process.exitCode = 1;
    return;
  }

  const [print, cli, mtime] = await Promise.all([fingerprint(), cliVersion(), newestMtime()]);
  const asJson = process.argv.includes("--json");

  const payload = {
    plugin: {
      name: manifest.name,
      version: manifest.version,
      fingerprint: print.digest,
      files: print.count,
      newestFile: mtime,
      root: PLUGIN_ROOT,
    },
    cli: cli
      ? { version: cli.version, okfVersion: cli.okfVersion, formatVersion: cli.formatVersion }
      : null,
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const lines = [
    `plugin       ${manifest.name} ${manifest.version}`,
    `fingerprint  ${print.digest}  (${print.count} files)`,
    `newest file  ${mtime ?? "unknown"}`,
    `loaded from  ${PLUGIN_ROOT}`,
    cli
      ? `cli          opencodewiki ${cli.version} (OKF ${cli.okfVersion}, state format ${cli.formatVersion})`
      : `cli          NOT FOUND — run: npm i -g opencodewiki`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);

  if (!cli) process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`opencodewiki version check failed: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
