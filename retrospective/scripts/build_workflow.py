#!/usr/bin/env python3
"""Emit the extraction + consolidation Workflow for one collected retrospective window.

Reads what collect_window.py actually produced and sizes the fan-out to it, so the agent count
tracks the window rather than a guess. Extraction runs on a cheap model (one slice each); a single
strong model consolidates.

    python3 build_workflow.py --session <session-dir> --profile <retro-root>/profile.md \
        --out /tmp/retro-workflow.js

Then invoke the Workflow tool with that script path.

Two invariants are compiled into the prompts because both have already failed in practice:
  * extraction is FACTS ONLY -- the moment an agent writes "because" it has crossed into stage 3
  * totals come from counts.json -- an agent seeing one batch cannot produce a window total, and
    three agents asked to measure one property over disjoint slices returned three different answers
"""
import argparse
import json
import os
import re

EXTRACT_MODEL = "haiku"
CONSOLIDATE_MODEL = "opus"
# Roughly one extraction slice; keeps an agent's input far below its context so it can reason.
TARGET_SLICE_TOKENS = 15000


CI_BLOCK_EMPTY = "[]"

CI_BLOCK = """[() =>
  agent(
    CONTEXT + `\\n\\nRead ${RAW}/ci-runs.json and cite the totals from ${RAW}/counts.json.\\n\\n` +
    `Establish: when failures cluster (dates and workflows); the LONGEST stretch with no run at all ` +
    `and which commits it covers; and any streak of consecutive failures, noting whether a later run ` +
    `went green.\\n\\n` +
    `A period with commits but no runs is one of the most informative shapes a retro can find — ` +
    `report it precisely and do NOT theorise about why. Run logs may have expired; work from metadata.`,
    { label: 'ci:runs', phase: 'Extract', model: EXTRACT_MODEL_ID, effort: 'medium', schema: CI_SCHEMA },
  ),
]"""


def js(s):
    return json.dumps(s)


