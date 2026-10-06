#!/usr/bin/env python3
"""Deterministic stage-2 collection for one retrospective window.

Writes raw, un-interpreted evidence into <session>/01-evidence/_raw/. No LLM, no judgement — every
downstream agent reads these files instead of re-running the same greps, and every total is counted
here rather than by a model that can only see one batch.

    python3 collect_window.py 2026-01-05 2026-01-19 docs/retrospectives/sessions/2026-01-05-sprint-1

Dates are local and the window is half-open, [start, end).

Three collection invariants this script exists to hold:
  * counts are machine-made and land in counts.json — agents cite, never tally
  * every subset reports "n of total", so a silent truncation is visible
  * a zero is investigated, not believed: a plan reporting 0 bytes was renamed or deleted, and its
    content is still in history

Retention note: Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default), but
~/.claude/history.jsonl retains user prompts far longer — so for older windows the prompt stream is
the only surviving session evidence. That is workable, because corrections live in the user's half of
the conversation; what is lost is the agent's reasoning.
"""
import datetime as dt
import json
import os
import re
import subprocess
import sys

# Target size for one commit batch, in bytes (~7k tokens) — one extraction agent's slice.
BATCH_BYTES = 30000

import argparse

HISTORY = os.path.expanduser("~/.claude/history.jsonl")
PROJECTS = os.path.expanduser("~/.claude/projects")
REPO = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
PLANS_DIR = "docs/claude-plans"


def sh(*args, **kw):
    return subprocess.run(args, capture_output=True, text=True, cwd=REPO, **kw).stdout


def est_tokens(chars):
    return f"~{round(chars / 4 / 1000, 1)}k tok"


def collect_prompts(start, end, out, project_marker):
    rows = []
    for line in open(HISTORY):
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        if project_marker not in d.get("project", ""):
            continue
        ts = dt.datetime.fromtimestamp(d["timestamp"] / 1000)
        if not (start <= ts < end):
            continue
        pasted = d.get("pastedContents") or {}
        pchars = sum(len(str(v.get("content", ""))) for v in pasted.values()) if isinstance(pasted, dict) else 0
        rows.append((ts, d.get("sessionId", ""), d.get("display", ""), pchars))
    rows.sort()

    sessions, order = {}, []
    for ts, sid, disp, pchars in rows:
        if sid not in sessions:
            sessions[sid] = []
            order.append(sid)
        sessions[sid].append((ts, disp, pchars))

    with open(out, "w") as f:
        f.write("# Raw — user prompts\n\n")
        f.write(f"Window: {start:%Y-%m-%d %H:%M} .. {end:%Y-%m-%d %H:%M} (local, end-exclusive)\n")
        f.write(f"Source: `~/.claude/history.jsonl` — user prompts only. Claude's replies and tool\n")
        f.write("calls are NOT here; for windows older than the transcript retention they no longer exist.\n\n")
        f.write(f"**{len(rows)} prompts across {len(order)} sessions.**\n\n")
        for i, sid in enumerate(order, 1):
            items = sessions[sid]
            span = f"{items[0][0]:%m-%d %H:%M} → {items[-1][0]:%m-%d %H:%M}"
            f.write(f"\n## Session {i}/{len(order)} · `{sid[:8]}` · {span} · {len(items)} prompts\n\n")
            for n, (ts, disp, pchars) in enumerate(items, 1):
                tag = f" [+{pchars} pasted chars]" if pchars else ""
                f.write(f"### P{i}.{n} · {ts:%m-%d %H:%M}{tag}\n\n```\n{disp}\n```\n\n")

    # Per-day files, so an extraction agent reads one day and never the whole corpus.
    byday = {}
    for i, sid in enumerate(order, 1):
        for n, (ts, disp, pchars) in enumerate(sessions[sid], 1):
            byday.setdefault(ts.strftime("%m-%d"), []).append((f"P{i}.{n}", ts, disp, pchars))
    daydir = os.path.join(os.path.dirname(out), "prompts-by-day")
    os.makedirs(daydir, exist_ok=True)
    per_day = {}
    for day in sorted(byday):
        items = sorted(byday[day], key=lambda x: x[1])
        per_day[day] = len(items)
        with open(os.path.join(daydir, f"{day}.md"), "w") as f:
            f.write(f"# Raw — user prompts, {start:%Y}-{day}\n\n")
            f.write("Source: `~/.claude/history.jsonl`. USER PROMPTS ONLY — Claude's replies and tool\n")
            f.write("calls may not survive for this window. Prompt ids are `P<session>.<n>`.\n\n")
            f.write(f"**{len(items)} prompts.**\n\n")
            for pid, ts, disp, pchars in items:
                tag = f" [+{pchars} pasted chars]" if pchars else ""
                f.write(f"### {pid} · {ts:%m-%d %H:%M}{tag}\n\n```\n{disp}\n```\n\n")

    return {"prompts": len(rows), "sessions": len(order), "chars": sum(len(r[2]) for r in rows),
            "prompts_per_day": per_day}


