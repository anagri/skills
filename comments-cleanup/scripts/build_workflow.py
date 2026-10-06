#!/usr/bin/env python3
"""Generate a batched comment-cleanup Workflow script.

The unit of work is a *batch of files that share a common ancestor folder*, not a
single file. We batch because comment cleanup is judgment-heavy but cheap per
comment: spinning up one agent per file pays the per-agent context/setup cost
hundreds of times over, while a batch of files from the same folder shares
project context and amortizes that cost. Locality matters — files in the same
directory tend to share conventions, so judging them in one context keeps the bar
consistent *and* is far more token-efficient.

Batching rules:
  - Files are grouped by common ancestor with affinity: files in the same folder
    stay together.
  - Target batch size is ~30 files, kept within a 20-50 range. Small sibling
    folders are merged under a shared ancestor until a batch reaches the floor.
  - A single folder larger than the ceiling is split into ~30-file chunks so no
    one agent gets an oversized context (which risks truncation / dropped files).

The batches are embedded as a literal in the generated script (passing large
arrays through Workflow `args` does not round-trip reliably).

Usage:
  python3 build_workflow.py \
    --repo-root /abs/path/to/repo \
    --policy /abs/path/to/merged-policy.md \
    --files-from /abs/path/to/files.txt \
    --out /tmp/comments-cleanup.workflow.js

  --files-from is a text file with one repo-relative path per line (blank lines
  and lines starting with '#' are ignored). Alternatively pass --file repeatedly.

Tuning (rarely needed):
  --target 30   ideal files per batch
  --min 20      batch floor (merge small folders up to reach this)
  --max 50      batch ceiling (split a folder above this)
"""
import argparse
import json
import os
import sys
from collections import defaultdict


