---
description: Show which build of the opencodewiki plugin is loaded, and whether the CLI beside it is compatible
allowed-tools:
  - Bash
---

# opencodewiki:version

Confirm which build is actually loaded — usually asked because a reload may not have taken.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/version.mjs"
```

Print the output as-is. It is already the answer; do not summarise it away.

## Reading it

- **`plugin`** — name and manifest version.
- **`fingerprint`** — a hash over every plugin file. This is the field that actually settles "did my
  reload work": the version only moves when someone remembers to bump it, whereas the fingerprint
  changes whenever any file does. Two builds sharing a version but differing in content have
  different fingerprints, which is exactly the case a version string hides.
- **`newest file`** — when the loaded copy was last written. An old timestamp after an edit means the
  reload did not pick it up.
- **`loaded from`** — the path in use. Worth checking when a repo has both a marketplace install and
  a local checkout; they can differ.
- **`cli`** — the separately-installed npm package. `NOT FOUND` means nothing else in the plugin will
  work; tell the user to run `npm i -g opencodewiki`.

## When the user is checking after an edit

If they changed the plugin and the fingerprint has not moved, the reload did not take. Say that
plainly rather than reporting the version as though it confirmed anything — reporting a stale build
as current is the failure this command exists to prevent.

Exit code is `1` when the CLI is missing, `0` otherwise.