def collect_other_projects(start, end, out, marker, quiet_days):
    """What the person was doing on days this project shows nothing.

    A solo developer's empty day is usually work elsewhere, not a blocked day. history.jsonl holds
    every project's prompts, so the answer is one pass away -- and a retro that does not look
    records "no evidence at all" for a question the evidence answers.
    """
    by_day = {}
    for line in open(HISTORY):
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        ts = dt.datetime.fromtimestamp(d["timestamp"] / 1000)
        if not (start <= ts < end):
            continue
        project = d.get("project", "") or "(unknown)"
        if marker in project:
            continue
        day = ts.strftime("%m-%d")
        by_day.setdefault(day, {}).setdefault(os.path.basename(project.rstrip("/")), 0)
        by_day[day][os.path.basename(project.rstrip("/"))] += 1

    with open(out, "w") as f:
        f.write("# Raw — prompts to OTHER projects in the same window\n\n")
        f.write("From `~/.claude/history.jsonl`, excluding this project. **Read this before calling any\n")
        f.write("day empty.** On a solo timeline an inactive day is usually attention elsewhere, and\n")
        f.write("that is an answer, not a gap.\n\n")
        if not by_day:
            f.write("No prompts to other projects in this window.\n")
        else:
            f.write("| Day | Project | Prompts | This project quiet? |\n|---|---|---|---|\n")
            for day in sorted(by_day):
                for proj, n in sorted(by_day[day].items(), key=lambda kv: -kv[1]):
                    f.write(f"| {day} | `{proj}` | {n} | {'**yes**' if day in quiet_days else 'no'} |\n")
        if quiet_days:
            f.write(f"\nDays with no activity on this project: {', '.join(sorted(quiet_days))}\n")
    covered = sorted(d for d in quiet_days if d in by_day)
    return {"other_project_prompts": sum(sum(v.values()) for v in by_day.values()),
            "quiet_days": sorted(quiet_days),
            "quiet_days_explained_elsewhere": covered}


