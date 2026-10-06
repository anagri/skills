#!/usr/bin/env python3
"""Generate the opencodewiki init Workflow script.

The phase graph exists in openwiki too — as nine numbered steps of English prose inside one system
prompt, with nothing enforcing the order and no way to restart at a phase. Emitting it as a script
turns each of those requests into an invariant at no modelling cost, and makes the run resumable.

Phases (this builder covers P0-P3, up to the skeleton gate):

    P1a  scouts        one per area, parallel
    P1b  plan digests  chronological batches                    (parallel with P1a)
    P2   architect     merges everything                        (needs all of it at once)
    P3   critic        independent map, then review             (max 2 rounds, script-enforced)

Models come from `model_policy`: a small enough run goes entirely on the strong model, and a larger
one puts the fan-out on the fast model and keeps the strong one for consolidation. Quota, not
capability, is what makes that split worth having — the fan-out is mostly recognition over a bounded
file set, while the architect and critic reason over the whole repository at once.

The critic round limit is a counter here rather than a sentence in a prompt. "Never a third review"
is the kind of instruction a model under pressure quietly relaxes.

Areas and batches are embedded as literals: large arrays do not round-trip reliably through
Workflow `args`.

Usage:
  python3 build_init_workflow.py \
      --repo-root /abs/path/to/repo \
      --areas-from areas.json \
      --plans-from plans.json \
      --out /tmp/opencodewiki-init.workflow.js
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from model_policy import describe, plan_models  # noqa: E402


def load_json(path, default):
    if not path:
        return default
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"build_init_workflow: could not read {path}: {exc}", file=sys.stderr)
        return default


def normalise_areas(raw):
    """Accept either a bare list of names or a list of {name, paths} objects."""
    areas = []
    for entry in raw or []:
        if isinstance(entry, str):
            areas.append({"name": entry, "paths": [entry]})
        elif isinstance(entry, dict) and entry.get("name"):
            areas.append(
                {"name": entry["name"], "paths": entry.get("paths") or [entry["name"]]}
            )
    return areas


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--wiki", default="opencodewiki")
    parser.add_argument("--areas-from", help="JSON list of areas to scout")
    parser.add_argument("--plans-from", help="JSON from `opencodewiki plans index --json`")
    parser.add_argument("--brief", default="", help="Path to INSTRUCTIONS.md, if any")
    parser.add_argument("--out", required=True)
    parser.add_argument(
        "--max-critic-rounds",
        type=int,
        default=2,
        help="Hard cap. One review plus one verification is the design; more is diminishing.",
    )
    args = parser.parse_args()

    areas = normalise_areas(load_json(args.areas_from, []))
    if not areas:
        print("build_init_workflow: no areas supplied; nothing to scout", file=sys.stderr)
        return 1

    plans = load_json(args.plans_from, {}) or {}
    batches = plans.get("batches") or []
    plans_dir = plans.get("plansDir")

    brief_text = ""
    if args.brief and os.path.exists(args.brief):
        with open(args.brief, encoding="utf-8") as fh:
            brief_text = fh.read().strip()

    # Worst case for consolidation: the architect, plus every critic round and the revision
    # between them. Deciding from the optimistic case would make cost depend on luck.
    consolidation = 1 + (args.max_critic_rounds * 2) - 1
    fanout = len(areas) + len(batches)
    model_fanout, model_consolidation, _, _ = plan_models(fanout, consolidation)
    print(f"  model policy: {describe(fanout, consolidation)}")

    script = TEMPLATE.format(
        model_fanout=json.dumps(model_fanout),
        model_consolidation=json.dumps(model_consolidation),
        repo_root=json.dumps(args.repo_root),
        wiki=json.dumps(args.wiki),
        areas=json.dumps(areas, indent=2),
        batches=json.dumps(batches, indent=2),
        plans_dir=json.dumps(plans_dir),
        brief=json.dumps(brief_text),
        max_rounds=args.max_critic_rounds,
        area_count=len(areas),
        batch_count=len(batches),
    )

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(script)

    print(f"wrote {args.out}")
    print(f"  {len(areas)} areas to scout, {len(batches)} plan batches")
    return 0


TEMPLATE = r"""export const meta = {{
  name: 'opencodewiki-init',
  description: 'Map the repository, digest plan intent, design the wiki skeleton, and have it independently critiqued',
  phases: [
    {{ title: 'Map', detail: 'one scout per area, plus chronological plan digests' }},
    {{ title: 'Skeleton', detail: 'merge every brief and digest into the page tree' }},
    {{ title: 'Critique', detail: 'independent coverage review, max {max_rounds} rounds' }},
  ],
}}

const REPO = {repo_root}
const WIKI = {wiki}
const AREAS = {areas}
const PLAN_BATCHES = {batches}
const PLANS_DIR = {plans_dir}
const BRIEF = {brief}
const MAX_CRITIC_ROUNDS = {max_rounds}
const MODEL_FANOUT = {model_fanout}
const MODEL_CONSOLIDATION = {model_consolidation}

const briefBlock = BRIEF
  ? `\n\nThe repository owner's brief for this wiki — it steers emphasis, not structure:\n${{BRIEF}}`
  : ''

phase('Map')

