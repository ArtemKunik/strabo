---
name: strabo-review
description: Review a code change structurally with Strabo, covering which files it touches, who depends on them, whether it adds cycles, tier leaks, rule violations, or breaking API changes, which tests cover it, and how risky each file is. Use this whenever Strabo MCP tools (strabo_review, strabo_impact, get_scope_fence, ...) or the strabo CLI are available and the user asks to review, check, sanity-check, or assess the risk of their changes, a commit, a branch, or a PR. Also use it after you finish your own edits and before you say "done", even if the user only said "make sure nothing broke".
---

# Structural review with Strabo

A diff shows lines. Strabo shows what those lines are connected to: the recorded import
graph, each edge with its source line, plus complexity, test reach, coverage, tiers, and
declared rules. A structural review answers the questions a line-by-line read misses:

- Did this change add a dependency cycle or a wrong-way layer edge?
- How far does it reach? Who imports the changed files, and which of them is untested?
- Did a public symbol or HTTP endpoint change in a way that breaks a recorded caller?
- Did the change stay inside the area it was supposed to touch?

This complements reading the diff. Strabo doesn't judge logic or naming, so still read the
code for correctness. Use Strabo to decide where to look hardest and to back structural
claims with evidence.

## Tools

From the `strabo` MCP server (often `mcp__strabo__<tool>` in Claude Code):

| Tool | What it gives a reviewer |
| --- | --- |
| `strabo_review` | the pending working-tree change set: a compact row per file (risk, band, cycle size, top signals, edges added and removed, tests, untested dependents), riskiest first |
| `strabo_impact` | reverse-dependency impact of the pending change, or of one revision via `base`, with tier and unit per affected file |
| `get_scope_fence` | changed paths outside a declared zone (`expect` globs), and inside paths imported from outside |
| `get_uncovered_changes` | changed lines the measured coverage report doesn't cover, uncovered modified functions first |
| `get_public_api_diff` / `get_http_api_diff` | exported symbols and HTTP endpoints changed between `base` and `head`, with the recorded callers that still use them |
| `get_cycles`, `strabo_rules`, `get_smells` | current cycles, declared-rule violations, module smells, for telling new problems from old ones |
| `strabo_file` | drill into one file: importers with evidence lines, complexity, signals |

`strabo_review` reads the working tree only. To review a commit or a branch, use the
`base` argument on `strabo_impact`, `get_public_api_diff`, and `get_http_api_diff`, or the CLI:
`strabo report <repo> --base <ref> [--expect <globs>] [--format md|json]`, which produces
the full change report in one shot. `strabo check` runs the CI gates headless.

If no Strabo tools are listed and the CLI isn't installed either, say so and fall back
to an ordinary diff review. Don't imitate Strabo's output.

## Workflow

### 1. Scope the change first

A working tree often holds more than the change under review: generated files, a teammate's
stash, an unrelated fix. Decide which files belong to the change you're reviewing (from the
user, the task, or your own edits), then pass them as `paths` to `strabo_review`:

```json
{ "paths": ["src/api/v2.ts", "src/auth/**"] }
```

`paths` takes files, folders, or globs. The response carries
`scope: { matched, total }`, so you can say "reviewed 3 of 9 changed files; the other 6
are unrelated". Without `paths`, every dirty file is mixed into the risk totals.

If the change is meant to stay inside an area, run `get_scope_fence` with `expect` set to
that area. `outside` lists files that escaped the zone, and `crossing` lists files inside
the zone that code outside it imports, which is where a contract can break.

### 2. Triage with the summary

The default `strabo_review` summary is small enough to read in full. Rows come riskiest
first:

- `changeRisk` (0–100): risk of the pending change itself, from lines and complexity
  touched, references into changed symbols, and the untested share.
- `fileRisk` / `band`: how risky the file's current state is (complexity, blast radius,
  test reach). A low change in a `critical` file still deserves care.
- `cycleSize`: size of the dependency cycle the file sits in, 0 when none. `null` means
  cycle data was unavailable, not that there's no cycle.
- `edgesAdded` / `edgesRemoved`: new or dropped imports. New edges are where cycles and
  tier leaks come from.
- `untestedDependents`: direct importers no test reaches. Those are the places a regression
  would go unnoticed.

Pick the top few rows and the ones with new edges or untested dependents. Only for those,
re-call with `detail: "full"` and a narrow `paths`. That returns per-function before/after
metrics, the exact edges, the tests to run, and coverage. Calling `detail: "full"` on a
whole dirty tree is how a review ends up with a 60 KB dump.

### 3. Separate new problems from old ones

A cycle or smell on a touched file isn't automatically the change's fault. Check whether
this change introduced it:

- `edgesAdded` on the file is non-empty and one of those edges is in the cycle: introduced.
- Otherwise `get_cycles` / `get_smells` list it independently of the change: pre-existing.
  Mention it as context, not as a finding against this change.
- For a committed change, `strabo report --base <ref>` includes a structural diff of cycles,
  tier edges, and entry points that appeared or disappeared, which settles it directly.

Only an introduced problem is a blocking finding. A pre-existing one is at most a
suggestion.

### 4. Check contracts and tests

- If an exported symbol changed, `get_public_api_diff` (with `base`) lists consumers that
  still name the removed or re-signed symbol. Each one is a concrete breakage.
- If routes changed, `get_http_api_diff` classifies changes breaking, conditional, or safe,
  and names callers.
- `get_uncovered_changes` shows changed lines the coverage report doesn't cover. Coverage
  comes from the repo's own report (lcov, Cobertura, JaCoCo). If the report is missing or
  stale, the tool says so, so say so too rather than calling the change "untested".

### 5. Report

Lead with findings, ordered by severity, each tied to evidence a reader can check: a file,
and for edges the import line Strabo recorded. A useful shape:

```
Reviewed 3 of 9 changed files (others unrelated: …).

Blocking
- src/api/v2.ts now imports src/db/client.ts (line 14), which creates a
  2-file cycle with src/db/client.ts → src/api/v2.ts (line 3).

Worth a look
- src/auth/session.ts: changeRisk 62, 4 untested direct importers
  (src/routes/login.ts, …). Suggest a test on the refresh path.

Context (pre-existing, not from this change)
- src/core is in a 5-file cycle that this change doesn't touch.

Not verified
- Coverage report is 9 days old; changed-line coverage not trusted.
```

Things Strabo reported as `unavailable` or `null` go under "Not verified". Never fill them in
with a guess.

## Gotchas

- Large lists are paged at 50 and say `truncated: true` with a `nextOffset`. When a
  truncated list is the evidence for a finding, page it or say the list was truncated.
- Imports are what Strabo sees. DI, reflection, and config-driven loading are not edges;
  `get_string_edges` covers env keys, routes, and flags. "No importers" is weaker evidence
  than "these 4 importers".
- The graph follows the working tree, so re-running after a fix reflects the fix. Re-run the
  scoped `strabo_review` after addressing a finding to confirm it's gone.