def collect_commits(start, end, out):
    fmt = "%H%x1f%h%x1f%ad%x1f%an%x1f%s"
    raw = sh("git", "log", f"--since={start:%Y-%m-%d %H:%M}", f"--until={end:%Y-%m-%d %H:%M}",
             f"--pretty=format:{fmt}", "--date=format:%Y-%m-%d %H:%M")
    commits = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        full, short, date, author, subject = line.split("\x1f")
        stat = sh("git", "show", "--shortstat", "--pretty=format:", full).strip()
        files = [l for l in sh("git", "show", "--name-status", "--pretty=format:", full).splitlines() if l.strip()]
        commits.append(dict(full=full, short=short, date=date, author=author, subject=subject,
                            stat=stat, files=files))
    commits.reverse()

    with open(out, "w") as f:
        f.write("# Raw — git commits\n\n")
        f.write(f"Window: {start:%Y-%m-%d %H:%M} .. {end:%Y-%m-%d %H:%M} (local, end-exclusive)\n\n")
        f.write(f"**{len(commits)} commits**, oldest first. Diffs are deliberately NOT included — pull\n")
        f.write("them per commit with `git show <sha>` only where the analysis needs them.\n\n")
        day = None
        for c in commits:
            d = c["date"][:10]
            if d != day:
                day = d
                dt_ = dt.datetime.strptime(d, "%Y-%m-%d")
                f.write(f"\n## {dt_:%A %Y-%m-%d}\n\n")
            f.write(f"### `{c['short']}` {c['date'][11:]} — {c['subject']}\n\n")
            f.write(f"- stat: {c['stat'] or '(no changes)'}\n")
            f.write(f"- files ({len(c['files'])}):\n")
            for fl in c["files"][:40]:
                f.write(f"  - {fl}\n")
            if len(c["files"]) > 40:
                f.write(f"  - …and {len(c['files']) - 40} more\n")
            f.write("\n")

    # Deterministic tallies. Agents interpret; the collector counts — an LLM asked to total
    # across a batch boundary will disagree with itself, and did.
    by_day, by_type = {}, {}
    for c in commits:
        by_day[c["date"][:10]] = by_day.get(c["date"][:10], 0) + 1
        subject = c["subject"]
        m = re.match(r"^([a-z]+)(\(|!|:)", subject)
        b = re.match(r"^\[([^\]]+)\]", subject)
        kind = m.group(1) if m else (f"[{b.group(1)}]" if b else "other")
        by_type[kind] = by_type.get(kind, 0) + 1

    # Split into batches of roughly equal byte size, never splitting a day across batches.
    body = open(out).read()
    parts = re.split(r"(?=^## )", body, flags=re.M)
    head, day_chunks = parts[0], parts[1:]
    target = max(1, round(sum(len(c) for c in day_chunks) / BATCH_BYTES + 0.5))
    batches, cur, cur_len = [], [], 0
    per_batch = sum(len(c) for c in day_chunks) / target if target else 1
    for chunk in day_chunks:
        cur.append(chunk)
        cur_len += len(chunk)
        if cur_len >= per_batch and len(batches) < target - 1:
            batches.append(cur)
            cur, cur_len = [], 0
    if cur:
        batches.append(cur)
    for i, batch in enumerate(batches, 1):
        with open(os.path.join(os.path.dirname(out), f"commits-batch-{i}.md"), "w") as f:
            f.write(head + "".join(batch))

    return {"commits": len(commits), "commits_by_day": by_day, "commits_by_type": by_type,
            "commit_batches": len(batches)}