def build(session, profile_text, extract_model, consolidate_model):
    raw = os.path.join(session, "01-evidence", "_raw")
    counts = json.load(open(os.path.join(raw, "counts.json")))

    days = sorted(counts.get("prompts_per_day", {}))
    batches = sorted(f for f in os.listdir(raw) if f.startswith("commits-batch-"))
    has_ci = os.path.exists(os.path.join(raw, "ci-runs.json"))
    plans = counts.get("plans", 0)

    # Group days so each prompt agent gets a comparable amount of text rather than one agent per
    # day -- a quiet day and a 100-prompt day are not the same unit of work.
    per_day = counts.get("prompts_per_day", {})
    blocks, cur, cur_n = [], [], 0
    budget = max(60, int(sum(per_day.values()) / max(1, min(4, len(days)))))
    for d in days:
        cur.append(d)
        cur_n += per_day[d]
        if cur_n >= budget:
            blocks.append(cur)
            cur, cur_n = [], 0
    if cur:
        blocks.append(cur)

    plan_slices = max(1, min(4, (plans + 11) // 12)) if plans else 0
    # Assign each slice its literal file list HERE. Telling an agent "take position i of every N"
    # makes it compute its own membership, and it drifts: a declared frame stops matching the files
    # actually opened, and plans go unread with nothing failing.
    plan_paths = []
    pm = os.path.join(raw, "plans.md")
    if os.path.exists(pm):
        for line in open(pm, encoding="utf-8"):
            m = re.match(r"^\|\s*\[?`([^`]+)`", line)
            if m:
                plan_paths.append(m.group(1))
    plan_slice_files = [plan_paths[i::plan_slices] for i in range(plan_slices)] if plan_slices else []
    plan_slice_files_js = json.dumps(plan_slice_files)
    ci_block = CI_BLOCK if has_ci else CI_BLOCK_EMPTY

    return f"""export const meta = {{
  name: 'retro-extract',
  description: 'Retrospective stage 2: extract evidence, then consolidate into 02-data.md',
  phases: [
    {{ title: 'Extract', detail: 'cheap agents, one slice each, facts only' }},
    {{ title: 'Consolidate', detail: 'one strong agent writes 02-data.md' }},
  ],
}}

const SESSION = {js(session)}
const RAW = SESSION + '/01-evidence/_raw'

const PROFILE = {js(profile_text)}

const CONTEXT = `
CONTEXT — you are gathering evidence for a software retrospective.

${{PROFILE}}

This is STAGE 2: FACTS ONLY. Report what the artifacts show. Do NOT diagnose, do NOT recommend, do
NOT write "because". If you are tempted to explain WHY something happened, record WHAT happened and
move on — a later agent interprets, and a human is interviewed before any conclusion is trusted.

COUNTING RULE: ${{RAW}}/counts.json holds machine-counted totals. CITE THOSE. Never tally across your
own slice and report it as a window total — you cannot see the other slices. Three agents asked to
measure one property over disjoint slices once returned three different answers, and all three were
reported as fact.

A ZERO IS A CLAIM. If something reports zero — bytes, runs, commits — say so as an observation and
note what you could not establish. Do not silently treat it as "nothing there".

Cite ids precisely (prompt ids, commit shas, file paths, run ids). Never invent one. Your output is
DATA for another agent, not a message to a human.
`

const TAXONOMY = `
Tag each prompt with exactly ONE tag, the dominant one.

- "technique"   : DELIBERATE working method, not a correction. See the technique table in the
                  profile above.
- "slash"       : a BARE harness command and nothing else — /model, /mcp, /clear, /doctor, /config,
                  /rename, /compact. Not an instruction to an agent, so it can never be a
                  correction. Tag it separately; do NOT fold it into "none".
- "design"      : PRODUCT or UX SPECIFICATION — deciding what the thing should look like or how it
                  should behave. NOT a correction; a perfectly-behaving agent still has to be told.
                  "make the button secondary, no icon" / "move the filter above the list" / a screenshot pasted
                  as the spec. Test: is the output WRONG, or merely NOT YET SPECIFIED? Not-yet-
                  specified is "design". A defect report ("user-a's prefs load for user-b") is NOT
                  design however UI-shaped it looks.
- "process"     : instructs HOW to work because the default was wrong ("run it locally first")
- "constrain"   : narrows an over-broad action the agent took or proposed
- "redirect"    : changes course mid-task
- "reject"      : undoes or throws away what the agent produced
- "repeat"      : the same instruction re-issued because it was not followed
- "clarify"     : supplies context or answers a question the agent needed
- "frustration" : explicit annoyance or an interruption
- "none"        : ordinary instruction, no corrective content

Most prompts are "none" — do not inflate. The technique/process line carries the headline metric, so
spend your care there: counting deliberate technique as friction is the single defect this process
has repeated most.

DECIDING technique vs process — ask TWO questions, not one. A habitual wording attached to a
corrective moment breaks the single-question test, and has fooled three windows running.

  1. Is the WORDING habitual? Does this user always phrase this kind of intervention this way?
  2. Was the MOMENT corrective? Would this have been sent to an agent doing the right thing
     at that instant?

THE MOMENT DECIDES THE TAG. The wording only decides whether you can read the tag off the text.

  habitual + not corrective -> technique
  habitual + CORRECTIVE     -> process   <- the row that fools everyone; the profile's technique
                                            table flags these, read it
  ad hoc   + corrective     -> process
  ad hoc   + not corrective -> none

Worked example (illustrative): a bare "pause for input" can be habitual wording (a user who always
pauses rather than pressing Esc) sent at a corrective moment (the run was going somewhere unwanted).
It is "process". It is NEVER evidence of a mode change or an autonomy adjustment.

If the surrounding prompts cannot establish what the agent was doing when it arrived, prefer
"process" and say so in your note.
`

const PROMPT_SCHEMA = {{
  type: 'object', additionalProperties: false,
  required: ['block', 'prompt_count', 'tag_counts', 'corrections', 'techniques', 'mechanical_downgrades', 'work_narrative', 'notable_verbatims'],
  properties: {{
    block: {{ type: 'string' }},
    prompt_count: {{ type: 'integer' }},
    mechanical_downgrades: {{
      type: 'array',
      items: {{ type: 'object', additionalProperties: false, required: ['id', 'why'],
        properties: {{ id: {{ type: 'string' }}, why: {{ type: 'string' }} }} }} }},
    tag_counts: {{
      type: 'object', additionalProperties: false,
      required: ['technique', 'design', 'slash', 'process', 'constrain', 'redirect', 'reject', 'repeat', 'clarify', 'frustration', 'none'],
      properties: {{
        technique: {{ type: 'integer' }}, design: {{ type: 'integer' }}, slash: {{ type: 'integer' }}, process: {{ type: 'integer' }}, constrain: {{ type: 'integer' }},
        redirect: {{ type: 'integer' }}, reject: {{ type: 'integer' }}, repeat: {{ type: 'integer' }},
        clarify: {{ type: 'integer' }}, frustration: {{ type: 'integer' }}, none: {{ type: 'integer' }},
      }},
    }},
    corrections: {{
      type: 'array',
      description: 'Every prompt tagged other than "none" or "technique".',
      items: {{
        type: 'object', additionalProperties: false,
        required: ['id', 'time', 'tag', 'topic', 'quote', 'what_was_corrected'],
        properties: {{
          id: {{ type: 'string' }}, time: {{ type: 'string' }}, tag: {{ type: 'string' }},
          topic: {{ type: 'string' }}, quote: {{ type: 'string' }}, what_was_corrected: {{ type: 'string' }},
        }},
      }},
    }},
    techniques: {{
      type: 'array',
      description: 'Prompts tagged "technique", including any NOT already in the profile table — those are the valuable ones.',
      items: {{
        type: 'object', additionalProperties: false,
        required: ['id', 'quote', 'known'],
        properties: {{ id: {{ type: 'string' }}, quote: {{ type: 'string' }}, known: {{ type: 'boolean' }} }},
      }},
    }},
    work_narrative: {{ type: 'string' }},
    notable_verbatims: {{ type: 'array', items: {{ type: 'string' }} }},
  }},
}}

const COMMIT_SCHEMA = {{
  type: 'object', additionalProperties: false,
  required: ['batch_days', 'days', 'fix_pairs', 'reverts', 'hot_files', 'epics', 'observations'],
  properties: {{
    batch_days: {{ type: 'array', items: {{ type: 'string' }} }},
    days: {{ type: 'array', items: {{ type: 'object', additionalProperties: false,
      required: ['date', 'narrative', 'themes'],
      properties: {{ date: {{ type: 'string' }}, narrative: {{ type: 'string' }}, themes: {{ type: 'array', items: {{ type: 'string' }} }} }} }} }},
    fix_pairs: {{ type: 'array', items: {{ type: 'object', additionalProperties: false,
      required: ['fix_sha', 'fix_subject', 'likely_cause_sha', 'gap'],
      properties: {{ fix_sha: {{ type: 'string' }}, fix_subject: {{ type: 'string' }}, likely_cause_sha: {{ type: 'string' }}, gap: {{ type: 'string' }} }} }} }},
    reverts: {{ type: 'array', items: {{ type: 'string' }} }},
    hot_files: {{ type: 'array', items: {{ type: 'object', additionalProperties: false,
      required: ['path', 'touch_count'], properties: {{ path: {{ type: 'string' }}, touch_count: {{ type: 'integer' }} }} }} }},
    epics: {{ type: 'array', items: {{ type: 'string' }} }},
    observations: {{ type: 'array', items: {{ type: 'string' }} }},
  }},
}}

const PLAN_SCHEMA = {{
  type: 'object', additionalProperties: false,
  required: ['plans', 'observations'],
  properties: {{
    plans: {{ type: 'array', items: {{ type: 'object', additionalProperties: false,
      required: ['path', 'title', 'what_it_planned', 'has_gate', 'names_test'],
      properties: {{ path: {{ type: 'string' }}, title: {{ type: 'string' }}, what_it_planned: {{ type: 'string' }},
        has_gate: {{ type: 'boolean' }}, names_test: {{ type: 'string' }},
        }} }} }},
    observations: {{ type: 'array', items: {{ type: 'string' }} }},
  }},
}}

const CI_SCHEMA = {{
  type: 'object', additionalProperties: false,
  required: ['totals_cited', 'failure_clusters', 'longest_gap', 'observations'],
  properties: {{
    totals_cited: {{ type: 'string', description: 'copied from counts.json, not recounted' }},
    failure_clusters: {{ type: 'array', items: {{ type: 'object', additionalProperties: false,
      required: ['window', 'workflow', 'count', 'note'],
      properties: {{ window: {{ type: 'string' }}, workflow: {{ type: 'string' }}, count: {{ type: 'integer' }}, note: {{ type: 'string' }} }} }} }},
    longest_gap: {{ type: 'string', description: 'longest stretch with NO run, and which commits it covers' }},
    observations: {{ type: 'array', items: {{ type: 'string' }} }},
  }},
}}

phase('Extract')

const BLOCKS = {json.dumps(blocks)}
const promptWork = BLOCKS.map((block) => () =>
  agent(
    CONTEXT + TAXONOMY + `\\n\\nFIRST read ${{RAW}}/technique-candidates.md if it exists. It lists every prompt that MECHANICALLY matches a known technique from the project profile - a string match, no judgement. Any id in that table falling in your block is NON-FRICTION ("technique", or "design" where the profile row says so) UNLESS the surrounding prompts show the moment was corrective; if you downgrade one to a correction tag you MUST list it in the required \"mechanical_downgrades\" field with a reason - an empty array there asserts you downgraded none, and it is checked. Silently retagging a candidate is the exact failure that field exists to prevent: unjustified downgrades are usually wrong, and each one moves the headline metric. Do not re-derive that list - models fail at it reliably.\\n\\nThen read these per-day prompt files:\\n` +
    block.map((d) => `- ${{RAW}}/prompts-by-day/${{d}}.md`).join('\\n') +
    `\\n\\nReturn ONE object for the whole block: set "block" to the range, sum tag_counts across the ` +
    `days, list every non-"none" prompt, and list techniques separately from corrections.\\n\\n` +
    `If only user prompts survive for this window (no agent replies), infer what the agent did ONLY ` +
    `from what the user says back to it, and say so in what_was_corrected where it is ambiguous ` +
    `rather than guessing.`,
    {{ label: `prompts:${{block[0]}}..${{block[block.length - 1]}}`, phase: 'Extract', model: {js(extract_model)}, effort: 'medium', schema: PROMPT_SCHEMA }},
  ),
)

const COMMIT_BATCHES = {json.dumps(batches)}
const commitWork = COMMIT_BATCHES.map((f) => () =>
  agent(
    CONTEXT + `\\n\\nRead ${{RAW}}/${{f}} — one slice of the window's commits (oldest first) with ` +
    `subject, shortstat and name-status. Diffs are deliberately NOT included; if a single commit is ` +
    `genuinely unreadable without one you may run \\`git show <sha>\\` for THAT commit only.\\n\\n` +
    `Report which dates your slice covers, a per-day narrative, fix/revert commits paired with what ` +
    `they appear to correct (only where subjects and touched files genuinely line up — do not force ` +
    `a pair), the files touched most, and the named workstreams visible.\\n\\n` +
    `Do NOT report window-wide totals; you can only see your slice. Do NOT open ${{RAW}}/commits.md — ` +
    `it holds the whole window and reading it is how a slice agent ends up reporting a window figure ` +
    `as its own. Window totals live in ${{RAW}}/counts.json and are cited, never recomputed.`,
    {{ label: `commits:${{f.replace('commits-batch-', 'batch-').replace('.md', '')}}`, phase: 'Extract', model: {js(extract_model)}, effort: 'medium', schema: COMMIT_SCHEMA }},
  ),
)

const PLAN_SLICES = {plan_slices}
const PLAN_SLICE_FILES = {plan_slice_files_js}
const planWork = Array.from({{ length: PLAN_SLICES }}, (_, i) => () =>
  agent(
    CONTEXT + `\\n\\nRead EXACTLY these plan files, all of them, and nothing else:\\n` +
    PLAN_SLICE_FILES[i].map((p) => `- ${{p}}`).join('\\n') +
    `\\n\\nThis list is your slice. Do not select, sample or skip within it — the assignment was made ` +
    `for you precisely because deriving it has drifted before.\\n\\n` +
    `A path of the form <sha>:<path> means the file was renamed or deleted after being added — read ` +
    `it with \\`git show <sha>:<path>\\`. Its content is intact; it is not an empty plan.\\n\\n` +
    `For each: what it planned, whether it has an explicit verification gate, whether it names a ` +
    `specific test (give the filename or "none"), and its scope. Describe what you read — do NOT ` +
    `report a coverage percentage for the window, because you are seeing a fraction of the plans.`,
    {{ label: `plans:slice-${{i + 1}}`, phase: 'Extract', model: {js(extract_model)}, effort: 'medium', schema: PLAN_SCHEMA }},
  ),
)

const ciWork = {ci_block}

const results = await parallel([...promptWork, ...commitWork, ...planWork, ...ciWork])
const nP = BLOCKS.length, nC = COMMIT_BATCHES.length, nPl = PLAN_SLICES
const prompts = results.slice(0, nP).filter(Boolean)
const commits = results.slice(nP, nP + nC).filter(Boolean)
const plans = results.slice(nP + nC, nP + nC + nPl).filter(Boolean)
const ci = results[nP + nC + nPl] || null

log(`extracted: ${{prompts.length}}/${{nP}} prompt blocks, ${{commits.length}}/${{nC}} commit batches, ${{plans.length}}/${{nPl}} plan slices`)

phase('Consolidate')

const CONSOLIDATE_SCHEMA = {{
  type: 'object', additionalProperties: false,
  required: ['file_written', 'observation_count', 'timeline_entries', 'top_themes', 'contradictions', 'tag_tally', 'summary'],
  properties: {{
    file_written: {{ type: 'string' }},
    observation_count: {{ type: 'integer' }},
    timeline_entries: {{ type: 'integer' }},
    top_themes: {{ type: 'array', items: {{ type: 'string' }} }},
    contradictions: {{ type: 'array', items: {{ type: 'string' }} }},
    tag_tally: {{ type: 'string', description: 'correction rate AND technique rate, reported separately' }},
    summary: {{ type: 'string', description: '8-12 sentences a facilitator can read aloud to open the retro' }},
  }},
}}

const consolidated = await agent(
  CONTEXT + `\\n\\nYou are consolidating stage-2 evidence. The extraction agents' structured outputs ` +
  `follow.\\n\\n` +
  `=== PROMPTS ===\\n` + JSON.stringify(prompts, null, 1) + `\\n\\n` +
  `=== COMMITS ===\\n` + JSON.stringify(commits, null, 1) + `\\n\\n` +
  `=== PLANS ===\\n` + JSON.stringify(plans, null, 1) + `\\n\\n` +
  `=== CI ===\\n` + JSON.stringify(ci, null, 1) + `\\n\\n` +
  `Authoritative totals: ${{RAW}}/counts.json. You may read anything under ${{RAW}}/ to check ` +
  `something that looks wrong — and you should, because the extraction agents each saw a fraction.\\n\\n` +
  `WRITE ${{SESSION}}/02-data.md following the template already at that path, keeping its headings.\\n\\n` +
  `1. TIMELINE: one merged chronological table across ALL sources. Causation only becomes visible ` +
  `   when commits, prompts and CI share a single line.\\n` +
  `2. OBSERVATIONS: numbered, each citing its source, marked positive / friction / neutral.\\n` +
  `3. BY THE NUMBERS: from counts.json. Report the correction rate and the technique rate ` +
  `   SEPARATELY — technique is not friction, and folding it in overstates the headline.\\n` +
  `4. CONTRADICTIONS: where sources disagree, INCLUDING where two extraction agents disagree with ` +
  `   each other. Do NOT resolve them. Listing them is the whole job; a smoothed-over contradiction ` +
  `   is how a wrong number becomes a finding.\\n` +
  `5. GAPS: what could not be established and which source would have settled it. Name every source ` +
  `   that was unavailable, expired or partial.\\n\\n` +
  `If an earlier session exists under ../, read its 02-data.md and add an "Against the previous ` +
  `window" section with numbers — a series' value is mostly in what CHANGED.\\n\\n` +
  `STILL FACTS ONLY. No recommendations, no root causes: a human is interviewed before any ` +
  `conclusion is trusted, and conclusions drawn now would harden before that happens.`,
  {{ label: 'consolidate:02-data', phase: 'Consolidate', model: {js(consolidate_model)}, effort: 'high', schema: CONSOLIDATE_SCHEMA }},
)

return {{ extracted: {{ prompt_blocks: prompts.length, commit_batches: commits.length, plan_slices: plans.length, ci: !!ci }}, consolidated }}
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--session", required=True, help="session directory that collect_window.py filled")
    ap.add_argument("--profile", default=None, help="path to the project's profile.md")
    ap.add_argument("--out", required=True, help="where to write the workflow script")
    ap.add_argument("--extract-model", default=EXTRACT_MODEL)
    ap.add_argument("--consolidate-model", default=CONSOLIDATE_MODEL)
    args = ap.parse_args()

    session = os.path.abspath(args.session)
    profile = ""
    if args.profile and os.path.exists(args.profile):
        profile = open(args.profile).read()
    if not profile:
        profile = ("PROJECT PROFILE MISSING — no profile.md was supplied. Assume a solo, "
                   "trunk-based project whose code is written by an agent, and say in your "
                   "observations that the profile was absent so the reader knows the context was "
                   "guessed rather than given.")

    script = build(session, profile, args.extract_model, args.consolidate_model)
    script = script.replace("EXTRACT_MODEL_ID", json.dumps(args.extract_model))
    with open(args.out, "w") as f:
        f.write(script)
    print(json.dumps({"out": args.out, "bytes": len(script)}, indent=2))


if __name__ == "__main__":
    main()