def load_files(args):
    files = list(args.file or [])
    if args.files_from:
        with open(args.files_from, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#"):
                    files.append(line)
    # de-dup, preserve order
    seen, out = set(), []
    for f in files:
        f = f.lstrip("./")
        if f and f not in seen:
            seen.add(f)
            out.append(f)
    return out


def parent_of(path):
    """Repo-relative parent dir of a file ('' for repo root)."""
    return os.path.dirname(path)


def chunk(seq, size):
    """Split into evenly-balanced chunks of about `size`.

    Naive fixed-stride slicing leaves a tiny remainder (65 @ 30 -> 30,30,5).
    Instead pick a chunk count that makes the pieces as even as possible, so an
    oversized folder yields e.g. 33,32 rather than 30,30,5 — no batch lands far
    below the floor just because of where the stride happened to fall.
    """
    n = len(seq)
    if n <= size:
        return [list(seq)]
    parts = max(1, round(n / size))
    base, extra = divmod(n, parts)
    out, i = [], 0
    for k in range(parts):
        step = base + (1 if k < extra else 0)
        out.append(list(seq[i : i + step]))
        i += step
    return out


def batch_files(files, target, lo, hi):
    """Group files into batches that share an ancestor folder.

    Strategy:
      1. Bucket files by their immediate parent folder.
      2. A folder bigger than `hi` is split into ~`target`-sized chunks (locality
         fully preserved — every chunk is from the same folder).
      3. Folders at or under `hi` become candidate batches; small ones are then
         merged with siblings under a shared ancestor until each merged batch
         reaches at least `lo` (or there's nothing left to merge with).

    Returns a list of batches, where each batch is a list of repo-relative paths.
    """
    by_dir = defaultdict(list)
    for f in files:
        by_dir[parent_of(f)].append(f)
    for d in by_dir:
        by_dir[d].sort()

    big_batches = []          # already-sized batches from large folders
    small = {}                # dir -> files, for folders that need merging

    for d, fs in by_dir.items():
        if len(fs) > hi:
            big_batches.extend(chunk(fs, target))
        else:
            small[d] = fs

    # Merge small folders bottom-up by shared ancestor until each batch >= lo.
    # We process deepest dirs first so a folder prefers merging with its closest
    # kin before rolling up to a broader ancestor.
    merged = _merge_small(small, lo, hi)

    batches = big_batches + merged
    # Stable order: by the first file in each batch.
    batches.sort(key=lambda b: b[0])
    return batches


def _merge_small(small, lo, hi):
    """Merge small per-folder file groups under common ancestors toward `lo`.

    `small` maps dir -> list[files]. We repeatedly take the deepest under-floor
    group and fold it into the bucket of its parent ancestor, accumulating files
    until the bucket reaches the floor or we run out of ancestors to climb.
    """
    # Accumulator keyed by the ancestor a group has been folded up to.
    buckets = {d: list(fs) for d, fs in small.items()}
    done = []

    # Deepest first so leaves merge into their parents before parents roll up.
    pending = sorted(buckets.keys(), key=lambda d: (-d.count("/") if d else 1, d))

    # Re-derive ordering each pass since keys change as we merge.
    changed = True
    while changed:
        changed = False
        # Snapshot of dirs still in play, deepest first.
        dirs = sorted(buckets.keys(), key=lambda d: (-(d.count("/") + (1 if d else 0)), d))
        for d in dirs:
            if d not in buckets:
                continue
            fs = buckets[d]
            if len(fs) >= lo:
                continue
            # Try to fold this under-floor group into an ancestor bucket.
            anc = parent_of(d) if d else None
            if anc is None:
                # Top level and still small: nothing to merge with; emit as-is.
                continue
            # Find an existing bucket that is `anc` or an ancestor of `d`.
            target_key = _find_ancestor_bucket(buckets, d)
            if target_key is None:
                # No ancestor bucket exists yet; promote this group to its parent.
                buckets[anc] = buckets.get(anc, []) + fs
                del buckets[d]
                changed = True
            elif target_key != d:
                buckets[target_key].extend(fs)
                del buckets[d]
                changed = True

    # Anything that ended up over the ceiling (from aggressive merging) gets
    # chunked back down to ~target; the rest are emitted as their own batch.
    out = []
    for d, fs in buckets.items():
        fs = sorted(fs)
        if len(fs) > hi:
            out.extend(chunk(fs, max(1, (lo + hi) // 2)))
        else:
            out.append(fs)
    out.extend(done)
    return [b for b in out if b]


def _find_ancestor_bucket(buckets, d):
    """Return the deepest existing bucket key that is a strict ancestor of d."""
    best = None
    for key in buckets:
        if key == d:
            continue
        if key == "" or d.startswith(key + "/"):
            if best is None or len(key) > len(best):
                best = key
    return best


TEMPLATE = """\
export const meta = {{
  name: 'comments-cleanup',
  description: 'Apply the comment policy across batches of code files grouped by folder — remove obvious/redundant comments, keep quirk/finding/non-obvious-context ones',
  phases: [{{ title: 'Clean', detail: 'one agent per folder-batch applies the comment policy in place' }}],
}}

const REPO_ROOT = {repo_root_json}
const POLICY = {policy_json}
const BATCHES = {batches_json}

const batches = Array.isArray(args) && args.length ? args : BATCHES
if (!Array.isArray(batches) || batches.length === 0) throw new Error('no batches to process')

phase('Clean')
const totalFiles = batches.reduce((s, b) => s + b.length, 0)
log(`Cleaning comments in ${{totalFiles}} files across ${{batches.length}} folder-batches (one agent per batch, throttled by the concurrency cap)`)

const results = await parallel(
  batches.map((batch, i) => () =>
    agent(
      `${{POLICY}}\\n\\n` +
      `You are cleaning comments in a BATCH of files that live near each other in the tree. ` +
      `Change comments only — never code, strings, or JSX text.\\n\\n` +
      `REPO ROOT (absolute): ${{REPO_ROOT}}\\n` +
      `FILES IN THIS BATCH (repo-relative; read each as REPO_ROOT + '/' + path):\\n` +
      batch.map((f) => `  - ${{f}}`).join('\\n') +
      `\\n\\nFor EACH file: first confirm it is a CODE file (a real programming-language source file). ` +
      `If a path is actually a docs/text/data file (markdown, plain .txt, JSON/YAML data, etc.) where the "comments" are really content, SKIP it untouched — this policy is about code comments only. ` +
      `For each genuine code file, read the whole file, apply the policy with the Edit tool in place, and move on. ` +
      `Process every file in the batch.`,
      {{ label: `batch ${{i + 1}}/${{batches.length}} (${{batch.length}} files)`, phase: 'Clean' }},
    ),
  ),
)

const ok = results.filter(Boolean).length
const failed = batches.length - ok
log(`Done: ${{ok}}/${{batches.length}} batches completed${{failed ? `, ${{failed}} failed` : ''}}.`)

return {{ batches: batches.length, batchesCompleted: ok, batchesFailed: failed, totalFiles }}
"""


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--repo-root", required=True, help="absolute repo root; agents resolve <repo-root>/<file>")
    p.add_argument("--policy", required=True, help="path to the merged policy text (defaults + project overrides)")
    p.add_argument("--files-from", help="text file, one repo-relative path per line")
    p.add_argument("--file", action="append", help="a repo-relative path (repeatable)")
    p.add_argument("--out", required=True, help="where to write the generated .workflow.js")
    p.add_argument("--target", type=int, default=30, help="ideal files per batch (default 30)")
    p.add_argument("--min", type=int, default=20, dest="lo", help="batch floor — merge small folders up to this (default 20)")
    p.add_argument("--max", type=int, default=50, dest="hi", help="batch ceiling — split folders above this (default 50)")
    args = p.parse_args()

    if not (0 < args.lo <= args.target <= args.hi):
        sys.exit("error: require 0 < --min <= --target <= --max")

    files = load_files(args)
    if not files:
        sys.exit("error: no files provided (use --files-from or --file)")

    with open(args.policy, encoding="utf-8") as fh:
        policy = fh.read()

    batches = batch_files(files, args.target, args.lo, args.hi)

    script = TEMPLATE.format(
        repo_root_json=json.dumps(args.repo_root.rstrip("/")),
        policy_json=json.dumps(policy),
        batches_json=json.dumps(batches),
    )
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(script)

    sizes = [len(b) for b in batches]
    print(f"wrote {args.out}")
    print(f"  {len(files)} files -> {len(batches)} batches "
          f"(sizes: min={min(sizes)} max={max(sizes)} target~{args.target})")
    print(f"launch with the Workflow tool: {{ scriptPath: \"{args.out}\" }}")


if __name__ == "__main__":
    main()