def collect_plans(start, end, out, plans_dir):
    """Census the plans created in the window.

    Two defects this exists to avoid, both observed in real runs:

      * Fate was resolved by looking for a rename and defaulting to "deleted" when none matched,
        so every rename was reported as a deletion. Renames and deletes are now resolved from the
        same forward pass and only claimed when actually found.

        (Rename detection stays ON for the add query on purpose: with `--no-renames` a rename
        becomes a delete plus an add, and the renamed-to path is then counted as a second plan --
        the opposite error, and the one this fix first introduced.)
      * Keying by path collapses distinct plans that reused one scratch filename. A workflow where
        a plan is drafted at a throwaway name and renamed on completion produces several plans
        through one path, and a set of paths counts them once.

    So: adds are keyed by (sha, path), and each one's fate is resolved forward through history.
    """
    raw = sh("git", "log", f"--since={start:%Y-%m-%d %H:%M}", f"--until={end:%Y-%m-%d %H:%M}",
             "--diff-filter=A", "--name-status",
             "--pretty=format:%x01%H%x1f%ad", "--date=format:%Y-%m-%d %H:%M", "--", plans_dir + "/")
    adds = []
    sha = date = None
    for chunk in raw.split("\x01"):
        if not chunk.strip():
            continue
        head, *lines = chunk.splitlines()
        sha, date = head.split("\x1f")
        for line in lines:
            if line.startswith("A\t"):
                adds.append((sha, date, line.split("\t", 1)[1]))
    adds.reverse()

    # Every rename and delete since the window opened, so each add can be followed forward.
    # Timestamps matter: one scratch path can be created, renamed away, and created again, so an
    # event belongs to an add only if it falls between that add and the next add at the same path.
    events = sh("git", "log", f"--since={start:%Y-%m-%d %H:%M}", "--diff-filter=RD",
                "--name-status", "--pretty=format:%x01%H%x1f%ad", "--date=format:%Y-%m-%d %H:%M",
                "--", plans_dir + "/")
    moves = []
    for chunk in events.split("\x01"):
        if not chunk.strip():
            continue
        head, *lines = chunk.splitlines()
        esha, edate = head.split("\x1f")
        for line in lines:
            parts = line.split("\t")
            if parts[0].startswith("R") and len(parts) == 3:
                moves.append(("R", esha, edate, parts[1], parts[2]))
            elif parts[0] == "D" and len(parts) == 2:
                moves.append(("D", esha, edate, parts[1], None))
    moves.sort(key=lambda m: m[2])

    rows, total, renamed, deleted = [], 0, 0, 0
    for i, (sha, date, path) in enumerate(adds):
        nxt = next((a[1] for a in adds[i + 1:] if a[2] == path), None)
        fate, read_at, current = "on disk", path, path
        for kind, esha, edate, src, dst in moves:
            if src != path or edate < date:
                continue
            if nxt and edate > nxt:      # a later add reclaimed the path first
                break
            if kind == "R":
                fate, current, read_at = f"renamed in {esha[:7]} {edate[:10]}", dst, dst
                renamed += 1
            else:
                fate, read_at = f"deleted in {esha[:7]} {edate[:10]}", f"{sha[:7]}:{path}"
                deleted += 1
            break
        disk = os.path.join(REPO, current)
        if fate == "on disk" and not os.path.exists(disk):
            fate, read_at = "missing at HEAD", f"{sha[:7]}:{path}"
        if ":" in read_at and not read_at.startswith("docs"):
            size = len(sh("git", "show", read_at).encode())
        else:
            size = os.path.getsize(disk) if os.path.exists(disk) else 0
        total += size
        rows.append((read_at, path, fate, date, size))

    with open(out, "w") as f:
        f.write("# Raw — plan documents created in the window\n\n")
        f.write(f"**{len(rows)} plans created** between {start:%Y-%m-%d} and {end:%Y-%m-%d}.\n")
        f.write("Counted by (commit, path), so a scratch filename reused for several plans counts once\n")
        f.write("per plan. Read each at the path in the first column — a `<sha>:<path>` entry opens with\n")
        f.write("`git show <sha>:<path>` and its content is intact.\n\n")
        f.write("| Read at | Created as | Fate | Created | Bytes | Est. tokens |\n")
        f.write("|---|---|---|---|---|---|\n")
        for read_at, path, fate, date, size in rows:
            created_as = "—" if read_at == path else f"`{path}`"
            f.write(f"| `{read_at}` | {created_as} | {fate} | {date} | {size} | {est_tokens(size)} |\n")
        f.write(f"\n**Total: {total} bytes ({est_tokens(total)})** · {renamed} renamed, {deleted} deleted\n")
        f.write("after creation. A rename is not a deletion and a reused filename is not one plan.\n")
    return {"plans": len(rows), "plan_bytes": total, "plans_renamed": renamed,
            "plans_deleted": deleted}


