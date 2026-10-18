---
name: strabo-structural-coding
description: Make code changes with Strabo's recorded dependency graph in the loop, so an edit is planned against the real imports, cycles, tiers, and blast radius instead of a guess. Use this whenever the Strabo MCP tools (strabo_file, strabo_impact, simulate_change, plan_extraction, ...) are available and the task is to refactor, move or rename files, split a module, extract a package, break a circular dependency, shrink a god module or long function, add an import across layers, delete code that might be dead, or diagnose a reported symptom (a crash, an out-of-memory kill, a slow path) from the candidates its recorded reading ranks. Also use it before any edit to a file with many importers or one that owns a heavy resource, even if the user did not mention Strabo or "structure".
---

# Structural coding with Strabo

Strabo scans a repository into a graph of files and the import edges between them, each edge
carrying the line and specifier it came from. It answers questions about that graph. It
does not edit code, so you still make the changes, but you can see what a change will
break before you make it and confirm afterwards that it didn't.

The point of this skill is to replace "grep for importers and hope" with three cheap steps:
**look** at the file's place in the graph, **simulate** the structural edit before touching
code, then **verify** the working tree against what you intended.

## Finding the tools

The tools come from the `strabo` MCP server (`strabo mcp`). In Claude Code they usually
appear as `mcp__strabo__<tool>`. Aliases and canonical names share one implementation:

| Alias | Canonical | Use it for |
| --- | --- | --- |
| `strabo_passport` | `get_overview` | orienting in an unfamiliar repo: entry points, hubs, cycles, untested modules |
| `strabo_file` | `get_context` | one file: importers, imports (with evidence lines), complexity, signals, tier, unit |
| `strabo_impact` | `get_impact` | who is affected by the pending change, with tier and unit per file |
| `strabo_path` | `get_dependency_path` | why A depends on B: the shortest import chain, hop by hop |
| `strabo_review` | `get_change_risk` | the pending change set, summarized per file (see the strabo-review skill) |

