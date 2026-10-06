#!/usr/bin/env python3
"""Generate the opencodewiki page-authoring Workflow script.

Runs after the skeleton gate. One agent per page, then the quickstart once every page exists.

The one-agent-per-page shape is a structural fix, not a preference. A single agent writing a whole
wiki hits output truncation and then spends the rest of the run rewriting pages it had already
written — visible in real openwiki logs as repeated "the write was truncated, let me rewrite fully"
cycles, one of which consumed the run entirely and ended `status: interrupted`. Each page here is
small enough that truncation stops being a failure mode, and a page that does fail costs one page.

Pages are independent — each writes its own file — so no worktree isolation is needed.

Quickstart is deliberately last and alone: it routes to pages, so it cannot be written until they
exist, and it needs to read what they actually say rather than what the skeleton predicted.

Usage:
  python3 build_author_workflow.py \
      --repo-root /abs/path/to/repo \
      --skeleton /abs/path/to/opencodewiki/.work/skeleton.json \
      --out /tmp/opencodewiki-author.workflow.js
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model_policy import describe, plan_models  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--wiki", default="opencodewiki")
    parser.add_argument("--skeleton", required=True)
    parser.add_argument("--brief", default="")
    parser.add_argument("--out", required=True)
    parser.add_argument(
        "--only",
        action="append",
        help="Write only these page paths. Repeatable; used to retry a failed subset.",
    )
    parser.add_argument(
        "--skip-quickstart",
        action="store_true",
        help="Author pages without regenerating the entrypoint.",
    )
    parser.add_argument(
        "--architecture-model",
        help=(
            "Override the model for architecture pages only. Those need breadth sampling across "
            "many files to tell a convention from an accident, which is harder than the depth "
            "reading a functional page needs."
        ),
    )
    args = parser.parse_args()

    try:
        with open(args.skeleton, encoding="utf-8") as fh:
            skeleton = json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"build_author_workflow: cannot read skeleton: {exc}", file=sys.stderr)
        return 1

    pages = skeleton.get("pages") or []
    if args.only:
        wanted = set(args.only)
        pages = [page for page in pages if page.get("path") in wanted]
    if not pages:
        print("build_author_workflow: no pages to write", file=sys.stderr)
        return 1

    deferred = skeleton.get("deferred") or []

    brief_text = ""
    if args.brief and os.path.exists(args.brief):
        with open(args.brief, encoding="utf-8") as fh:
            brief_text = fh.read().strip()

    consolidation = 0 if args.skip_quickstart else 1
    model_fanout, model_consolidation, all_strong, _ = plan_models(len(pages), consolidation)
    architecture_model = args.architecture_model or model_fanout

    print(f"  model policy: {describe(len(pages), consolidation)}")
    if architecture_model != model_fanout:
        print(f"  architecture pages overridden to {architecture_model}")

    script = TEMPLATE.format(
        repo_root=json.dumps(args.repo_root),
        wiki=json.dumps(args.wiki),
        pages=json.dumps(pages, indent=2),
        deferred=json.dumps(deferred, indent=2),
        brief=json.dumps(brief_text),
        model_page=json.dumps(model_fanout),
        model_architecture=json.dumps(architecture_model),
        model_quickstart=json.dumps(model_consolidation),
        write_quickstart=json.dumps(not args.skip_quickstart),
    )

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(script)

    functional = sum(1 for page in pages if page.get("chamber") == "functional")
    print(f"wrote {args.out}")
    print(f"  {len(pages)} pages ({functional} functional, {len(pages) - functional} architecture)")
    return 0


TEMPLATE = r"""export const meta = {{
  name: 'opencodewiki-author',
  description: 'Write every wiki page from its skeleton entry, then the entrypoint and its routing table',
  phases: [
    {{ title: 'Author', detail: 'one agent per page, each verifying its own evidence' }},
    {{ title: 'Quickstart', detail: 'entrypoint and task-routing table, once every page exists' }},
  ],
}}

const REPO = {repo_root}
const WIKI = {wiki}
const PAGES = {pages}
const DEFERRED = {deferred}
const BRIEF = {brief}
const MODEL_PAGE = {model_page}
const MODEL_ARCHITECTURE = {model_architecture}
const MODEL_QUICKSTART = {model_quickstart}
const WRITE_QUICKSTART = {write_quickstart}

const briefBlock = BRIEF
  ? `\n\nThe repository owner's brief — it steers emphasis, not structure:\n${{BRIEF}}`
  : ''

const list = (label, items) =>
  items && items.length ? `\n${{label}}:\n${{items.map((i) => `- ${{i}}`).join('\n')}}` : ''

// One rules block per chamber, injected into the page prompt before the writer starts. Prose in the
// shared contract is advisory and was routinely outvoted by chamber-agnostic instructions elsewhere.
const FUNCTIONAL_RULES = `

FUNCTIONAL CHAMBER — hard rules, enforced mechanically by 'opencodewiki okf validate' on write.

- This page describes the PRODUCT, not the system. It explains what a person can do and the value
  they get. Its unit is a user capability — never a module, a screen, or a subsystem.
- Before every sentence ask: would this make sense to someone who has never seen the code, and does
  it describe something a person can do or experience? If not, DELETE IT.
- Write in the user's language. NO file names, NO function names, NO endpoints, NO table names, NO
  framework or vendor names, NO code blocks. A person does not care that something is a queue.
- You may point at roughly where something lives, but only at app/package/folder granularity and at
  most FIVE times across the whole page, front matter and prose counted together. Plan sources do
  not count. There is no minimum — a page naming no implementation at all is good functional writing.
- OMIT the opencodewiki.symbols key entirely. <= 150 lines of prose. <= 1 diagram.
- Only write a capability you have CONFIRMED a person can actually perform. An imagined capability is
  worse than a missing one. If you cannot confirm it, leave it out and say so in your report.
- State limits plainly rather than hiding them: what happens when something is empty, slow,
  unavailable or refused is part of the capability.

Section shape:
# <Capability, named as a person would say it>
**As a <who>, I want to <do X>, so that <value Y>.**
one paragraph in plain language: what this part of the product is for
## What you can do      — 3-8 things a person actually does, phrased as their actions
## What to expect       — the rules and limits they notice; what it deliberately does not do
## Where this sits      — what they were doing before, and where they go next
`

