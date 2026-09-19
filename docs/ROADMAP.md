# Strabo roadmap

This captures the product direction beyond the extraction proposal, drawn from the
"Code Map" / "Member map" reference designs and the review-overlay work. It is a plan,
not a commitment; phases land independently with unit tests and browser acceptance
scenarios.

Guiding principle is unchanged: **evidence over speculation**. Anything the scan did not
record is reported as `unavailable`, never invented.

## Status

| Phase | Theme | State |
| ----- | ----- | ----- |
| 0 | Scanner, resolvers, cache, API, browser UI, review overlays, acceptance runner | Done |
| 1 | Map legibility and interaction | Done |
| 2 | Module Passport | Done |
| 3 | Symbol extraction and Member map | Done (members, data-flow panels from recorded field access) |
| 4 | Architecture health | Done (repository and per-file axes, cohesion from member wiring) |
| 5 | Timeline and compare versions | Done (commit list + impact against a revision) |
| 6 | Release readiness | Done (`npm run test:pack`: pack, clean-consumer install, contract tests) |
| 7 | Repository picker | Done (remembered repositories, reopens the last one) |
| — | Developer Product Graph, Chat, Narrate | Out of concept |

## Phase 1 - Map legibility and interaction

Make the full graph readable and give the canvas its own controls.

- **Encoding**: node size = transitive dependents; colour = top-level directory;
  shape = kind (`diamond` = test).
- **Legend**: a "Reading the map" guide explaining size, colour, shape, and hover.
- **Hover**: hovering a node reports its blast radius without selecting it.
- **Canvas toolbar**: `Focus`, `Trace impact`, `Start path`, `Boundaries`, `Clear`.
- **Tests / components strip**: counts by directory and kind; clicking filters the map.
- **Renderer capability**: probe WebGL2 and report `GPU: WebGL2` or `GPU: canvas`.

Spec: `test/acceptance/features/map-legibility.feature`.

## Phase 2 - Module Passport

Turn the inspector into a passport for the selected file.

- **Metrics**: direct importers, blast radius, direct imports, depends-on (all).
- **Imports / Used by** lists with source evidence (line + specifier).
- **Open in Workspace** (host adapter, else repository web URL).
- **Functions**: reported as `not recorded` until Phase 3, rather than omitted.

Spec: `test/acceptance/features/module-passport.feature`.

## Phase 3 - Symbol extraction and Member map

Per-language symbol extraction plus the Member map built from it.

- Fields and methods with visibility, static/readonly, and declared type.
- Member map per class: members grouped by type, fields with types, methods as behaviour.
- **Member map view**: a full-screen workspace per file with Find member, Order, Show wiring,
  zoom levels, Explain this class, Night vision, Compare versions, Show only this flow,
  Reset layout, and a Data flow toggle.
- **Flow walkthrough**: a five-step narrative (fingerprint, members, wiring, data flow,
  consumption) with Prev / Play / Step. Each caption is derived from recorded evidence and
  says so when evidence is missing.
- `SOURCE / INPUTS -> RESOURCES / HUBS -> TRANSFORMS -> SINKS / OUTPUTS` panels joined by a
  `DATA FLOW` read/write divider, plus `EXTERNAL CONSUMPTION`.
- **Insights**: an Architecture Health radar (the Phase 4 axes) and a Dependency
  constellation of fields, methods, and repository consumers.
- Reads/writes and field-to-behaviour wiring are recorded only where the scan can prove
  them (an explicit `this.x` / `self.x`, or an unshadowed bare name), and otherwise shown
  as `unavailable`. Clusters are the connected components of that recorded wiring.
  Cross-file identifier resolution is still not claimed.

Spec: `test/acceptance/features/member-map.feature`.

## Phase 4 - Architecture health

Heuristic signals derived from the graph and symbols, each labelled as a signal rather
than a verdict: cohesion (LCOM proxy), complexity, fan-out, coupling, and coverage
(reusing test reach). Rendered as an axis score with the contributing values.

Two scopes share the same axis shape:

- **Repository** (`GET /analysis/architecture-health`) — mean of the available axes.
- **File** (`GET /analysis/file-health?file=`) — the graph axes scoped to one file, plus
  **cohesion measured from the member wiring** recorded for that file: members are nodes,
  a method is joined to every field it reads or writes, and fewer connected components
  scores higher. A file with no recorded members keeps cohesion `unavailable`.

Spec: `test/acceptance/features/architecture-health.feature`.

## Phase 5 - Timeline and compare versions

Git history as a timeline, and graph diff between two revisions. `getChangedFiles`
already accepts a base ref, so impact between revisions is the first slice.

Spec: `test/acceptance/features/timeline.feature`.

## Phase 8 - Git review

Review a commit's own changes, or the pending working tree, with per-file stats and the
dependency impact of the change set.

- `GET /analysis/review` (working tree) and `GET /analysis/review?base=<ref>` (one commit)
  return files with status and line counts, plus reverse-reachability impact.
- Commit review uses `git show --first-parent`: a bare `<ref>` diff would fold in
  uncommitted edits, and `<ref>^..<ref>` fails on a root commit.
- Working-tree review splits **staged**, **unstaged**, and **untracked**; untracked files
  are counted directly and reported as uncounted when unreadable, never as zero lines.
- `Timeline` selects a commit into the same review panel; `Review changes` (`R`) opens the
  working tree. Changed paths outside the scanned graph are listed, not annotated.

Spec: `test/acceptance/features/timeline.feature` (scenarios `@review`).

## Phase 9 - Agent delegation

Right-click any item to hand it to `opencode` or `claude` in an interactive TUI.

- `POST /delegate` allow-lists the agent, writes the prompt to a temp file, and launches a
  generated `.cmd`; `GET /delegate` and `GET /delegate/:id` expose recent launches.
- The TUI opens **interactively** with a seed naming the task file, so the operator can add
  their own instruction. `opencode run` (non-interactive) is not used; opencode's
  `--prompt` prefills the editable input, since it has no auto-submit flag.
- The repository is resolved through the scan ceiling, and prompt text never reaches a
  shell, so a delegated item cannot become command injection.
- Windows-only (`501` elsewhere); the terminal outlives the server, so the run list is a
  log rather than supervision.

## Phase 10 - Dependency risk

CVE, license, and supply-chain risk for a repository, with findings joined to the files
that import the affected package.

- `GET /analysis/risk` returns inventory, advisories, licenses, and the import index.
- Inventory parses npm (`package-lock.json`/`package.json`), Cargo (`Cargo.lock`/
  `Cargo.toml`), and Maven (`pom.xml`). A manifest-only dependency keeps `version: null`
  because only a lockfile names an exact version.
- The scan records external specifiers per file in `graph.externalImports`; they are not
  edges, because their target is outside the repository. That is the join a finding needs
  to name the importing files and their blast radius.
- Advisories come from OSV.dev (batched query, then detail per id) and licenses from
  deps.dev, classified against an SPDX policy where `OR` is least risky and `AND` most.
- Online calls are opt-in (`STRABO_RISK=online`), off by default, and cached. `POST
  /vulnerabilities` stays a host-injectable seam.

Spec: `test/acceptance/features/dependency-risk.feature`.

## Phase 6 - Release readiness

- `npm pack` and install the tarball in a clean fixture; run scan and acceptance there.
- Contract tests for `createStraboServer` and `createStraboRouter` in an embedded host.
- Verify grammar assets are present in the tarball (`parsers/vendor`).

## Phase 7 - Repository picker

Remember the repositories the operator has opened so the picker survives a restart and
reopens the last one.

- `GET /repositories` lists known repositories and the active one.
- `POST /repositories` remembers a selection; `DELETE /repositories?root=` forgets one.
- State is persisted outside the scanned tree (`STRABO_STATE_DIR`, defaulting to
  `STRABO_CACHE_DIR`) so it never dirties the working tree or invalidates the cache.
- Every remembered path is still resolved through the scan ceiling, so remembering a path
  cannot widen what Strabo may read.

Spec: `test/acceptance/features/repository-map.feature` (scenario `@repository`).

## Out of concept

`Developer Product Graph`, `Chat`, and `Narrate` are deliberately not planned here. They
are separate products or depend on capabilities Strabo does not claim.
