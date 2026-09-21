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
| 11 | Multi-repo workspace | Done (backend: declared list, package flows, contracts, drift, service flows, per-fingerprint cache; A10: read-only Workspace panel; A11: HTTP/service-call flows) |
| 12 | Frontend foundation | done (`ui/` esbuild bundle, keyed `ui/view.js`, observable `ui/store.js` with deep links, member map ported off
    `replaceChildren`, shared focus ring + roving keyboard navigation, virtualized long lists + incremental graph render + jsdom panel tests) |
| 13 | Visual design | M0-M6 done (zoom clamp + compensated labels, rail placement + dock flash, directory islands + edge contrast, chrome consolidation, type/controls/copy, first run; M1 colour budget R1-R9 and M1a one-source-of-truth R10-R14) |
| 14 | Function inventory and complexity | Done (A1-A7: body metrics, intra-file calls, Functions tab, deterministic signals incl. linear scan/sort in loops, Hotspots overlay) |
| 15 | Optional LLM narrator | Done (A8 config + provider client; A9 Functions-tab Narrate affordance with status and model-generated-narrative attribution) |
| 16 | Logical grouping (System view) and tier lens | In progress (L1, L3-L6 backend, and the L0 System mode UI: units, edges, why captions; L2, L7, L8, L9-L13 remain) |
| 17 | Module quality and change impact | In progress (Q1 done: `use`/`declare` edge roles; Q2-Q8 planned) |
| 18 | Scan and analysis performance | Planned (P1-P7) |
| — | Developer Product Graph, Chat | Out of concept |

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
- **Data contracts**: Protobuf messages, OpenAPI `components.schemas`, JSON Schema objects,
  and language-native DTOs, normalised to field name, type, and required-ness.
- **Contract drift**: a contract id declared by more than one repository, with the fields
  that are missing, differently typed, or disagree on required-ness. An identical shared
  contract is kept with no deviations.
- **Service flows**: an outbound HTTP call recorded in a repository's source joined to an
  endpoint a sibling declares in its OpenAPI `paths`. The call is recorded lexically, like
  external imports: a verb-named callee (`get`/`post`/…), `fetch`, `requests.request`,
  `GetAsync`, OkHttp `url`/`URI.create`, or `reqwest::get` with a string-literal URL or
  absolute path. The endpoint takes its host and path prefix from the first `servers[0].url`
  (or Swagger 2 `host`/`basePath`). The join needs a recorded host, path, and method on both
  sides, so a relative call or a serverless endpoint is evidence without a flow, and a call
  whose method is not recorded joins only when that host and path declares exactly one method.
  An interpolated template literal is recorded with no readable path rather than guessed at.
- **Caching**: graphs come from the shared graph cache; per-repo coordinates and contracts
  are cached per git fingerprint (`strabo-workspace.json`), so an unchanged repository is
  never rescanned or re-extracted. A non-git root is not cached under a key that cannot be
  checked.
- Endpoints: `GET /workspace`, `GET /workspace/contracts`, and `GET /workspace/services`.

Slices: **A10 (done)** the read-only workspace UI. `ui/strabo-workspace.js` turns the
recorded `WorkspaceReport` into pure rows (`workspaceSummary`, `repositoryRows`, `flowRows`,
`contractRows`, `driftRows`); `renderWorkspace` (`ui/strabo-panels.js`) renders repositories,
cross-repo flows, contracts, and drift in a floating panel, saying so when a section has
nothing recorded rather than showing it empty. The panel is registered in the dock
(`ui/strabo.js`, `ui/index.html`) and opened from `window.straboTest.workspace()`. Route-level
coverage is in `test/unit/server.test.ts`; `test/acceptance/features/workspace.feature`
(`@workspace`) asserts the single-root report and the empty-section captions. **A11 (done)**
HTTP/service-call flows: `src/workspace/services.ts` extracts declared endpoints
(`extractServiceEndpoints`) and recorded outbound calls (`extractServiceCalls`), then joins
them (`computeServiceFlows`); the facts are cached per fingerprint beside coordinates and
contracts (`WORKSPACE_CACHE_VERSION` bumped to `strabo-workspace-2`), the report gains
`serviceEndpoints` and `serviceFlows`, and `GET /workspace/services` exposes them. Unit
coverage is in `test/unit/services.test.ts` and the `analyzeWorkspace` case in
`test/unit/workspace.test.ts`. **A12 (done)** service flows in the panel and on the map:
`ui/strabo-workspace.js` gains `serviceEndpointRows`/`serviceFlowRows` and `crossRepoNodeIds`
(the recorded files that the current graph actually drew, matched by path), and the summary
line counts service flows. `renderWorkspace` draws "Service endpoints" and "Service flows"
sections, stating when a section is unrecorded. Opening the workspace rings the local files
that take part in a cross-repo flow (`view.crossRepo`, a heavy dotted `ov-cross-repo` ring in
the accent hue — a relationship, not a status), cleared when the panel closes. Unit coverage
is in `test/unit/browser-core.test.ts` and `test/unit/panels.test.ts`; the `@workspace`
scenarios assert the empty-section captions. **A13 (done)** language DTO contracts:
`src/workspace/dto.ts` extracts DTOs from source and namespaces them so the same shape
matches across repositories — TypeScript interfaces and object type aliases (also `.js`),
Python `@dataclass`/pydantic `BaseModel`/`TypedDict` classes, Kotlin `data class` primary
constructors, Java and C# `record`s, and Rust structs with named fields. A DTO's id is its
bare type name, the one part two repositories share; only shapes with a clear DTO reading are
taken (a method, a nested object, or a tuple struct is skipped, never guessed at). The
extractor is lexical, like the service-call one, and prunes generated directories with the
scanner's rules. The facts are cached per fingerprint (`WORKSPACE_CACHE_VERSION` bumped to
`strabo-workspace-3`). Unit coverage is `test/unit/dto.test.ts` and the `analyzeWorkspace`
case in `test/unit/workspace.test.ts`.

