#!/usr/bin/env python3
"""Generate a parallel comment-cleanup Workflow script.

One agent per file, each applying the SAME comment policy in place and returning
a structured summary. The file list is embedded as a literal in the generated
script (passing large arrays through Workflow `args` does not round-trip
reliably).

Usage:
  python3 build_workflow.py \
    --repo-root /abs/path/to/repo \
    --policy /abs/path/to/merged-policy.md \
    --files-from /abs/path/to/files.txt \
    --out /tmp/comments-cleanup.workflow.js

  --files-from is a text file with one repo-relative path per line (blank lines
  and lines starting with '#' are ignored). Alternatively pass --file repeatedly.
"""
import argparse
import json
import sys


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
        if f not in seen:
            seen.add(f)
            out.append(f)
    return out


TEMPLATE = """\
export const meta = {{
  name: 'comments-cleanup',
  description: 'Apply the comment policy across the listed files — remove obvious/redundant comments, keep quirk/finding/non-obvious-context ones',
  phases: [{{ title: 'Clean', detail: 'one agent per file applies the comment policy in place' }}],
}}

const REPO_ROOT = {repo_root_json}
const POLICY = {policy_json}
const FILES = {files_json}

const SCHEMA = {{
  type: 'object',
  additionalProperties: false,
  required: ['file', 'removed', 'trimmed', 'kept', 'notes'],
  properties: {{
    file: {{ type: 'string', description: 'the repo-relative file path you processed' }},
    removed: {{ type: 'integer', description: 'count of comments fully removed' }},
    trimmed: {{ type: 'integer', description: 'count of comments shortened/edited but kept' }},
    kept: {{ type: 'integer', description: 'count of comments deliberately kept as-is (quirk/finding/non-obvious)' }},
    notes: {{ type: 'string', description: 'one or two sentences: the most notable kept comments (why) and anything ambiguous you decided on. Empty string if nothing notable.' }},
  }},
}}

const files = Array.isArray(args) && args.length ? args : FILES
if (!Array.isArray(files) || files.length === 0) throw new Error('no files to process')

phase('Clean')
log(`Applying comment policy to ${{files.length}} files (one agent each, throttled by the concurrency cap)`)

const results = await parallel(
  files.map((f) => () =>
    agent(
      `${{POLICY}}\\n\\nYou are cleaning comments in EXACTLY ONE file. Change comments only — never code, strings, or JSX text.\\n\\nTARGET FILE (absolute path): ${{REPO_ROOT}}/${{f}}\\n\\nRead that exact path, scan the WHOLE file, apply the policy with the Edit tool on that same file, then return the structured summary. Set "file" to "${{f}}".`,
      {{ label: f, phase: 'Clean', schema: SCHEMA }},
    ),
  ),
)

const ok = results.filter(Boolean)
const removed = ok.reduce((s, r) => s + (r.removed || 0), 0)
const trimmed = ok.reduce((s, r) => s + (r.trimmed || 0), 0)
const kept = ok.reduce((s, r) => s + (r.kept || 0), 0)
const failed = files.length - ok.length

log(`Done: ${{ok.length}}/${{files.length}} processed. removed=${{removed}} trimmed=${{trimmed}} kept=${{kept}} failed=${{failed}}`)

return {{
  filesProcessed: ok.length,
  filesFailed: failed,
  totals: {{ removed, trimmed, kept }},
  perFile: ok
    .filter((r) => (r.removed || 0) + (r.trimmed || 0) > 0 || (r.notes && r.notes.length))
    .map((r) => ({{ file: r.file, removed: r.removed, trimmed: r.trimmed, kept: r.kept, notes: r.notes }})),
}}
"""


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--repo-root", required=True, help="absolute repo root; agents resolve <repo-root>/<file>")
    p.add_argument("--policy", required=True, help="path to the merged policy text (defaults + project overrides)")
    p.add_argument("--files-from", help="text file, one repo-relative path per line")
    p.add_argument("--file", action="append", help="a repo-relative path (repeatable)")
    p.add_argument("--out", required=True, help="where to write the generated .workflow.js")
    args = p.parse_args()

    files = load_files(args)
    if not files:
        sys.exit("error: no files provided (use --files-from or --file)")

    with open(args.policy, encoding="utf-8") as fh:
        policy = fh.read()

    script = TEMPLATE.format(
        repo_root_json=json.dumps(args.repo_root.rstrip("/")),
        policy_json=json.dumps(policy),
        files_json=json.dumps(files),
    )
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(script)

    print(f"wrote {args.out} ({len(files)} files)")
    print(f"launch with the Workflow tool: {{ scriptPath: \"{args.out}\" }}")


if __name__ == "__main__":
    main()