def collect_ci(start, end, out):
    repo_slug = sh("git", "remote", "get-url", "origin").strip()
    repo_slug = repo_slug.split(":")[-1].replace(".git", "") if repo_slug else ""
    # The API caps per_page at 100, so page until exhausted — a busy fortnight easily exceeds it.
    data = {"total_count": 0, "workflow_runs": []}
    for page in range(1, 21):
        q = (f"repos/{repo_slug}/actions/runs?per_page=100&page={page}"
             f"&created={start:%Y-%m-%d}..{end:%Y-%m-%d}")
        raw = subprocess.run(["gh", "api", q], capture_output=True, text=True).stdout
        try:
            chunk = json.loads(raw)
        except json.JSONDecodeError:
            break
        data["total_count"] = chunk.get("total_count", data["total_count"])
        got = chunk.get("workflow_runs", [])
        data["workflow_runs"].extend(got)
        if len(got) < 100:
            break
    # gh's `created=` filter is date-granular and inclusive on both ends, so re-filter to the
    # exact local half-open window the rest of the collection uses.
    runs = []
    for r in data.get("workflow_runs", []):
        created = r.get("created_at") or ""
        local = dt.datetime.fromisoformat(created.replace("Z", "+00:00")).astimezone().replace(tzinfo=None)
        if not (start <= local < end):
            continue
        runs.append(dict(id=r["id"], name=r.get("name"), event=r.get("event"), status=r.get("status"),
                         conclusion=r.get("conclusion"), created=created, updated=r.get("updated_at"),
                         head=r.get("head_sha", "")[:7], title=(r.get("display_title") or "")[:120]))
    runs.sort(key=lambda r: r["created"])
    by_conclusion, by_workflow = {}, {}
    for r in runs:
        by_conclusion[r["conclusion"]] = by_conclusion.get(r["conclusion"], 0) + 1
        name = r["name"] or "?"
        # Dependabot names every run uniquely; collapse them or the tally is meaningless.
        if name.startswith(("github_actions in", "npm_and_yarn in")):
            name = "dependabot (dynamic)"
        by_workflow[name] = by_workflow.get(name, 0) + 1
    # `n of total` is only alarming when the shortfall is TRUNCATION. Here it is usually the
    # date filter: gh's `created=` is date-granular and inclusive, so runs on the exclusive end
    # date arrive and are dropped. Reporting the two separately stops a retro raising a
    # non-existent gap.
    # An aggregate pass rate across MIXED workflow kinds is not a pass rate: bot metadata runs that
    # never execute the suite, and deploy runs that "succeed" by skipping a failed upstream, both
    # inflate it -- a mixed-workflow pass rate can overstate the verification workflow's several-fold.
    # Cross the two axes here so the honest number is in counts.json.
    matrix, wf_event = {}, {}
    for r in runs:
        name = r["name"] or "?"
        if name.startswith(("github_actions in", "npm_and_yarn in")):
            name = "dependabot (dynamic)"
        matrix.setdefault(name, {})
        matrix[name][r["conclusion"]] = matrix[name].get(r["conclusion"], 0) + 1
        key = f'{name} / {r["event"]}'
        wf_event.setdefault(key, {})
        wf_event[key][r["conclusion"]] = wf_event[key].get(r["conclusion"], 0) + 1
    excluded = [r.get("created_at") for r in data.get("workflow_runs", [])
                if r.get("created_at") and not any(x["created"] == r["created_at"] for x in runs)]
    truncated = len(data.get("workflow_runs", [])) < (data.get("total_count") or 0)
    json.dump({"total_count": data.get("total_count"),
               "returned_by_api": len(data.get("workflow_runs", [])),
               "fetched": len(runs),
               "excluded_out_of_window": len(excluded),
               "excluded_dates": sorted({e[:10] for e in excluded}),
               "page_truncated": truncated,
               "by_conclusion": by_conclusion, "by_workflow": by_workflow,
               "by_workflow_conclusion": matrix, "by_workflow_event": wf_event, "runs": runs},
              open(out, "w"), indent=2)
    return {"ci_runs": len(runs), "ci_total": data.get("total_count"),
            "ci_excluded_out_of_window": len(excluded),
            "ci_page_truncated": truncated,
            "ci_by_conclusion": by_conclusion, "ci_by_workflow": by_workflow,
            "ci_by_workflow_conclusion": matrix, "ci_by_workflow_event": wf_event}