**A14 (done)** the remaining DTO shapes. `src/workspace/dto.ts` now reads C++ `struct`s with
named fields (tagged `struct` only; a `typedef struct { … } Name` has no stable id and is
skipped), Java POJOs (a class read as a DTO only when it declares instance fields and its
methods are accessors, constructors, or object protocol — or it carries a Lombok annotation
that generates the accessors), and Kotlin body properties beyond the primary constructor.
Unit coverage is the added cases in `test/unit/dto.test.ts`.

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
- **M4 - Design system + a11y (done).** One `--focus-ring` token and a single `:focus-visible`
  rule give every interactive element a keyboard focus ring without showing it to the pointer
  (Phase 13 M1a keeps the value in `styles.css`). `ui/strabo-a11y.js` holds the pure roving
  index arithmetic (`rovingIndex`, `applyRovingFocus`), and the composite widgets use it:
  the dock (`role="toolbar"`) moves between chips, the canvas overflow menu (`role="menu"`)
  moves between items and Escape closes it back to its trigger, and the Module Passport tabs
  (`role="tablist"`) move and select with a roving tabindex, their panels linked by
  `aria-controls`/`aria-labelledby`. Floating windows are non-modal dialogs (`role="dialog"`,
  `aria-label`, `tabindex="-1"`): opening one focuses it, Escape closes it, and closing returns
  focus to the dock chip. Member cards carry `role="group"` and an `aria-label`. Unit coverage
  is `test/unit/a11y.test.ts`; the browser scenarios are
  `test/acceptance/features/keyboard-access.feature` (`@a11y`).
- **M5 - Scale (done).** Long lists render through a window instead of a page: `ui/strabo-virtual.js`
  holds the pure `virtualRange(scrollTop, viewportHeight, rowHeight, count, overscan)` kernel and a
  thin `createVirtualList` shell (a spacer keeps the full scroll height, the visible slice is the only
  DOM, a `ResizeObserver` redraws when a hidden panel is revealed). The Overlay panel drops its
  "Show 50 more" paging for it, so a 500-module overlay costs a viewport of rows. The graph re-render
  is incremental: `diffElements`/`diffGraph` in `ui/strabo-graph.js` compare the built elements by id,
  and `createView().render` adds, removes, or updates only what changed — clearing the post-build
  classes first so a reused node is as bare as a fresh one. Panel rendering is covered from Node by
  `test/unit/panels.test.ts`, which drives the DOM panels through jsdom (a new devDependency) rather
  than only through the browser. Unit coverage is `test/unit/virtual.test.ts`, `test/unit/graph-diff.test.ts`,
  and `test/unit/panels.test.ts`.

## Phase 13 - Visual design

A UI/UX pass over the browser app, from a review of the running product against this
repository on 2026-09-20 at 1600x950 and 1280x720. Phase 1 made the map legible at one
size; this makes it hold at every size and gives the chrome a designed identity. Ordered
by what changes the first impression most, not by effort. Every item below is an observed
defect in the running app, not a preference.

- **M0 - Zoom clamp and zoom-compensated labels.** Cytoscape node size and `font-size` are
  model units, so they scale with zoom, and `fit()` (`ui/strabo-viewport.js`) has no
  ceiling. Measured on this repository: Directories mode (5 nodes) fits at zoom `5.11`,
  rendering a 10-unit label at 51px over ~300px nodes; Files mode (192 nodes) fits at
  `0.38`, rendering the same label at 3.8px. One encoding, two unusable extremes. Clamp
  `maxZoom` / `minZoom` in `createCytoscape` and derive label `font-size` from `cy.zoom()`
  so type holds roughly 11 device pixels at any zoom. `applyLabelBudget` stays as the
  density control; this is about size, not about which labels show.