const ARCHITECTURE_RULES = `

ARCHITECTURE CHAMBER — hard rules, mechanically enforced by 'opencodewiki okf validate' on write:

- This page's job is PLACEMENT: given "add an X", what kind of thing X is, where it goes, what it
  reuses, what it must not do, and which ONE existing thing to copy. It is about modules and
  components — their responsibilities and interactions — not what the code currently does.
- Before every sentence ask: could a parser reading HEAD tonight produce this? If yes, DELETE IT.
  Symbol lists, handler tables, call sequences, dependency inventories and counts are what a
  code-graph tool answers live and correctly. Write what a human decided, why, and what it cost.
- <= 180 lines total. <= 10 sources, MODULE-GRANULAR (a package root, a subtree with a trailing
  slash, a root artifact, or a plan) — never an individual source file.
- OMIT opencodewiki.symbols entirely. <= 3 invariants, each surviving a rewrite of its module,
  owned by this page's boundary, and constraining code that does not exist yet.
- <= 1 diagram, and every label must name something that exists when no code is running.
  sequenceDiagram is banned. No counts, no reproduced source, no line numbers.
- 8-12 inline code references is a FLOOR as well as a ceiling. Naming src/adapters/ is required;
  enumerating its twelve files is banned.
- State a fact only if this page owns it. Otherwise one sentence plus a link.
- The page must carry at least one explicitly rejected alternative OR one trade-off with a named cost.
`

phase('Author')

const written = await parallel(
  PAGES.map((page) => () =>
    agent(
      `Write the wiki page ${{WIKI}}/${{page.path}} in the repository at ${{REPO}}.

Chamber: ${{page.chamber}}
Title: ${{page.title}}
OKF type: ${{page.type || 'choose a descriptive kind'}}
Diagram: ${{page.diagram || 'none'}}

What this page must let a reader do:
${{page.purpose}}
${{list('Source paths assigned (a starting point, not a citation list)', page.source_paths)}}
${{page.chamber === 'architecture' ? '' : list('Symbols the page must explain', page.symbols)}}
${{list('Focused tests', page.test_paths)}}
${{list('Plans carrying the intent behind this (intent only, never behaviour)', page.plans)}}
${{
  page.links && page.links.length
    ? `\nLinks this page should make, and why each matters:\n${{page.links
        .map((l) => `- ${{l.to}} — ${{l.why}}`)
        .join('\n')}}`
    : ''
}}${{briefBlock}}${{page.chamber === 'architecture' ? ARCHITECTURE_RULES : FUNCTIONAL_RULES}}

Read the code before writing. Verify every path and symbol exists at HEAD. Write the file, then
report what you read, anything in this brief that turned out wrong, and any gap you left.`,
      {{
        label: `page:${{page.path}}`,
        phase: 'Author',
        agentType: 'opencodewiki:page-writer',
        model: page.chamber === 'architecture' ? MODEL_ARCHITECTURE : MODEL_PAGE,
      }},
    ).then((report) => ({{ path: page.path, report }})),
  ),
)

const ok = written.filter(Boolean)
const failed = PAGES.filter((page) => !ok.some((w) => w.path === page.path))
log(`${{ok.length}}/${{PAGES.length}} pages written`)
if (failed.length) {{
  // Name them. A partial wiki that reports success is the failure this design exists to prevent.
  log(`WARNING these pages were not written: ${{failed.map((p) => p.path).join(', ')}}`)
}}

if (!WRITE_QUICKSTART) {{
  return {{ ok: failed.length === 0, written: ok.length, failed: failed.map((p) => p.path) }}
}}

phase('Quickstart')

const quickstart = await agent(
  `Write ${{WIKI}}/quickstart.md for the repository at ${{REPO}}.

Every other page now exists. Read them — you are routing to what they actually contain, not to what
was planned.

Pages in the wiki:
${{PAGES.map((p) => `- ${{p.path}} (${{p.chamber}}) — ${{p.title}}`).join('\n')}}
${{
  DEFERRED.length
    ? `\nDeferred during planning; carry each into the Backlog with its reason:\n${{DEFERRED.map(
        (d) => `- ${{d.area}} — ${{d.reason}}`,
      ).join('\n')}}`
    : ''
}}${{briefBlock}}

The routing table is the point. Every cell must resolve against HEAD.`,
  {{
    label: 'quickstart',
    phase: 'Quickstart',
    agentType: 'opencodewiki:quickstart-writer',
    model: MODEL_QUICKSTART,
  }},
)

return {{
  ok: failed.length === 0,
  written: ok.length,
  failed: failed.map((p) => p.path),
  quickstart: quickstart ? 'written' : 'failed',
}}
"""


if __name__ == "__main__":
    sys.exit(main())