def flag_techniques(prompts_md, profile_path, out):
    """Pre-flag prompts that MATCH A KNOWN TECHNIQUE, mechanically.

    Extraction agents asked to recognise techniques report almost none, while their own output quotes
    prompts that are verbatim rows of the project's technique table -- even with a two-question
    judgement test in the prompt specifically to stop this.

    The reason is that recognising a technique is not a judgement at all -- the technique table is a
    list of known strings, and matching a known string is a grep. So this does the grep, and the
    agent's job becomes reconciliation ("here are the candidates; say which the context refutes")
    rather than recall.

    Signature phrases are the quoted spans inside the profile's technique table, plus an optional
    third `Pattern` column holding a regex in backticks (escape any `|` in it as `\|`, as Markdown
    tables require).
    """
    if not profile_path or not os.path.exists(profile_path):
        return {}
    prof = open(profile_path, encoding="utf-8").read()
    rows = []
    if "## Known techniques" in prof:
        section = prof[prof.find("## Known techniques"):]
        nxt = re.search(r"^## ", section[3:], re.M)
        section = section[:nxt.start() + 3] if nxt else section
        for line in section.splitlines():
            line = line.strip()
            if not line.startswith("|"):
                continue
            cells = [c.strip() for c in re.split(r"(?<!\\)\|", line.strip("|"))]
            if len(cells) < 2:
                continue
            name = cells[0].strip("* ")
            if not name or name.lower().startswith("technique") or set(name) <= set("-: "):
                continue
            pat = re.search(r"`(.+)`", cells[2]) if len(cells) > 2 else None
            rows.append((name, cells[1], pat.group(1).replace("\\|", "|") if pat else None))
    sigs = []
    for name, desc, _pat in rows:
        for span in re.findall(r"\*\"(.+?)\"\*", desc):
            span = re.sub(r"\s+", " ", span).strip().lower()
            # A short fragment matches everything; require enough of it to mean something.
            for frag in re.split(r"\s*(?:\u2026|\.\.\.)\s*", span):
                frag = frag.strip(" .,")
                if len(frag) >= 12:
                    sigs.append((name, frag))
    # Table rows paraphrase; prompts do not. Exact substring alone misses most known techniques, so
    # each row may also carry a loose regex: the profile's `Pattern` column first, else a generic
    # default keyed by the technique's NAME. Phrasings are personal, so the profile is where they
    # belong -- these defaults are only a starting point. Precision still matters more than recall
    # here -- a false candidate costs an agent one line of reasoning, a missed one costs the
    # headline metric.
    DEFAULT_KEYS = {
        "commit per phase": r"commit.{0,24}per (?:increment|phase|step)",
        "local-first verification": r"run (?:it )?locally",
        "plan-without-plan-mode": r"(?:only )?analy[sz]e[,\s].{0,40}do not (?:make any changes|fix|implement)",
        # Any local image path handed to the agent is a spec; anchoring on a screenshot filename
        # format alone misses most of them.
        "screenshot-as-spec": r"['\"/][^'\"\n]*\.(?:png|jpe?g|webp)",
    }
    for name, _d, pat in rows:
        key = pat or DEFAULT_KEYS.get(name.lower())
        if key:
            try:
                re.compile(key)
            except re.error as e:
                print(f"# profile: bad Pattern for technique {name!r}: {e}", file=sys.stderr)
                continue
            sigs.append((name, ("~re~", key)))
    if not sigs:
        return {}
    blocks = re.findall(r"^### (P[\d.]+) \u00b7 ([^\n]+)\n\n```\n(.*?)\n```", 
                        open(prompts_md, encoding="utf-8").read(), re.S | re.M)
    hits = []
    for pid, when, body in blocks:
        low = re.sub(r"\s+", " ", body).lower()
        for name, frag in sigs:
            if isinstance(frag, tuple):
                # `low` is lowercased, so patterns must be too -- match case-insensitively.
                if not re.search(frag[1], low, re.I):
                    continue
                frag = f"/{frag[1][:44]}/"
            elif frag not in low:
                continue
            if True:
                hits.append((pid, when, name, frag, body.strip().replace("\n", " ")[:160]))
                break
    with open(out, "w", encoding="utf-8") as f:
        f.write("# Raw \u2014 prompts matching a KNOWN technique (mechanical)\n\n")
        f.write("Produced by a string match against the technique table in the project profile \u2014 **no\n")
        f.write("judgement was applied**. Recognising a documented technique is a lookup, not a decision,\n")
        f.write("and delegating it to a model fails reliably.\n\n")
        f.write(f"**{len(hits)} of {len(blocks)} prompts match a known technique signature.**\n\n")
        f.write("Extraction agents MUST tag each of these **non-friction** \u2014 `technique`, or `design` where\n")
        f.write("the profile row says so \u2014 unless the surrounding prompts show the moment was corrective.\n")
        f.write("For any they downgrade to a correction tag, they must say which and why.\n\n")
        if hits:
            f.write("| Prompt | When | Technique | Matched on |\n|---|---|---|---|\n")
            for pid, when, name, frag, quote in hits:
                f.write(f"| `{pid}` | {when} | {name} | \u201c{frag}\u201d |\n")
        else:
            f.write("No prompt matched a known signature. That is a claim: either the window used no\n")
            f.write("documented technique, or the table's phrasings have drifted from how they are typed.\n")
    return {"technique_candidates": len(hits),
            "technique_candidate_ids": [h[0] for h in hits]}