- **M1 - Colour budget.** The diagnosis: hue is spent on the wrong job. `PALETTE`
  (`ui/strabo-graph.js`) assigns seven hues to directory identity, five of which are the
  exact hex of a semantic token — `#4c9aff` = `--accent`, `#56d4b1` = `--ok`, `#f2b25c` =
  `--warn`, `#c98bf0` = `--cycle`, `#ff8f8f` ≈ `--danger` — so a directory can render in the
  amber that elsewhere means "affected by this change". It also cycles (`PALETTE[index % 7]`),
  so beyond seven directories colour maps unrelated directories together. Validated
  all-pairs against the `#10141a` surface the set fails the lightness band, CVD separation
  (`#c98bf0`↔`#4c9aff` ΔE 1.9 protan) and the normal-vision floor (`#6fb1ff`↔`#4c9aff`
  ΔE 7.3, floor 15): it carries two near-identical blues in seven slots. A node-link view is
  scored all-pairs because any two nodes can sit adjacent, and no seven-hue set clears that.

  This supersedes the narrower reading that the Directories view is monochrome because
  `topLevelDirectory` maps a slash-free block id to `.` so every block hashes the same
  string. That is true, and it is why the current view shows one blue, but it is a symptom:
  fixing the hash would restore a palette that should not be encoding identity at all.

  **Requirements.** Each channel carries one job, and the job decides the encoding:

  | Channel | Job | Encoding |
  | --- | --- | --- |
  | Position | directory identity | islands (M3, done) |
  | Size | blast radius | existing `sqrt` scale |
  | Shape | kind | existing (`diamond` = test) |
  | Hue | status only | the reserved scale in R4 |
  | Accent | selection, focus, links, hubs | `--accent`, nothing else |

  - **R1 — Hue is reserved.** Outside the status scale (R4), the accent (R7) and the bounded
    categorical set (R8), nothing on the map or in a panel carries a hue. A colour that is
    not in one of those three sets is a defect, not a decoration.
  - **R2 — Directory identity is not encoded by hue.** `PALETTE`, `paletteColor` and the
    `paletteIndex` field are removed rather than repaired. Directory is a 20+ category
    variable; position already carries it and reads at every zoom.
  - **R3 — One neutral node fill.** `--node-fill: #6b7a8d` (4.22:1 on `--bg-1`), full
    opacity, with `--node-line` as the hairline ring. It is near-achromatic, so any status
    hue beside it reads as the marked one even at equal lightness. Node fill does not vary
    by directory, language, or kind.
  - **R4 — The status scale is fixed and reserved.** Four steps, never themed, never reused
    for identity. Measured against `--bg-1` `#10141a` and `--bg-2` `#161c24`:

    | Token | Hex | on `--bg-1` | on `--bg-2` | Carries |
    | --- | --- | --- | --- | --- |
    | `--status-good` | `#0ca30c` | 5.51 | 5.11 | health up, severity low |
    | `--status-warning` | `#fab219` | 10.07 | 9.34 | affected, severity moderate |
    | `--status-serious` | `#ec835a` | 7.00 | 6.49 | cycle member, severity high |
    | `--status-critical` | `#d03b3b` | 3.84 | 3.57 | changed, severity critical |

    All four clear 3:1. They replace `--ok`, `--warn`, `--danger`, `--cycle` and the
    untokenized `#ff8f5c`.
  - **R5 — At most two status hues on the map at once.** `overlayFor` switches on one overlay
    kind, and each node takes one class, so only `ov-changed` + `ov-affected` (impact and
    review) ever co-occur; `ov-cycle` and `ov-unreached` each render alone. The scale does
    not have to separate four ways on canvas — `critical`↔`warning` is the only pair that
    must, and it separates on both lightness and hue.
  - **R6 — Status never carries meaning by hue alone.** Every status colour ships with a
    text label, an icon, or a shape difference. `warning`↔`serious` measure ΔE 13.6
    unsimulated, below the 15 floor, so the pairing is the mitigation, not a nicety. The risk
    chips already satisfy this (`CRITICAL`, `HIGH`); the graph overlays do not and must gain
    a border-style or label difference alongside the hue.
  - **R7 — The accent is reserved for interaction.** `--accent` `#4c9aff` marks selection,
    focus, links and hubs, and nothing else. No status, series or fill may use it.
  - **R8 — Bounded categorical is capped at three plus "other".** The member-map clusters
    (`.cluster-1..7`, assigned `(cluster.index % 7) + 1` in `ui/strabo-panels.js`) are the
    only genuine categorical set. Cluster cards sit adjacent, so the set is scored all-pairs;
    three hues clear every gate on this surface — `--series-1: #3987e5` (5.08:1),
    `--series-2: #d95926` (4.76:1), `--series-3: #199e70` (5.42:1), worst CVD ΔE 9.4, worst
    normal-vision ΔE 20.9. The fourth and later clusters take one neutral `--series-other`.
    Hues are assigned in fixed order and never cycled: `% 7` is removed.
  - **R9 — Edge contrast floor.** Edges clear 3:1 against `--bg-1`. The current `#3a4a5e` at
    0.55 opacity measures 2.04:1 and reads as haze at 0.38 zoom; `#55697f` measures 3.27:1.
    Non-neighbourhood edges dim on hover rather than all 454 drawing at equal weight.

  **Acceptance.** A unit test asserts: `PALETTE` no longer exists; every status token clears
  3:1 on `--bg-1` and `--bg-2`; the categorical set is three entries and is not indexed
  modulo its length. An acceptance scenario asserts an impacted node and a changed node
  differ by something other than hue.

  **Landed.** `PALETTE`, `paletteColor`, `paletteKey`, `assignPaletteIndexes`,
  `PALETTE_SIZE` and the `paletteIndex` field are removed; `src/analysis/palette.ts` becomes
  `src/analysis/directory.ts` with only `topLevelDirectory` and `blockRegion`. The status
  scale (`--status-good/warning/serious/critical`) replaces `--ok`, `--warn`, `--danger`,
  `--cycle` and the untokenized `#ff8f5c`; the `--graph-*` status tokens alias it. Node fill
  is one neutral `--node-fill` with `--node-line`; the canvas no longer reads a per-node
  colour. Overlay borders differ by shape (`ov-changed` solid, `ov-affected` dotted,
  `ov-cycle` double, `ov-unreached` dashed, `ov-hotspot` dotted) so the changed/affected
  pair is distinguishable without hue. `--graph-edge` is `#55697f` at full opacity and
  non-incident edges dim on hover. Clusters use `clusterSeriesClass` → `series-1..3` plus
  `series-other`, with no modulo. Unit coverage is `test/unit/colors.test.ts` and
  `test/unit/directory.test.ts`; the browser scenario is
  `test/acceptance/features/colour-budget.feature` (`@colors`).

- **M1a - One source of truth for colour.** **Landed.** Every colour is defined once in
  `:root` (R10, enforced by `test/unit/colors.test.ts`), the canvas reads the tokens
  (`graphTheme`/`cssVar`) rather than copying them (R11), the alias names are gone (R12), and
  alpha comes from a `--wash`/`--hairline`/`--veil` scale with the six floating-panel
  backgrounds collapsed to one `--veiled-surface` (R13). The diagnosis below is the state
  before the work: canvas could not read CSS custom properties, so `ui/strabo-view.js`
  hardcoded 15 hex literals duplicating `styles.css`.
  They have already drifted — danger is `#ff5c5c` in CSS and `#ff8f8f` on canvas, `#7fb4ff`
  exists only in JS, `#ff8f5c` only in CSS and untokenized. The token set has the same
  problem internally: `--bg`/`--bg-1`, `--panel`/`--bg-2` and `--muted`/`--ink-3` are each
  one hex under two names (`--muted` 44 uses, `--ink-3` 23), while `--ink` `#e7edf5` and
  `--ink-1` `#eef3fa` are *different* hexes both used as primary text, 9 uses each, so body
  copy is two tones depending on which name a rule reached for. Add six near-identical
  floating-panel backgrounds and alpha applied ad hoc as 8-digit hex (`#9ad46a55`,
  `#4c9aff33`, `#6fb1ff14`).

  **Requirements.**

  - **R10 — Every colour is defined once, in `:root`.** No hex literal, `rgb()` or `rgba()`
    appears anywhere else in `ui/styles.css` or in any `ui/*.js` module.
  - **R11 — The canvas reads the tokens rather than copying them.** The Cytoscape stylesheet
    is built at startup from `getComputedStyle(document.documentElement)`, so `styles.css`
    stays the single definition and the two cannot drift again.
  - **R12 — One name per value.** The scale is the surviving vocabulary and the ad-hoc
    aliases are removed, so a rule cannot reach for a second name and get a second colour:

    | Removed | Replaced by | Uses to migrate |
    | --- | --- | --- |
    | `--bg` | `--bg-1` | 1 |
    | `--panel` | `--bg-2` | 7 |
    | `--muted` | `--ink-3` | 44 |
    | `--ink` (`#e7edf5`) | `--ink-1` (`#eef3fa`) | 9 |
    | `--mono` | `--font-mono` | 3 |

  - **R13 — Alpha comes from a scale, not from a literal.** Three steps — a wash, a border
    and a veil — replace the ad-hoc 8-digit hexes and the twelve `rgba()` mixes. The six
    floating-panel backgrounds collapse to one veiled surface token.
  - **R14 — Text contrast is not in scope.** Every ink token already clears AA on every
    surface (`--ink-3` 6.9:1, `--danger` 6.1:1). Nothing here changes an ink value, and no
    time is spent re-checking them.

  **Acceptance.** A unit test greps `ui/styles.css` and `ui/*.js` for colour literals outside
  the `:root` block and fails on any hit — R10 and R12 are then enforced rather than agreed.