// Scouts and digesters are independent, so they run together. Both feed the architect, which is
// the barrier: it cannot start until every brief exists.
const mapWork = [
  ...AREAS.map((area) => () =>
    agent(
      `Map the area "${{area.name}}" of the repository at ${{REPO}}.

Paths in scope:
${{area.paths.map((p) => `- ${{p}}`).join('\n')}}

Read implementation, not just manifests. Follow at least one call in each direction across a
boundary. When you name a test, know what behaviour it proves. Count conventions rather than
asserting them.${{briefBlock}}

Return the evidence brief as your final message.`,
      {{ label: `scout:${{area.name}}`, phase: 'Map', agentType: 'opencodewiki:repo-scout', model: MODEL_FANOUT }},
    ).then((brief) => ({{ kind: 'brief', name: area.name, text: brief }})),
  ),
  ...PLAN_BATCHES.map((batch) => () =>
    agent(
      `Distil this chronological batch of plans from ${{REPO}}/${{PLANS_DIR}}.

Batch ${{batch.id}}, covering ${{batch.from}} to ${{batch.to}}:
${{batch.files.map((f) => `- ${{f}}`).join('\n')}}

These are proposals written before the work. Report what they say as intent, never as current
behaviour, and record a rejected alternative only where a plan states the rejection outright.

Return JSON only.`,
      {{ label: `plans:${{batch.id}}`, phase: 'Map', agentType: 'opencodewiki:plan-digester', model: MODEL_FANOUT }},
    ).then((digest) => ({{ kind: 'digest', id: batch.id, text: digest }})),
  ),
]

const mapped = (await parallel(mapWork)).filter(Boolean)
const briefs = mapped.filter((r) => r.kind === 'brief')
const digests = mapped.filter((r) => r.kind === 'digest')
log(`${{briefs.length}}/${{AREAS.length}} area briefs, ${{digests.length}}/${{PLAN_BATCHES.length}} plan digests`)

if (briefs.length === 0) {{
  return {{ ok: false, reason: 'no area briefs were produced; nothing to build a skeleton from' }}
}}
if (briefs.length < AREAS.length) {{
  // Say what was dropped. A silently partial map reads exactly like a complete one.
  const missing = AREAS.map((a) => a.name).filter((n) => !briefs.some((b) => b.name === n))
  log(`WARNING incomplete map, missing areas: ${{missing.join(', ')}}`)
}}

const briefBundle = briefs.map((b) => `\n\n===== AREA BRIEF: ${{b.name}} =====\n${{b.text}}`).join('')
const digestBundle = digests.length
  ? digests
      .map((d) => `\n\n===== PLAN DIGEST ${{d.id}} (older batches first) =====\n${{d.text}}`)
      .join('')
  : '\n\n(No plans directory configured for this repository.)'

phase('Skeleton')

let skeleton = await agent(
  `Design the wiki skeleton for the repository at ${{REPO}}. Write it to ${{WIKI}}/.work/skeleton.json
and ${{WIKI}}/.work/skeleton.md.

Two chambers, always: functional/ for how features behave today, architecture/ for the patterns the
repository already follows. Do not mirror the source tree.${{briefBlock}}

Plan digests record intent, not behaviour. Use them to explain *why*, and to populate each page's
plans list — never to assert what the code does.${{briefBundle}}${{digestBundle}}`,
  {{ label: 'architect:skeleton', phase: 'Skeleton', agentType: 'opencodewiki:wiki-architect', model: MODEL_CONSOLIDATION }},
)

phase('Critique')

let ledger = ''
let passed = false

for (let round = 1; round <= MAX_CRITIC_ROUNDS; round += 1) {{
  const isFirst = round === 1
  const review = await agent(
    isFirst
      ? `Review the proposed wiki skeleton at ${{REPO}}/${{WIKI}}/.work/skeleton.md.

Map the repository at ${{REPO}} yourself BEFORE reading the skeleton. Return every material gap in
this one response — there is exactly one follow-up review and it verifies your requests rather than
collecting new ones.`
      : `Verify your prior requests against the revised skeleton at
${{REPO}}/${{WIKI}}/.work/skeleton.md.

Your previous review:
${{ledger}}

What the architect did in response:
${{skeleton}}

Verify each prior request against the repository. Do not accept an assertion that something was
fixed. Raise a new request only for a regression the revision introduced.`,
    {{ label: `critic:round-${{round}}`, phase: 'Critique', agentType: 'opencodewiki:skeleton-critic', model: MODEL_CONSOLIDATION }},
  )

  ledger = review ?? ''
  passed = /status="PASS"/.test(ledger)
  if (passed) {{
    log(`critic PASS on round ${{round}}`)
    break
  }}
  if (round === MAX_CRITIC_ROUNDS) {{
    log(`critic still requesting changes after ${{MAX_CRITIC_ROUNDS}} rounds; unresolved items carry forward`)
    break
  }}

  skeleton = await agent(
    `Revise the skeleton at ${{REPO}}/${{WIKI}}/.work/skeleton.json and skeleton.md to resolve every
request below. Rewrite both files.

${{ledger}}

Resolve each item concretely — add the missing page, sharpen the vague purpose, assign the missing
evidence. If you believe a request is wrong, say why in your summary rather than silently ignoring
it.`,
    {{ label: `architect:revision-${{round}}`, phase: 'Critique', agentType: 'opencodewiki:wiki-architect', model: MODEL_CONSOLIDATION }},
  )
}}

return {{
  ok: true,
  criticPassed: passed,
  areasMapped: briefs.length,
  areasExpected: AREAS.length,
  planDigests: digests.length,
  ledger,
}}
"""


if __name__ == "__main__":
    sys.exit(main())