Plus `simulate_change`, `plan_extraction`, `get_cycles`, `get_smells`, `get_tier`,
`strabo_rules`, `get_dead_code`, `get_clones`, `get_scope_fence`, `get_retention` (what one
file holds, and whether anything recorded releases it), and `get_candidates` (the files a
reported symptom's recorded reading ranks).

If no Strabo tools are listed, check whether the CLI is available (`npx strabo-map --version`
or a local `bin/strabo.js`) and use `strabo check` / `strabo report` as a fallback. Tell the
user that MCP isn't configured. `docs/MCP.md` in the Strabo package has the `.mcp.json`
snippet.

## How to read the answers

- **Evidence over speculation.** Strabo only records an edge it could resolve. A missing
  fact comes back as `null` with a `note`, or as `unavailable` / `evidenceUnavailable` /
  `tierUnavailable`. Treat those as "unknown", never as "zero" or "no dependents", and say
  so when it matters to your decision.
- **Dynamic and string-based wiring is invisible to imports.** DI containers, reflection,
  routes, env keys, and feature flags don't show up as import edges. `get_string_edges`
  covers env, routes, and flags. For anything else, a file with no importers might still
  be loaded at runtime. Check before deleting.
- **Results are paged.** Lists cap at 50 items and say `truncated: true` with a
  `nextOffset`. Page with `offset` when the truncated list is the thing you're deciding
  on, and don't page just to be complete.
- **The graph follows the working tree.** The cache is keyed on a fingerprint of the
  repository, so asking again after you edit reflects your edits. There is no "refresh"
  step to remember.

## The loop

### 1. Look before you edit

Before changing a file that other code depends on, call `strabo_file` on it. The fields
that should change your plan:

- `importers` / blast radius: how many files break if the public surface moves. A file with
  dozens of importers deserves a compatibility shim or a staged change.
- `tier` and `unit`: which layer it belongs to (`api`, `domain`, `data`, ...) and which
  build unit. Adding an import from `domain` to `infra`, or across units, is a structural
  decision. Make it on purpose.
- complexity and `signals` (long function, deep nesting, ...): where the cost actually is.

One call that is not part of `strabo_file` but belongs at the same moment is `get_retention`:
what the file **holds**, and whether anything recorded releases it. Before changing a file
that owns a cache, engine, model, connection, or listener, read it — a field with no recorded
release path is the shape that takes a whole process down, and the response names what it
could not see, so you know which part to check by hand.

For "why does X depend on Y?", use `strabo_path` instead of reading files by hand. Every hop
names the import line, so you can open the exact place to cut.

In an unfamiliar repo, one `strabo_passport` call at the start is cheaper than browsing the
tree. It names the hubs and existing cycles, so you know which ones are yours if they show
up later.

### 2. Simulate the structural part first

`simulate_change` applies edits to a copy of the graph and reports cycles introduced or
resolved, wrong-way tier edges, declared-rule violations, files that tests would stop
reaching, and the blast radius per touched file. Nothing is written.

```json
{ "operations": [
  { "op": "cut",  "source": "src/a.ts", "target": "src/b.ts" },
  { "op": "add",  "source": "src/a.ts", "target": "src/shared/types.ts" },
  { "op": "move", "from": "src/legacy/", "to": "src/core/" }
] }
```

Use it to choose between options. When there are two ways to break a cycle, simulate both
and pick the one that resolves the cycle without adding a tier violation. Doing this in the
graph takes seconds. Discovering it after rewriting imports in ten files doesn't.

For extracting a package or module, call `plan_extraction` with `include` (globs or a bare
directory). It lists the outside files the set imports, each one to cut or take along and
how much each one drags in. It also lists the inside files the rest of the code imports,
the cycles across the boundary, the shared env/route/flag keys, and the external packages.
Turn that into the extraction plan before moving anything.

### 3. Make the change

Do the edit normally. Keep the structural intent in mind: if the simulation said "cut
a → b", make sure the edit actually removes that import rather than leaving a re-export that
keeps the edge alive.

### 4. Verify against intent

After editing:

- Call `strabo_review` with `paths` set to the files you touched. If the working tree has
  unrelated changes, `paths` keeps them out of the answer. Check the per-file `changeRisk`,
  `band`, `cycleSize`, and `edgesAdded`. A non-zero `cycleSize` on a file you touched means
  it's in a cycle. Use `get_cycles` to see whether it's a cycle you created or one that was
  already there.
- If you meant to resolve a cycle, `get_cycles` should no longer list it. If you meant to
  stay inside a zone, `get_scope_fence` with `expect` should report nothing outside it.
- If the repo declares rules (`strabo.rules.yml`), check `strabo_rules` for new violations.
- Run the tests listed in `testsToRun` (use `detail: "full"` on `strabo_review`, or
  `strabo_file`) rather than the whole suite when the suite is slow. Do mention which
  ones you ran.

If verification shows a structural effect you didn't intend, such as a new edge, a new
cycle, or a tier leak, fix it before reporting done. Don't just mention it.

## Recipes

**Diagnose a reported symptom.** Name the symptom as a class and ask for candidates rather
than guessing from file size:

```json
{ "issue": "crash-memory" }
```

`get_candidates` returns the files its recorded reading ranks, each with the signal and line
that ranked it, plus `notRanked`: files the reading looked at and found nothing in. Work the
candidates in order, open the named line, and stop at the first that explains the symptom — a
large, well-connected file is not the answer just because it is large, and `notRanked` is
where that counter-evidence lives. Built-in classes are `crash-memory` (the retention
reading), `slow-path` (the compute signals), and `breakage` (the change reading); declare
your own under `issues:` in `strabo.groups.yml`, where the order of `signals` is the severity
order. Follow a candidate with `get_retention` (what it holds, and what releases it) or
`strabo_file` (importers, complexity, signals). Read `unavailable` as the reading's own list of
what it could not see — establish those yourself instead of re-deriving what the recorded
evidence already answers.

**Break a cycle.** `get_cycles` → pick the cycle → `strabo_path` both directions to find
the edge that least belongs (often a type or constant import) → `simulate_change` with
`cut` (plus an `add` to wherever the shared piece will live) → edit → `get_cycles` again.

**Split a god module / long function.** `strabo_file` → read `signals` and the most complex
functions → decide where the pieces go by tier → `simulate_change` with the `add` edges the
new files will need → edit → `strabo_review` with `paths` shows the complexity and risk deltas.

**Move or rename files.** `simulate_change` with `move` to see the blast radius and any tier
or rule fallout → edit → `strabo_impact` lists every affected importer, so none get missed.

**Delete "dead" code.** `get_dead_code` lists files nothing imports that aren't entry points
or tests. Cross-check `get_string_edges` and the framework's own loading conventions before
deleting. "Nothing imports it" isn't proof that nothing loads it.

## Reporting back

When you summarize the work, include the structural facts you checked, not only the code you
changed: which cycle was resolved, the blast radius you planned around, the tier rule you
stayed inside, and anything Strabo reported as unavailable that you could not verify.