- **M2 - Panel placement.** Floating windows open at fixed points and overlap both the
  canvas and each other: the legend's default position covers a node, the timeline covers
  the first five canvas-toolbar buttons, and selecting `Architecture health` opens the
  overlay panel underneath the timeline, so the result of the action is invisible. Give
  windows a default home in a right-hand rail, place each new window in the first free slot
  rather than a fixed offset, and raise-to-front plus flash the dock chip on open.
  `ui/strabo-float.js` already owns drag, collapse, and persistence, so this is placement
  policy rather than a rewrite.
- **M3 - Structure at scale (islands done).** `buildPositions` already packed nodes into
  directory islands, but nothing drew them, so a 192-node view read as a grid of unrelated
  dots. `ui/strabo-islands.js` now derives a plate per directory as the bounding box of the
  members the layout already grouped — no second layout, and nothing moves when plates are
  drawn or hidden. `createIslandLayer` (`ui/strabo-view.js`) paints them on an SVG plane
  that is the first child of the Cytoscape container, so it sits over the container
  background and under every node and edge, and survives the opt-in WebGL renderer setting
  an opaque inline background there. The layer is `aria-hidden` and takes no pointer
  events: a click on "an island" is a click on the canvas, which still clears the selection.

  Bounds are model coordinates recomputed only when the node set changes; pan and zoom
  re-project them (`rendered = model * zoom + pan`). Filtering shrinks an island to its
  surviving members and drops a directory filtered out entirely. Plates are achromatic
  (`--island-fill`, `--island-line`) so they read as structure, not status — M1's rule
  applied before M1 lands. Labels hold one device size at any zoom (the M0 lesson), sit in
  the gap above their plate rather than behind the first row of nodes, and are trimmed to
  the tail (`…/acceptance/steps`) so they never overflow onto the neighbouring island; a
  plate too small to name drops its label rather than overflowing. Islands are file-mode
  only — block mode already aggregates a directory into a node, so every top-level block
  would land in one island spanning the map.

  Two deep fixture paths can trim to the same tail (`…om/acme/app`). Hovering such a plate
  now reveals the full recorded directory: `islandHit`/`islandTooltipText`
  (`ui/strabo-islands.js`) pick the smallest plate whose drawn label was trimmed, and the
  layer shows the full path and member count as a caption. The caption is hit-tested from
  the painted boxes rather than from pointer events on the plates, so the layer stays
  `pointer-events: none` and a click on "an island" still clears the selection through the
  canvas. Unit coverage is in `test/unit/islands.test.ts`.

  Spec: `test/acceptance/features/map-legibility.feature` (`@islands`),
  `test/unit/islands.test.ts`.

  Edge contrast (`--graph-edge` `#55697f`, clearing 3:1 on `--bg-1`) and the dimming of
  non-neighbourhood edges on hover are now covered by M1 R9.
- **M4 - Chrome consolidation.** The map is ringed by eight control surfaces: toolbar,
  breadcrumb, canvas toolbar, panel dock, tests strip, status bar, zoom controls, and the
  node counter. At 1280px the toolbar wraps to two rows and the dock overlaps a node label.
  Fold the breadcrumb into the toolbar, make the canvas toolbar icon-only with an overflow
  menu (keeping the F/I/P/B/T/R/V keys and their tooltips), and merge strip, dock, and
  status bar into one bottom bar. Consumes the Phase 12 M4 tokens and shared controls.
- **M5 - Type, controls, and copy.** A single 11/12/13px range at one weight leaves the
  chrome without hierarchy; native `<select>` elements sit beside custom-styled buttons;
  and the uppercase field labels (`REPOSITORY`, `DETAIL`, `FILTER`, `REVIEW`) spend toolbar
  width restating what each control already shows. Adopt a type scale, style or replace the
  selects, and move internal vocabulary (`cache: miss`, `renderer: canvas`, `excluded 105`,
  `diagnostics 0`) behind Diagnostics — the header should count files and dependencies and
  stop there. Split the legend in two: a visual key for size, colour, and shape, and a
  shortcut sheet on `?`, rather than one box mixing encoding with keyboard gestures.
- **M6 - First run.** Opening a repository renders a map and a legend with no suggested
  first action. Say what to click.

This phase changes presentation only. No item here alters what the scan records or what
the API reports, so `evidence over speculation` is unaffected: M1 and M5 exist precisely
because the legend currently claims an encoding the view does not carry.

## Phase 14 - Function inventory and complexity