def collect_transcripts(start, end, out, project_marker):
    """Full transcripts for THIS project, when the window is inside the retention period.

    The marker filter is load-bearing. Without it this walked every project under
    ~/.claude/projects and matched on start time alone -- a window could report transcripts that
    were subagent files from an unrelated project, which would be read as "the agent's half of the
    conversation survives for this window" when none of it did.
    """
    found, foreign = [], 0
    if os.path.isdir(PROJECTS):
        for root, _dirs, files in os.walk(PROJECTS):
            if project_marker not in root:
                foreign += len([f for f in files if f.endswith(".jsonl")])
                continue
            for fn in files:
                if not fn.endswith(".jsonl"):
                    continue
                path = os.path.join(root, fn)
                try:
                    with open(path) as fh:
                        head = fh.readline()
                    ts = json.loads(head).get("timestamp")
                except Exception:
                    continue
                if not ts:
                    continue
                started = dt.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().replace(tzinfo=None)
                if start <= started < end:
                    found.append((started, path, os.path.getsize(path)))
    found.sort()
    _ = foreign
    with open(out, "w") as f:
        f.write("# Raw — Claude Code transcripts\n\n")
        if not found:
            f.write("**None.** No transcript in this window survives on disk.\n\n")
            f.write("Claude Code deletes transcripts after `cleanupPeriodDays`. For windows older than\n")
            f.write("that, `prompts.md` (from `~/.claude/history.jsonl`) is the only surviving session\n")
            f.write("evidence — user prompts, without Claude's replies or tool calls.\n")
        else:
            f.write(f"**{len(found)} transcripts** started in this window.\n\n")
            f.write("| Started | Path | Bytes | Est. tokens |\n|---|---|---|---|\n")
            for started, path, size in found:
                f.write(f"| {started:%Y-%m-%d %H:%M} | `{path}` | {size} | {est_tokens(size)} |\n")
            f.write("\n**Grep these — never read one whole.**\n")
    return {"transcripts": len(found)}


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("start", help="window start, YYYY-MM-DD (local, inclusive)")
    ap.add_argument("end", help="window end, YYYY-MM-DD (local, EXCLUSIVE)")
    ap.add_argument("session", help="session directory to write into (absolute, or relative to cwd)")
    ap.add_argument("--marker", default=None,
                    help="substring identifying this project in ~/.claude/history.jsonl "
                         "(default: the repo directory name)")
    ap.add_argument("--plans-dir", default=PLANS_DIR,
                    help=f"repo-relative directory holding plan documents (default: {PLANS_DIR}); "
                         "pass 'none' to skip")
    ap.add_argument("--no-ci", action="store_true", help="skip the GitHub Actions fetch")
    ap.add_argument("--profile", default=None,
                    help="path to the project's retro profile.md; its Known-techniques table is "
                         "string-matched against the prompts so the technique census is mechanical")
    ap.add_argument("--repo", default=None,
                    help="repository to collect from (default: the git repo containing the cwd). "
                         "Pass it explicitly when running the script from anywhere else — "
                         "collecting the wrong repo produces a plausible, entirely wrong corpus")
    args = ap.parse_args()

    global REPO
    if args.repo:
        REPO = os.path.abspath(args.repo)
    if not REPO or not os.path.isdir(os.path.join(REPO, ".git")):
        ap.error(f"not a git repository: {REPO or '(none found from cwd)'} — pass --repo")
    print(f"# collecting from {REPO}", file=sys.stderr)

    start = dt.datetime.strptime(args.start, "%Y-%m-%d")
    end = dt.datetime.strptime(args.end, "%Y-%m-%d")
    if end <= start:
        ap.error("end must be after start")
    session = args.session if os.path.isabs(args.session) else os.path.abspath(args.session)
    marker = args.marker or os.path.basename(REPO)
    raw = os.path.join(session, "01-evidence/_raw")
    os.makedirs(raw, exist_ok=True)

    stats = {}
    stats.update(collect_prompts(start, end, os.path.join(raw, "prompts.md"), marker))
    stats.update(flag_techniques(os.path.join(raw, "prompts.md"), args.profile,
                                 os.path.join(raw, "technique-candidates.md")))
    stats.update(collect_commits(start, end, os.path.join(raw, "commits.md")))
    if args.plans_dir != "none":
        stats.update(collect_plans(start, end, os.path.join(raw, "plans.md"), args.plans_dir))
    if not args.no_ci:
        stats.update(collect_ci(start, end, os.path.join(raw, "ci-runs.json")))
    stats.update(collect_transcripts(start, end, os.path.join(raw, "transcripts.md"), marker))

    active = set(stats.get("commits_by_day", {})) | {
        f"{start:%Y}-{d}" for d in stats.get("prompts_per_day", {})
    }
    all_days = {(start + dt.timedelta(days=i)).strftime("%m-%d") for i in range((end - start).days)}
    quiet = {d for d in all_days if f"{start:%Y}-{d}" not in active}
    stats.update(collect_other_projects(start, end, os.path.join(raw, "other-projects.md"),
                                        marker, quiet))

    # Tick the coverage table for what was actually collected, so an unfilled source is
    # visible rather than silently unticked.
    cov = os.path.join(session, "01-evidence", "index.md")
    if os.path.exists(cov):
        text = open(cov).read()
        ticks = {
            "git-commits": stats.get("commits", 0) > 0,
            "github-ci": "ci_runs" in stats,
            "claude-sessions": stats.get("prompts", 0) > 0,
            "repo-docs": "plans" in stats,
        }
        for name, done in ticks.items():
            if done:
                text = text.replace(f"| {name} | \u2610 |", f"| {name} | \u2611 |")
        open(cov, "w").write(text)

    with open(os.path.join(raw, "counts.json"), "w") as f:
        json.dump({"window": {"start": f"{start:%Y-%m-%d}", "end": f"{end:%Y-%m-%d}",
                              "days": (end - start).days,
                              "active_days": len(stats.get("commits_by_day", {}) or {})},
                   **stats}, f, indent=2)

    with open(os.path.join(raw, "sizing.md"), "w") as f:
        f.write("# Sizing — batching budget\n\n")
        f.write(f"Window: {start:%Y-%m-%d} .. {end:%Y-%m-%d} (end-exclusive)\n\n")
        f.write("| File | Bytes | Est. tokens |\n|---|---|---|\n")
        total = 0
        for fn in sorted(os.listdir(raw)):
            if fn == "sizing.md":
                continue
            size = os.path.getsize(os.path.join(raw, fn))
            total += size
            f.write(f"| `{fn}` | {size} | {est_tokens(size)} |\n")
        f.write(f"| **total** | **{total}** | **{est_tokens(total)}** |\n\n")
        f.write("Every subset below reports *n of total* — a collector that silently truncates reads\n")
        f.write("as complete coverage when it is not.\n\n")
        f.write("## Counts\n\n")
        f.write("Authoritative and machine-counted — also in `counts.json`. **Agents must cite these\n")
        f.write("rather than tallying their own**; an LLM totalling across batch boundaries disagrees\n")
        f.write("with itself.\n\n")
        for k, v in stats.items():
            f.write(f"- {k}: {json.dumps(v) if isinstance(v, dict) else v}\n")
        f.write("\nEstimates are bytes/4. Keep any single agent's input under ~100k tokens so a 200k\n")
        f.write("model keeps room to reason; split by day, by batch, or by source.\n")
    print(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
