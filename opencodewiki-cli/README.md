# opencodewiki

Deterministic passes over an [OKF v0.2](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
repository wiki: front-matter conformance, index and log generation, link and anchor validation,
mermaid validation, git-delta state, and Claude Code plan discovery.

This is the non-model half of the `opencodewiki` Claude Code plugin. It holds no LLM and makes no
network calls — it is a linter and formatter for a wiki. Anything a model would have to be *asked*
to do correctly, and could quietly get wrong, lives here instead.

```bash
npm install -g opencodewiki                  # with exact mermaid validation (~169 MB)
npm install -g opencodewiki --omit=optional  # light install (~1.5 MB)
```

`mermaid` and `jsdom` are **optional dependencies**. With them, mermaid fences are checked by the
real parser; without them, a label-safety heuristic runs instead. Every report names which validator
ran, so a clean result is never quietly weaker than it looks, and `--strict-mermaid` turns an
unavailable parser into a hard failure for anything that needs the authoritative answer.

## Why a separate tool

Three reasons, and they imply different quality bars:

- **Determinism** — the same wiki must produce the same bytes, or a wiki living in git drowns in
  navigation churn on every run.
- **Verification** — a model asserting "the links are fine" is worth nothing; a resolver saying so
  is worth everything.
- **Token economy** — these passes touch every page, and the wiki only grows.

## Usage

```
opencodewiki <command> [options]

Wiki passes
  okf validate            Report OKF v0.2 conformance without writing
  okf normalize           Repair and canonicalise front matter (alias: fmt)
  index sync              Regenerate every directory index.md
  links check|stamp       Resolve internal links and heading anchors
  mermaid check|degrade   Validate mermaid fences
  finalize                normalize -> mermaid -> index -> links, in order
  report                  Aggregate report over the whole wiki
  verify                  report, exiting non-zero on any finding

Repository
  setup                   Create the wiki, brief stub, state file, and the plan check-in convention
  state show|begin|stamp  Read or advance run state
  delta                   What changed since the last recorded run
  plans index             Discover and chronologically batch Claude Code plans
  log add                 Append entries to the wiki update log
  guard <paths...>        Check paths stay inside the wiki

Options
  --repo <dir>            Repository root (default: cwd)
  --wiki <dir>            Wiki directory, relative to repo (default: opencodewiki)
  --json                  Machine-readable output
```

## Exit codes

Part of the contract, because callers branch on them. Keeping "the tool broke" separate from "the
wiki is dirty" matters — conflating them makes a broken install look like work to do.

| Code | Meaning |
|------|---------|
| `0` | Clean, nothing to report |
| `1` | Tool or usage error — bad arguments, not a git repo |
| `2` | Findings: the tool worked, the wiki has problems |
| `3` | Nothing to do — no changes since the last run |

## Pass ordering

`finalize` runs `normalize → mermaid → index → links`, and the order is load-bearing: index
generation reads `description` out of front matter, so normalization precedes it; and index
generation creates links, so validation comes last.

Running `finalize` twice produces a zero-byte diff. That idempotence is the property the whole
design is checked against.

## OKF v0.2 notes

- `type` is the only required field. A document carrying just `type` is fully conformant, and
  nothing here rejects a page for a missing optional family.
- Unknown producer keys survive round trips, as the spec requires.
- `okf_version` is declared only in the bundle-root `index.md`; nested indexes carry no front matter.
- Trust tiers are *derived* from `verified`, never asserted: no key means unverified, non-human
  actors mean machine-confirmed, any `human:<id>` means human-reviewed.

## Mermaid validation

| | Real parser | Heuristic |
|---|---|---|
| Install | default | `--omit=optional` |
| Size | ~169 MB | ~1.5 MB |
| Catches | the full grammar | the label breakages that actually occur — unescaped angle brackets, pipes and semicolons in labels, reserved words as identifiers |

A fence that fails validation is degraded to a plain `text` fence and stamped with the reason, so a
broken diagram never renders as an error block, and a later pass can repair it from a real
diagnosis.

## Plans

Claude Code generates plan filenames from the opening words of a prompt, so they carry no reliable
date or feature. `plans index` reads that from git instead — the commit that added the file gives
the true date, its conventional-commit scope names the feature, and source files changed in the same
commit are evidence the plan actually shipped rather than being abandoned.

Batches are strictly chronological, oldest first, because later intent supersedes earlier intent.

## License

MIT