Per-function facts for the languages that have a symbol extractor (TypeScript/TSX, Java,
Kotlin, Rust, C#), then deterministic complexity signals on top. Languages without an
extractor keep reporting `not-implemented` rather than an empty list.

- **Body metrics** are counted from the parse tree, not estimated from text: span, statement
  count, decision points (a cyclomatic-complexity proxy starting at 1), max nesting depth,
  and loop count. A function whose body the extractor could not read carries no `metrics`,
  never a fabricated zero.
- **Intra-file calls** only: a recorded call is `this.x()` / `self.x()` / `Type.x()` or a bare
  name that resolves to a function declared in the same file. Cross-file and dynamic calls
  stay unclaimed, matching the `MemberAccess` confidence rule.
- **Functions tab** in the Module Passport: signature, span, parameters, decision points,
  nesting, and recorded callees.
- **Bad-algorithm signals** are derived from the recorded metrics and loop context:
  nested loops (loop nesting ≥ 2), a linear scan (`includes` / `indexOf` / `contains` / `find`…)
  or a sort inside a loop, deep nesting (≥ 4), high complexity (≥ 10 decision points), long
  body (≥ 50 lines), many parameters (≥ 5), and recorded recursion. The scan/sort sets are
  per-language and name-based, and every signal carries its source line and the value that
  tripped it, never a verdict.
- **Hotspots** overlay: the functions that trip at least one signal, across the repository,
  ranked worst-first, with their files marked on the map.

Slices: **A1 (done)** contract (`FunctionMetrics`, `FunctionCall`), shared
`collectFunctionMetrics`, TypeScript rule pack, unit tests. **A2 (done)** the same rule packs
for Java, Kotlin, Rust, and C#. **A3 (done)** intra-file calls and the `recursive` metric for
all five languages; a member call on a value (`obj.method()`) is not claimed. **A4 (done)**
`buildFunctions` (`src/analysis/functions.ts`), returned by `/symbols` as `functions`, with
callees and intra-file callers. **A5 (done)** the Module Passport **Functions** tab, rendering
each function's signature, span, complexity, nesting, loops, recursion, recorded callees, and
callers; a language without an extractor and a file with no functions each say so. Unit tests
cover the caption helpers and a browser scenario (`module-passport.feature` `@functions`)
asserts the tab. **A6 (done)** `computeSignals` (`src/analysis/signals.ts`) over the recorded
metrics, `loopNestingDepth` as a metric, `rankHotspots` (`src/analysis/hotspots.ts`),
`GET /analysis/functions`, and the **Function hotspots** review overlay with its `ov-hotspot`
class. **A7 (done)** loop-context call signals: per-language `linearScanCalls` / `sortCalls`
name sets, `loopScans` / `loopSorts` on the metrics, and the `linear-scan-in-loop` /
`sort-in-loop` signals, so a linear scan or sort inside a loop is recorded with the callee
names.

## Phase 15 - Optional LLM narrator

An opt-in narrative layer over recorded evidence. **Off by default**, modelled on the
`RiskConfig` seam, so a local scan never contacts a third party unless the operator asks.

- The operator supplies the chat/completions endpoint and model; nothing is called without
  them.
- Security parameters are explicit: the endpoint must be `https:` or loopback, the key comes
  from the environment, is sent as an `Authorization` header, and is never logged or
  persisted. Only recorded evidence is sent by default, size-bounded. Code is passed as
  untrusted data (delimited, with instructions inside it treated as data), and the output is
  narrative — labelled separately from recorded evidence, never executed and never written
  back to source.
- Responses are cached by git fingerprint + model + prompt version, rate-limited by a
  per-session request budget, and listed in an audit log like the delegate run list.
- When this lands, the README's "only feature that contacts a third party" wording gains
  this second opt-in provider.

Slices: **A8 (done)** the opt-in config and provider client, with no UI yet.
`NarratorConfig` (`src/types.ts`) holds only an endpoint, a model, the name of the key
environment variable, a budget, and the source opt-in — never the key. `resolveNarratorConfig`
(`src/narrator/config.ts`) refuses a non-URL or an insecure remote endpoint, so a plaintext
call off the machine cannot be sent. `createNarratorClient` (`src/narrator/client.ts`) is inert
until configured and keyed, reads the key per call, sends it only as an `Authorization: Bearer`
header, frames evidence and source as neutralised untrusted data, bounds the prompt, caches by
git fingerprint + model + prompt version, enforces a per-session budget, and records an audit
entry that never contains the key or the body. `createNarratorRouter` exposes `GET /narrator`,
`POST /narrator`, and `GET /narrator/runs`; the env vars are wired in `src/config.ts`.
**A9 (done)** the Functions-tab affordance: `ui/strabo-narrator.js` builds the recorded
evidence (`buildNarratorEvidence`) and the captions (`narratorStatusLabel`,
`narratorReplyLabel`), `renderFunctions` adds a status line and a **Narrate** button, and
`ui/strabo.js` fetches the status once and posts the evidence. The reply renders under a
"model-generated narrative — not recorded evidence" attribution, and an unconfigured narrator
says so instead of failing. A browser scenario (`module-passport.feature` `@narrator`) asserts
the inert path; it needs no endpoint, so it also proves nothing is contacted when unset.

## Phase 16 - Logical grouping (System view) and tier lens

Directory islands show where files sit on disk, not how the system is built. On a
polyglot monorepo (an Android app, several Rust services, a tool with a web UI, scripts)
the file map breaks into ~150 islands with labels like `…/src` and `…handlers`, and the
edges between them turn into noise. This phase adds a **System** mode alongside
`Files` / `Directories` that groups by recorded structure instead of path prefix.

A group is formed only from evidence, strongest first, and every group says why it exists:

- **Units from build manifests**: `Cargo.toml`, `build.gradle(.kts)`, `package.json`,
  `go.mod`, `*.csproj`, `pyproject.toml`. The unit is named by its crate/package/module
  name, not its path, and nested workspaces nest.
- **Edges between units**: aggregated import counts where a language resolves across units,
  plus the recorded HTTP/service-call flows and contracts from Phase 11
  (`src/workspace/services.ts`, `contracts.ts`). In a polyglot repo these are the only edges
  that join, say, Kotlin to Rust, and they carry their endpoint labels.
- **Layers inside a unit**: from import direction (`src/analysis/depth.ts`), with a small
  per-ecosystem path-token table as a tiebreaker (Android MVVM `ui/screen` → `viewmodel` →
  `model`/`repository`; Axum/Actix `http_routes`/`handlers` → service → `db`; React
  `components` → `hooks` → `api`).
- **Communities inside a layer**: Leiden/Louvain on the import graph, labelled a *signal*
  with its internal-edge ratio. Communities are seeded from the cached previous result and
  snapped to unit/layer boundaries so they do not reshuffle between scans.
- **Periphery**: tests, `scripts`, generated code, and fixtures fold into one support shelf
  per unit instead of taking up canvas space.
- **Declared groups**: an optional `strabo.groups.yml` (glob → group name) overrides the
  derived grouping. It counts as evidence because the operator stated it.
- **Naming only by the narrator**: the Phase 15 narrator may propose a group's name and
  one-line purpose under the model-generated attribution. It never creates, merges, or
  splits a group.

The view is a C4-style drill ladder that reuses the `blocks.ts` roll-up with a different
key function (unit → layer → community instead of path prefix):

- **L0 System**: units as boxes (sized by files or LOC), with import edges plus labelled
  HTTP/contract edges, and a support shelf.
- **L1 Unit**: layer swim lanes in dependency order.
- **L2 Component**: communities inside a lane.
- **L3 Files**: today's file map, filtered to the component.

Edges that break the layer order (lower → upper) or close a cycle are highlighted. Every
group has a "why grouped" caption, e.g. *crate `server` (Cargo.toml)*, *layer: import depth
2, token `viewmodel`*, *community: 34 files, 81% of edges internal*.

Two cheap wins also apply to the existing Directories mode:

- **Chain compression and unit-anchored labels**: single-child directory chains collapse,
  and labels start at the unit root (`…rvice-rust/src/handlers` becomes `service › handlers`).
- **Adaptive depth**: a group splits only while it is over a size budget *and* the split
  keeps cohesion (internal/external edge ratio). Otherwise small siblings merge, which
  removes the long tail of 2-file islands.

Slices: **L1** manifest unit detection (`src/analysis/units.ts`): per-ecosystem manifest
readers, unit names, nesting; a file outside every unit falls into a root unit, never
dropped. **L2** chain compression and unit-anchored labels in Directories mode. **L3**
periphery classification (tests, scripts, generated, fixtures) with the rule that tripped.
**L4** `GET /analysis/system`: units, aggregated import edges, service-flow and contract
edges, plus the **System** mode at L0 with "why grouped" captions. **L5** layer assignment
per unit (depth first, tokens as a tiebreaker) and L1 swim lanes; edges that break the layer
order are flagged. **L6** communities per layer with seeded stability, and L2/L3 drill-down.
**L7** `strabo.groups.yml` declared groups, with overridden derived groups reported as such.
**L8** narrator naming of groups, opt-in, under the existing attribution. Acceptance:
`test/acceptance/features/system-view.feature`, with a polyglot fixture (Gradle app, two
Cargo crates with an HTTP call between them, a scripts folder).

**Landed so far (L1, L3-L6 backend).** `src/analysis/units.ts` detects units from
`package.json`, `Cargo.toml`, `pom.xml`, `go.mod`, `pyproject.toml`, `build.gradle(.kts)`,
and `*.csproj`, names each by the manifest (a workspace-only manifest names no crate and is
skipped), nests a unit under its nearest enclosing unit root, and gives every file to its
longest enclosing unit; a file outside every unit falls into the root unit. It also classifies
support files (tests, scripts, generated, fixtures) with the rule that tripped.
`src/analysis/system.ts` rolls the graph up into units, aggregates the import edges between
them with sample specifiers, assigns layers inside each unit (a per-ecosystem path-token
table names them, recorded import depth orders them, and tokenless files land by depth),
and detects communities inside a layer with a deterministic greedy-modularity pass and its
internal-edge ratio. `GET /analysis/system` serves the report. **L0 (done)** the System mode:
`buildSystemViewModel` (`src/view/view-model.ts`) turns the report into the same shape the
file map renders — a node per unit labelled by its manifest name and sized by its component
count, with the recorded import edges — served at `GET /graph?system=1`; the mode select
gains a **System** option, the legend reads "box = build unit · size = files · edge =
import", the inspector shows the unit's "why grouped" caption plus its file and support
counts, islands are suppressed, and the strip lists units. Unit coverage is the added cases
in `test/unit/system.test.ts`, `test/unit/browser-core.test.ts`, and
`test/unit/islands.test.ts`. Still to do: L2 chain compression / unit-anchored labels, L7
`strabo.groups.yml`, L8 narrator group naming, the support-shelf drawing, the
`system-view.feature` acceptance scenario with its polyglot fixture, and the tier lens.

### Tier lens

Units answer "what is deployed"; **tiers** cut across units and answer "what role does
this code play". Three backend crates and an Android app each still split into API,
domain, and data code. Tiers: **Frontend**, **API surface**, **Domain/service**, **Data**,
**Integration** (outbound HTTP, queues, SDK clients), **Infra/config**, **Build/tooling**,
and **Tests**.

Each file gets one primary tier from its strongest evidence, and shows that evidence:

1. *Framework imports*: `axum` / `actix` / `express` / Spring Web routers → API; `sqlx` /
   `diesel` / `Room` / JPA / Prisma → Data; `react` / `androidx.compose` / SwiftUI →
   Frontend; `reqwest` / `retrofit` / `fetch` / message-queue clients → Integration.
2. *Annotations and macros*: `#[get("/…")]`, `@RestController`, `@Entity`, `@Dao`,
   `@Composable`.
3. *Recorded endpoints*: a file that declares a route or implements an OpenAPI operation
   is API (reusing Phase 11 service flows).
4. *File kinds*: `.sql`, `migrations/`, `.proto`, OpenAPI documents, `Dockerfile`, k8s /
   Helm / Terraform, CI workflows.
5. *Path tokens* (`handlers`, `routes`, `ui/screen`, `repository`, `db`) as a fallback only,
   labelled as the weakest evidence.

A file with strong evidence for two tiers is flagged **mixed** (e.g. a handler that runs
SQL directly) rather than forced into one tier. A file with no evidence is `unclassified`,
never guessed. `strabo.groups.yml` can declare tiers by glob, and a declared tier overrides
the derived one and says so. The rule tables are per ecosystem and live beside the
language registry, so adding a framework is data, not code.

Units get a **role** from the same evidence: *app* (has a Frontend tier or a mobile/desktop
entry), *service* (has an API tier and a server entry), *library* (only imported), *tool*
(a CLI entry or under `tools/` / `scripts/`). L0 boxes are drawn and captioned by role.

Views:

- **Tier × unit matrix**: rows are tiers in dependency order (Frontend on top, Data at the
  bottom, Infra/Build to the side), columns are units. Each cell shows file count,
  complexity, and hotspot count, and edges run between cells. An empty cell is
  information too (a service with no Data tier, an app with no tests).
- **Tier colour and filter** on the file map: colour by tier instead of top-level directory,
  or show one tier only. It stays within the Phase 13 colour budget (eight tier hues max,
  with `unclassified` neutral).
- **Direction check**: a downward edge is expected. An **upward** edge (Data → API,
  Domain → Frontend) and a **skip-layer** edge (Frontend → Data, API → Data with no Domain
  in between, where the unit has a Domain tier) are flagged with the import line.
- **Per-tier stats**: share of files, complexity, churn, test reach, and hotspot share per
  tier, e.g. *Data: 12% of files, 40% of hotspots, 20% test reach*.

**End-to-end trace** across tiers: screen → outbound HTTP call → endpoint → handler →
repository → table. Frontend and integration calls already match endpoints through service
flows. Table names come from migrations (`CREATE TABLE`, `ALTER TABLE`), from ORM entity
declarations (`@Entity`, `#[derive(FromRow)]`, `@Table`), and from string-literal SQL
(`FROM` / `INTO` / `UPDATE` / `JOIN <name>`), each labelled with its evidence. Dynamic SQL
or a table reached only through a query builder is `unavailable`. That answers "which
screens touch the `skills` table?" and gives Phase 17 a schema-change impact from a
migration all the way up to the UI.

Tier-lens slices: **L9** tier classification (`src/analysis/tiers.ts`) with per-ecosystem
rule tables, `mixed` / `unclassified`, declared overrides, and unit roles. **L10**
`GET /analysis/tiers` plus the tier colour mode and tier filter on the file map. **L11** the
tier × unit matrix with per-cell and per-tier stats. **L12** the direction check (upward and
skip-layer edges) as an overlay and in the unit swim lanes. **L13** table extraction and the
end-to-end trace (screen → endpoint → handler → repository → table). Acceptance:
`test/acceptance/features/tier-lens.feature`, with a fixture of a React client, an Axum
service with a handler that queries SQL directly (flagged `mixed` and skip-layer), a
migration, and a CI workflow.

## Phase 17 - Module quality and change impact

The Module Passport shows four graph counts. The measures needed to judge a module
already exist but are scattered (`file-health.ts`, `signals.ts` / `hotspots.ts`,
`depth.ts`, `cycles.ts`, `coverage.ts`, `ownership.ts`, `change-passport.ts`,
`review.ts`). This phase brings them together per module, ranks each one against the
repository, derives smells from them, and turns pending changes into a tiered impact.
Every number links to its evidence, and anything the scan cannot prove stays `unavailable`.

**Edge accuracy first.** A Rust `mod x;` in the crate root only declares the module tree,
yet it is recorded as an import, so the root appears to depend on every module and blast
radius is inflated (a file with 2 importers reporting a blast radius of 39). Edges get a
kind: `use` (a real dependency) or `declare` (Rust `mod`, Python `__init__` re-exports, TS
barrel `index.ts`). Blast radius and impact follow `use` edges only. `declare` edges are
still shown but not counted.

**Q1 (done).** `GraphEdge.role` is `use` or `declare`; the Rust resolver marks a `mod x;`
edge `declare`, the Python resolver marks every edge out of a `__init__.py` `declare`, and
the JS/TS scan marks a re-export out of a barrel `index.*` `declare`. `buildAdjacency` leaves
`declare` edges out of adjacency (blast radius, metrics, impact, coverage, and cycles all
read through it), with `{ includeDeclare: true }` as the opt-in for every drawn edge. Unit
coverage is the `mod declarations are declare edges` case in `test/unit/rust.test.ts` and the
`buildAdjacency` case in `test/unit/analysis.test.ts`.

**Measures**, each shown as a repository percentile plus its raw value:

- *Complexity*: LOC, function count, sum and max decision points, max nesting, and the
  share of functions that trip a Phase 14 signal.
- *Shape*: cohesion (LCOM proxy), member count, interface width, deep / shallow /
  pass-through (`depth.ts`), and instability `I = out / (in + out)`.
- *Centrality*: direct importers, blast radius (use edges), transitive dependencies, and
  cycle membership.
- *Evolution*: churn (commits in 90 days), author count and ownership fragmentation, and
  **co-change partners with no import path** (hidden coupling), from `git log`.
- *Protection*: tests that reach the module, and the share of its dependents that are tested.

**Smells** are rules over those measures. Each shows the inputs that tripped it and is a
signal, not a verdict: god module (size, members and importers high, cohesion low), hub
dependency (high in-degree and out-degree), unstable dependency (depends on a more unstable
module, per Martin's stable-dependencies principle), shotgun surgery (usually changes with
≥ N files it does not import), hidden coupling (≥ 50% co-change with no import path),
cyclic (in a strongly connected component, with the smallest edge to cut), tier leak
(`mixed` tier, or an upward or skip-layer edge from the Phase 16 tier lens), dead (no
use-importers, not an entry point, not a test), and pass-through. Feature envy needs
cross-file identifier resolution, so it stays `unavailable`.

**Composite scores**: *hotspot* = complexity percentile × churn percentile (after
Tornhill), and *risk* = hotspot × blast-radius percentile × (1 − test reach). Both come
with their inputs and are drawn on a complexity-vs-churn quadrant with the repository as
faint dots.

**Pending change.** When the file is dirty or staged, the passport shows:

1. *Functions touched*: diff hunks mapped onto recorded function spans, with before → after
   decision points, nesting, and signals introduced or resolved. This extends the change
   passport, which today compares only cohesion.
2. *Public surface*: exported or `pub` symbols added, removed, or with changed signatures.
3. *Tiered impact*: **definite** (importers whose recorded specifier names a changed symbol,
   e.g. `crate::store_skills::InMemorySkillStore`), **possible** (other direct importers),
   and **reachable** (the transitive set over use edges), instead of one flat blast radius.
4. *Structural deltas*: import edges added or removed, a new cycle, a fan-out change, and a
   layer violation once Phase 16 lands.
   A change to a migration or entity reports its **schema impact**: the tables touched,
   and through the Phase 16 table trace, the repositories, endpoints, and screens above them.
5. *Tests*: the tests that reach the change (the ones to run) and the affected dependents
   no test reaches.
6. *Change risk*: lines touched × complexity of touched functions × definite-impact size ×
   untested share, shown with its inputs.

Slices: **Q1** edge kinds (`use` / `declare`) in the resolvers, and blast radius and impact
over use edges only. **Q2** a percentile scorecard in the passport built from the existing
measures. **Q3** hunk → function mapping and per-function metric and signal deltas in the
change passport. **Q4** public-surface diff per extractor language and the definite /
possible / reachable impact tiers. **Q5** churn, author and co-change history from
`git log` (bounded window, cached by fingerprint). **Q6** hotspot and risk scores and the
quadrant. **Q7** smell rules with their tripping inputs, plus a repository-wide smells
overlay. **Q8** the pending-change risk summary and the tests to run. Acceptance:
`test/acceptance/features/module-quality.feature`, with a Rust fixture that proves `mod`
declarations no longer inflate blast radius.

## Phase 18 - Scan and analysis performance

Measure first, fix algorithms in TypeScript second, and consider a native core only if
parsing still dominates after that. The rest of the product stays in TypeScript behind the
existing `Graph` interface either way.

Likely hot spots:

- **Transitive metrics** (`computeGraphMetrics`, `src/analysis/analysis.ts`) run one
  depth-first traversal per node in each direction: O(N·(N+E)), about 10⁹ steps at 10k
  files and 50k edges. The function's own comment already names the follow-up: condense
  strongly connected components, then compute reachability as `Uint32Array` bitsets in
  reverse topological order, where a cycle's members share one set. Keep the DFS as the
  fallback when the bitset allocation (components² / 8 bytes) would exceed a memory
  budget. Expect 10–100× with no new dependency.
- **Repeated whole-graph work**: `computeGraphMetrics` and `buildAdjacency` are called from
  several analyses (e.g. `computeFileHealth` recomputes the whole graph's metrics to answer
  for one file). Memoise them per graph fingerprint and use-edge role, so a passport or
  overlay request reads cached metrics instead of recomputing them.
- **Parsing** uses `web-tree-sitter` (WASM) on one thread, with synchronous sequential
  reads (`src/scan/scan.ts`). Add a `worker_threads` pool sized to the cores, where each
  worker loads the grammars once, and a per-file parse/extract cache keyed by content hash,
  so a rescan re-parses only changed files.
- **Git history** for Phase 17 (churn, co-change): stream `git log --numstat` over a
  bounded window, cap the files per commit counted for co-change (a mass rename or format
  commit is skipped and reported), and cache by HEAD.
- **Communities** for Phase 16: a JS Leiden/Louvain implementation is adequate at 10k
  nodes. It runs per unit/layer rather than on the whole graph.

**Native core (conditional).** If parsing still dominates after the pool and cache, a Rust
scanner core (`ignore` crate walk, native tree-sitter, `rayon` parallelism, shipped via
napi-rs) covering walk + parse + extract + resolve could give another 5–20× on large
monorepos and make a watch mode practical. Its costs decide it, not its speed:

- Prebuilt binaries per platform (win/mac/linux × x64/arm64), which the Phase 6 clean-install
  check must cover, with the WASM path kept as the fallback when no binary matches.
- The per-language rule packs (symbols, function metrics, signals, member access) must be
  ported, not split across two languages.
- Contributors need a Rust toolchain.

A graph kernel compiled to WASM (reachability, communities) avoids the binary problem but
gains little over a good bitset implementation, so it is not planned.

Slices: **P1** a benchmark harness (`npm run bench`) that reports walk, read, parse,
extract, resolve, metrics, and analysis times, cold and warm, on the fixtures and on an
operator-supplied repository, with results recorded so regressions show. **P2**
condensation + bitset reachability for transitive dependents and dependencies, with the DFS
fallback and equivalence tests against it. **P3** per-fingerprint memoisation of adjacency
and graph metrics across analyses. **P4** asynchronous reads and a `worker_threads`
parse/extract pool, with deterministic output order. **P5** a content-hash parse/extract
cache in the cache directory, invalidated by grammar and extractor version. **P6** bounded,
cached git-history mining for Phase 17. **P7** decision point: re-run P1 on a large
monorepo (target 50k files). Only if parsing is still the largest share, spike the Rust
core for one language behind the same `Graph` output and compare. Acceptance: the P1
benchmark shows each slice's gain, and the graph output is unchanged byte for byte (except
timing metadata) before and after P2-P5.

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

`Developer Product Graph` and `Chat` are deliberately not planned here. They are separate
products or depend on capabilities Strabo does not claim. `Narrate` was moved to Phase 15,
where it lands strictly as an opt-in, evidence-bounded seam.
