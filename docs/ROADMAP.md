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
| 11 | Multi-repo workspace | Backend done (declared list, package flows, contracts, drift, per-fingerprint cache); workspace UI pending |
| 12 | Frontend foundation | M0-M3 done (`ui/` esbuild bundle, keyed `ui/view.js`, observable `ui/store.js` with deep links, member map ported off `replaceChildren`); design/a11y milestones pending |
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
  says so when evidence is missing. During Play the active step's region is emphasised,
  cards reveal in cluster order, and the `data flow` panels pulse while a dot falls down the
  `read / write` divider. Hovering a member traces the recorded field/method wiring.
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
- **Change passport**: every changed file's cohesion before → after, from recorded member
  wiring. The baseline content is read with `git show <base>:<path>` (HEAD for the working
  tree, the first parent for a commit), so the comparison is the recorded revision without a
  second graph scan. A language with no extractor, a new file, or a deletion names the
  missing side rather than scoring it.

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

## Phase 11 - Multi-repo workspace

Analyze several local repositories together, from an explicitly declared list. Only what the
scan recorded is drawn; nothing is inferred from names or proximity.

- Workspace config via `STRABO_CONFIG`: `{ "name": ..., "repositories": [...] }`, each root
  resolved through `STRABO_SCAN_CEILING`. Without a config the workspace is the single root.
- **Cross-repo flows**: a repository's published coordinate (`package.json` name,
  `Cargo.toml` `[package] name`, `pom.xml` `groupId:artifactId`) joined to a sibling's
  recorded external import (exact, or Maven `groupId` prefix). A coordinate claimed by two
  repositories emits both flows rather than choosing one.
- **Data contracts**: Protobuf messages, OpenAPI `components.schemas`, and JSON Schema
  objects, normalised to field name, type, and required-ness.
- **Contract drift**: a contract id declared by more than one repository, with the fields
  that are missing, differently typed, or disagree on required-ness. An identical shared
  contract is kept with no deviations.
- **Caching**: graphs come from the shared graph cache; per-repo coordinates and contracts
  are cached per git fingerprint (`strabo-workspace.json`), so an unchanged repository is
  never rescanned or re-extracted. A non-git root is not cached under a key that cannot be
  checked.
- Endpoints: `GET /workspace` and `GET /workspace/contracts`.

Next: a workspace UI, HTTP/service-call flows, and language DTO contracts.

## Phase 12 - Frontend foundation

Revamp the browser app without adopting a framework. The UI is a framework-free app that
had grown into large modules building DOM by hand and re-rendering whole panels. This phase
keeps the identity but adds a build step and a small view/state layer.

- **M0 - Build & layout (done).** UI source lives in `ui/` (ES modules, no framework) and is
  bundled by esbuild into the served `public/` (`scripts/build-ui.mjs`, `npm run build:ui`,
  part of `npm run build`). The bundle is not minified so the served code stays readable;
  Cytoscape stays a separate global script served from `node_modules`. `test:pack` asserts
  the shipped `public/` and that `ui/` source is not published. No behaviour change.
- **M1 - View layer (done).** `ui/view.js`: `h()` builds vnodes and `mount()` reconciles a
  container against them, matching children by `key` and reusing DOM nodes so focus, scroll,
  and CSS transitions survive a re-render. The tests strip (`renderTestsStrip`) is ported as
  the proof; the other panels stay on the current path until M2/M3.
- **M2 - State store (done).** `ui/store.js`: one observable store with `view`, `member`, and
  `ui` slices, plus `set`/`commit`/`subscribe`. A single subscription decides what a change
  redraws — the member map re-renders from a `member` change instead of every handler calling
  `renderMemberMapView()` by hand — and mirrors the repository, mode, selected node, and open
  panel into the URL, so a deep link reopens the member map. The graph and member-map trees
  still rebuild internally; folding them into the diff is M3.
- **M3 - Member-map render port (done).** The member map now renders through `ui/view.js`:
  the shell, toolbar, and walkthrough are vnodes, and the type sections, data-flow panels,
  health radar, constellation, and flow diagram are adopted behind `host()` keyed to the
  inputs that change them. A walkthrough tick or a zoom change reuses the cards instead of
  rebuilding, so the find input keeps focus and CSS animations do not restart. The floating
  window manager (`ui/strabo-float.js`) already provides dock, float, collapse, and
  persistence, so it was kept rather than rewritten.
- **M4 - Design system + a11y.** Tokens, shared controls, focus-visible, keyboard navigation,
  and ARIA on tabs/menus/cards.
- **M5 - Scale.** List virtualization for long panels, incremental graph overlay, and
  jsdom unit tests for panels.

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
