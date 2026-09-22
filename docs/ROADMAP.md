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
    `replaceChildren`, shared focus ring + roving keyboard navigation, virtualized long lists + incremental graph render + jsdom panel tests, panel god-module split into `ui/strabo-panel-*.js` behind a barrel) |
| 13 | Visual design | M0-M6 done (zoom clamp + compensated labels, rail placement + dock flash, directory islands + edge contrast, chrome consolidation, type/controls/copy, first run; M1 colour budget R1-R9 and M1a one-source-of-truth R10-R14) |
| 14 | Function inventory and complexity | Done (A1-A7: body metrics, intra-file calls, Functions tab, deterministic signals incl. linear scan/sort in loops, Hotspots overlay; F1-F4 done: free-function calls, entry detection with entry-aware captions, intra-file scope caption, sortable Functions table) |
| 15 | Optional LLM narrator | Done (A8 config + provider client; A9 Functions-tab Narrate affordance with status and model-generated-narrative attribution; Member-map Narrate from the recorded members and data flow); follow-ups N1-N5 done (in-app narrator setup) |
| 16 | Logical grouping (System view) and tier lens | Done (L0-L8: System view, labels, shelf, declared groups, narrator naming; tier lens L9-L13: classification, map mode, matrix panel, direction overlay, table/call trace; system drill-down L14-L17; unit cards and the single-unit case L18-L22) |
| 17 | Module quality and change impact | Q1-Q9 done (`use`/`declare` edge roles; percentile scorecard; hunk → function mapping; public-surface diff + tiered impact; bounded git history; quantitative change impact; smell rules + smells overlay; pending-change risk and tests to run; the Change impact passport card) |
| 18 | Scan and analysis performance | Planned (P1-P7; the benchmark gate is Phase 21 G4) |
| 19 | Branches | B1-B2 done (branch list with upstream sync and base divergence; branch review with trial-merge conflicts and code moved underneath; fetch / push / fast-forward sync actions); B2 is marked removed in the next evolution |
| 20 | Cross-repo and database compatibility | Done (D1-D5 backend and API; D6 Workspace panel sections for schema, gaps, table drift and code findings); the live probe is not pursued beyond this |
| 21 | Gate: verification, provenance, benchmark | Partial (G1 CI added, acceptance stays non-blocking; G2 scans Java and Python; G3 provenance audited, human sign-off blank; G4 first-paint added, no committed 20k-50k result) |
| 22 | Correctness and trust | Done except T2's symbol-reference row, which awaits a recorded count |
| 23 | Revision-aware change review | Done |
| 24 | Serve agents over MCP | Done |
| 25 | Change coupling | Done |
| 26 | Headless report and structural diff | Landed (X1-X4 done) |
| 27 | Measured coverage | Landed (V1-V4 done) |
| 28 | Repository report | Landed (Z1-Z4 done) |
| — | Interoperability: exports, headless checks, and the agent surface | Done (I1-I12; its MCP follow-up is folded into Phase 24) |
| — | Reading route | Done (W1-W4) |
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
`contractRows`, `driftRows`); `renderWorkspace` (`ui/strabo-panel-workspace.js`) renders repositories,
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

- **M6 - Panel module split (done).** The 4667-line `ui/strabo-panels.js` — the single
  module that had grown to hold every panel — is split by topic into `ui/strabo-panel-*.js`:
  a shared `kit` of DOM primitives (`button`, `backButton`, `unavailableNote`, `wiring`,
  `appendFact`, `matches`, `svgElement`), plus inspector, functions, narrative, workspace,
  members, review, branches, risk, overlay, chrome, and source modules. `ui/strabo-panels.js`
  stays as a barrel that re-exports exactly the previous 33-name public surface, so
  `ui/strabo.js` and the six jsdom suites import it unchanged. Declarations moved verbatim
  (no behaviour change); `npm run build:ui` regenerates `public/strabo.bundle.js`, and
  `test/unit/*panel*.test.ts` plus `test/unit/panels.test.ts` cover the result.

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
    (`.cluster-1..7`, assigned `(cluster.index % 7) + 1` in `ui/strabo-panel-members.js`) are the
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

### Follow-ups

Found on a real Rust test module (`tools/ccterm/src/web_ui/tests_clipboard.rs`): every
function showed "calls: none" and "called by: no callers", including a `sample_html()`
helper that the tests call.

- **Free-function calls are dropped in Rust and Kotlin.** Both extractors push a body for
  call collection only when it has an owner (`if (body && owner)` in `rust.ts` and
  `kotlin.ts`), so a top-level `fn` / `fun` records no calls and the functions it calls
  show no callers. Python, TypeScript, and C++ already push every body. The member-access
  pass is a no-op without an owner, and `collectFunctionCalls` already refuses `Self::x()`
  when the owner is empty, so the fix is to push free-function bodies too.
- **Entry points look like dead code.** A function the runtime or a framework invokes has
  no in-file caller by design: `#[test]` / `#[tokio::test]`, `@Test`, `def test_*`,
  `it(...)` / `test(...)` bodies, `main` / `#[tokio::main]`, and a function passed by
  reference (`.route("/x", get(handler))`, `::handler`, `onClick = ::save`). These are
  recorded as an **entry** of a named kind (`test`, `main`, `handler`, `passed as value at
  L42`) with the attribute or line as evidence, and "no callers" is reserved for functions
  with none of these.
- **Intra-file scope is not visible.** Callers are resolved within the file only, so "no
  callers" on a `pub` / exported function does not mean unused. The caption says
  *no callers in this file (cross-file not resolved)* for public functions.
- **The Functions tab wraps badly.** Long test names, the repeated signature, and six
  captions per row wrap over three lines. It becomes a table: one row per function, with
  columns for name, visibility or entry badge, lines, span, complexity, nesting, loops,
  calls (count), callers (count or entry badge), and signals (chips). Names are truncated
  in the middle with the full signature in a tooltip and an expandable row. Columns are
  sortable, and the default order is signal count, then complexity. Clicking a calls or
  callers count lists the call sites with line links. A summary row gives the function
  count, total and max complexity, max nesting, and signal count. It keeps roving keyboard
  navigation and uses the virtualized list for large files.

Slices: **F1 (done)** free-function bodies are pushed for call collection in Rust and
Kotlin (`if (body && owner)` → `if (body)`): the member-access pass is a no-op without an
owner and `collectFunctionCalls` already refuses `Self::x()` with an empty owner, so the
push is safe. Unit tests cover a free helper called from free functions and from methods.
**F2 (done)** entry detection per extractor language, recorded on the symbol with its
evidence (`CodeSymbol.entry`: `test` / `main` / `handler` / `passed-as-value`):
`#[test]` / `#[tokio::test]`, `@Test`, `[Test]` / `[Fact]` / `[Theory]` / `[TestMethod]`,
and test-bearing decorators above the declaration; `main` / `Main` / `#[tokio::main]` by
name; `it(...)` / `test(...)` / `describe(...)` bodies in TypeScript (threaded through the
visitor, so inline and named callbacks alike carry the call as evidence, and a named
function handed to `it`/`test`/`describe` is a test entry too); and functions passed by
reference (`::name`, `get(name)` and sibling wrappers, `.route(..., name)`, `+= name`)
with the passing line as evidence. Captions are entry-aware: an entry keeps its badge
instead of "no callers". Shared helper `src/scan/languages/entry.ts`
(`markEntries`, `isTestFrameworkCall`, `testBodyEvidence`); unit coverage is
`test/unit/function-entries.test.ts`. **F3 (done)** the public/intra-file caption:
a public function with no callers in the file says *no callers in this file (cross-file
not resolved)*, since callers resolve within the file only. **F4 (done)** the Functions
tab as a sortable table (`renderFunctionTable` in `ui/strabo-panel-functions.js`, pure helpers in
`ui/strabo-functions.js`): one row per function with columns for name, visibility or
entry badge, lines, span, complexity, nesting, loops, calls (count), callers (count or
entry badge), and signals (chips); names truncate in the middle with the full signature
as a tooltip and an expandable row; columns sort on click with signal count then
complexity as the default order (the same order `buildFunctions` now serves); clicking a
calls or callers count expands the row and lists the call sites with line links, and a
call-site button jumps to the callee's own row; a summary line gives the function count,
total and max complexity, max nesting, and signal count. Rows keep roving keyboard
navigation, and files above 100 functions render through the virtualized list with the
detail underneath. jsdom coverage is the `renderFunctions` cases in
`test/unit/panels.test.ts`, and the `module-passport.feature` `@functions` scenario
asserts the summary, the sortable columns, and the expandable detail.

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
**A10 (done)** the Member-map affordance: the same block sits under the walkthrough, and
`buildMemberNarratorEvidence` sends only the type's recorded fields, methods, and read/write
data flow (naming an unrecorded type or flow as such). The block is `host`ed on the narrator's
configured identity, so a reply survives a find keystroke or a walkthrough step. The
`member-map.feature` `@narrator` scenario asserts the inert path against the `member-repo`
fixture.
**A11 (done)** narration quality and the right-click entry. The Member-map evidence now names
the file, its recorded imports and used-by, and the function metrics, and describes members
declared straight in a file as module-level rather than as a "type" named after the file (which
the model had read as an unrecorded type name). The instruction asks for three to five
sentences on what the file appears to be for, what relies on it, and what a reviewer should
know, allows a hedged reading of paths and names, and still bars invented behaviour
(`NARRATOR_PROMPT_VERSION` is `narrator-2`, so cached replies are not reused). Replies render as
prose, inline code, and lists built from text nodes (`narrativeBlocks`, `renderNarrativeReply`),
never as HTML. Right-clicking a file or System unit offers **✦ Narrate**, which opens a
Narrator window with the reply; the entry is inactive with the reason as its tooltip while the
narrator is off or failing, and on a folder node, where there is nothing to narrate.

### Follow-ups: in-app narrator setup

**N1-N5 (done).** The narrator is now set up from the UI: `GET /narrator` reports the
effective settings, the environment lock on each field, the key source, and the provider
presets; `src/state/settings-store.ts` persists the narrator fields under the environment;
`src/narrator/key-store.ts` holds a write-only, host-bound key in the state directory with
owner-only permissions; `src/api/routes/narrator.ts` adds `GET /narrator/models`,
`POST /narrator/test`, `POST /narrator/key`, and `DELETE /narrator/key`; and the Settings →
Narrator section, the single *Narrator is off · Set up →* call to action, and the disabled
Narrate / Name group live in `ui/strabo-settings.js` and `ui/strabo-panel-narrative.js`. Anthropic
needs no adapter: its OpenAI-compatible endpoint (`https://api.anthropic.com/v1/`) fits the
existing `messages` body, so N5 resolved without a native Messages-API client.

The narrator could previously be configured only through environment variables
(`STRABO_NARRATOR_ENDPOINT`, `_MODEL`, `_KEY_ENV`, `_BUDGET`, `_SEND_SOURCE`, plus the
key in yet another variable), and an unconfigured narrator shows two overlapping lines
("Narrator is not configured…" and "Narrator unavailable: not-configured") next to a
Narrate button that only fails. The operator should be able to set it up from the UI.

- **Settings → Narrator section**, persisted through the existing settings store
  (`src/state/settings-store.ts`) alongside the scan ceiling and risk toggles:
  - *Provider preset*: Local · Ollama, Local · LM Studio, OpenAI, Anthropic, OpenRouter,
    Custom. A preset fills the endpoint and suggests models, and every field stays
    editable.
  - *Model* with **Fetch models**, which lists the provider's models where it exposes a
    model list, so a model id is picked rather than typed.
  - *API key source*: none (local endpoints), an environment variable by name (the panel
    shows whether it is set, never its value), or a key stored on this machine. The key
    field is write-only: the browser never receives a key back, only *set* / *found* /
    *missing*. A stored key lives in the state directory with owner-only permissions and
    is never logged, cached, or audited. It is the first secret Strabo writes to disk, so
    the slice includes a security review.
  - *Send source* toggle, with a caption saying that only recorded facts are sent while it
    is off, and the *request budget* per session.
  - **Test connection**: a minimal prompt that reports latency and the model that replied,
    or the problem in plain words (*401: key rejected*, *model not found: try Fetch
    models*, *remote endpoints need https*), reusing `resolveNarratorConfig` reasons and
    the provider error.
- **Environment still wins.** A value set by an environment variable shows as locked, with
  *set by STRABO_NARRATOR_MODEL*, so a managed deployment cannot be overridden from the
  browser.
- **Endpoint changes cannot redirect the key.** Changing the endpoint host clears the
  stored key and the env-var binding, and the key must be confirmed again for the new
  host. Settings writes are accepted only from the page's own origin, and the
  https-or-loopback rule is unchanged.
- **One clear call to action where it is off.** The two lines become one: *Narrator is off
  · Set up →*, which opens Settings at the Narrator section. Narrate and Name group stay
  disabled, with that reason as their tooltip, instead of being clickable and failing. A
  configured but failing narrator shows the Test connection wording.
- **Provider wire formats.** The client sends an OpenAI-style `messages` body. The
  Anthropic preset uses Anthropic's OpenAI-compatible endpoint if the current docs confirm
  it fits, and otherwise gets a small adapter for the native Messages API. The same
  applies to any other preset whose API is not OpenAI-compatible.

Slices: **N1 (done)** persisted narrator settings (endpoint, model, key source, send-source,
budget) merged under the environment, with locked-by-environment reporting in
`GET /narrator`. **N2 (done)** the Settings → Narrator section with presets, Fetch models, and
the write-only key field (env-var name or stored key), plus the host-change key reset and
same-origin check. **N3 (done)** Test connection with plain-language errors. **N4 (done)**
the single *Narrator is off · Set up →* call to action and disabled Narrate / Name group with
their reason. **N5 (done)** the Anthropic preset (OpenAI-compatible endpoint; no native
adapter needed), decided against current provider docs. Acceptance: `module-passport.feature`
`@narrator` gains
"set up from Settings against a loopback stub" and "changing the host clears the key"
scenarios, and still proves nothing is contacted while unset.

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
counts, islands are suppressed, and the strip lists units. Each unit's tests, scripts,
generated code, and fixtures fold into one **support shelf** node beside it, joined by a
`declare` edge so it never counts toward blast radius. Unit coverage is the added cases in
`test/unit/system.test.ts`, `test/unit/browser-core.test.ts`, and
`test/unit/islands.test.ts`. **L2 (done)** `compressDirectoryChains` drops an empty
single-child hop and anchors the surviving tail at the unit root, so `service-rust/src/handlers`
reads as `service › handlers`; the graph route attaches `directoryLabels` to file and block
models, and islands and block nodes prefer them. The acceptance scenario is
`test/acceptance/features/system-view.feature` (`@system`), run against the fixture
repository. **L7 (done)** `strabo.groups.yml` declared groups: `readDeclaredGroups` reads a
`groups` list of `{ name, globs }`, `applyDeclaredGroups` gives a matched file to its declared
group instead of the manifest unit, and the unit reports the derived units it took over
(`overrides`). A malformed file or a nameless/glob-less group is ignored rather than invented.
**L8 (done)** narrator group naming: select a unit in System view and **Name group** posts the
unit's recorded facts (`buildGroupNamingEvidence`) with an instruction that the narrator may
only name and describe, never create, merge, or split a group; the reply renders under the
Phase 15 model-generated attribution. The `@polyglot` scenario runs against
`test/fixtures/system-repo` (a Gradle app, two Cargo crates, a scripts folder), so the unit
detection is exercised in the browser as well as in unit tests. **L14-L17 (done)** the
System drill-down: L0 draws units only (no file nodes, no islands, no directory strip), a
unit opens on double-click or Enter into layer swim lanes and communities with the other
units collapsed and a *System › unit* breadcrumb (Escape or the breadcrumb returns, and the
deep link carries `mode=system&unit=`), selecting a file draws only its in-unit import edges
with the rest of the unit dimmed, and **Show outside links** (inspector, toolbar, `o`) adds
the selected file's cross-unit edges ending at the target unit's box with a count badge that
expands in place; trace and blast radius split the in-unit and outside counts. Served by
`buildSystemUnitViewModel` (`src/view/view-model.ts`) at `GET /graph?systemUnit=`, with
coverage in `test/unit/system.test.ts`, `test/unit/browser-core.test.ts`, and the `@units-only`,
`@open-unit`, `@unit-edges`, and `@outside` scenarios in `system-view.feature`.

**L18-L22 (done)** unit cards and the single-unit case. A System unit and its shelf are their own node kinds (`unit`, `shelf`) with their own shapes, sized by file count on a square-root scale, and the blue outline is reserved for selection (units stay out of the hub set); a unit edge widens with the rolled-up import count. One manifest-declared unit auto-opens at L1 with the note *1 build unit: showing its layers*, while a repository whose only unit is the unmanifested root fallback keeps the L0 map. Each unit draws a DOM card (`ui/strabo-unit-cards.js`, anchored under its node and reprojected on pan/zoom) with a header (name, dominant layer as role, ecosystem, manifest), stats (files, lines, languages), layer bars, a hotspot/test-reach line, and the support shelf as a muted, dashed footer strip that expands in place, so a shelf is never a peer node (`buildSystemViewModel`/`buildSystemUnitViewModel`). Hotspot counts are filled from `/analysis/functions` after the map renders, since the signals need symbol extraction. Hovering a unit reads unit vocabulary (*cargo package `ledger-api` · 12 files · depends on 2 units · used by 4 units · why: Cargo.toml*), never a blast radius. Coverage: `test/unit/unit-cards.test.ts`, `test/unit/system.test.ts`, and the `@single-unit` and `@unit-hover` scenarios in `system-view.feature`.

### System drill-down

System mode should stay at the unit level until the operator chooses a unit. The whole
file map is exactly the noise this phase exists to remove, so files are never drawn at L0,
and cross-unit file edges are shown only when asked for.

- **L0 draws units only.** No file nodes, no directory islands, and the strip lists units
  rather than top-level directories. A screenshot of System mode on SmartPositionAssistant
  still showed the directory islands and the directory strip, so check first that the mode
  actually renders the `?system=1` model, not the file model, after a mode switch and after
  a reload (a stale bundle or a server that has not been restarted can also cause it).
- **Selecting a unit opens it.** Double-click, or Enter on the focused unit (today
  `onDrill` is inert in System mode), shows that unit's files inside its frame, laid out
  by the unit's layers (swim lanes) and communities, with the other units collapsed to
  boxes around it. The breadcrumb reads *System › server-rust*, and Escape or the
  breadcrumb goes back to L0. The support shelf stays folded unless opened.
- **Selecting a file draws its relationships inside the unit.** Only the selected file's
  import edges to and from files in the same unit are drawn, with direction and the import
  line as evidence. The rest of the unit is dimmed, not hidden, so position stays stable.
- **Cross-unit relationships are an explicit action.** Nothing crosses the unit frame by
  default. A **Show outside links** action (in the inspector and the canvas toolbar, with a
  shortcut) adds the selected file's edges to other units. Each crossing edge ends at the
  target unit's box with a count badge (e.g. *3 files in daemon-rust*), and expanding the
  badge reveals those files in place. HTTP/service-call and contract edges use the same
  action and carry their endpoint label. The toggle persists per session and is part of
  the deep link.
- **Impact follows the same scope.** Trace impact and blast radius at L1 report the in-unit
  count first and the outside count separately (*12 in server-rust · 27 outside*), and the
  outside part is drawn only with the action above.

Slices: **L14** L0 renders units only (no file nodes, islands, or directory strip), with a
regression test for the mode switch and reload. **L15** unit drill-down: open a unit
(double-click / Enter), its files laid out by layer and community, other units collapsed,
breadcrumb and Escape back, deep link `mode=system&unit=`. **L16** in-unit file selection:
draw the selected file's edges within the unit and dim the rest. **L17** **Show outside
links**: cross-unit edges to target-unit boxes with count badges, expand-in-place, HTTP and
contract edges, and split impact counts. Acceptance: `system-view.feature` gains scenarios
for "no files at L0", "open a unit", "file edges stay inside the unit", and "outside links
appear only after the action".

### Unit cards and the single-unit case

On a repository with one manifest (Strabo itself), System mode draws two identical empty
squares, `strabo` and `strabo support`, both with a thick blue outline, and hovering the
shelf reads *MODULE · blast 0 · id #support*. The cause is that `buildSystemViewModel`
(`src/view/view-model.ts`) models each unit and each shelf as a `kind: 'module'` file
node, so they inherit file styling, file sizing, and the file hover card.

- **One unit skips the overview.** With a single unit, System mode opens that unit at L1
  (layer lanes, then communities) with the note *1 build unit: showing its layers* and a
  breadcrumb back to L0. L0 is shown only for two or more units.
- **The shelf is part of its unit.** It is drawn as a muted, dashed footer strip inside
  the unit card (*support: 74 tests · 6 scripts*) that expands on click. It is not a peer
  node with its own edge.
- **Units are cards with facts, not empty boxes.** Header: manifest name, role (Phase 16
  tier lens) and ecosystem (`npm`, `cargo`, `gradle`). Stats: files, LOC, and language
  mix. Layer bars with file counts, hotspot count, and test reach. The card is a DOM
  overlay that tracks node positions (units number in the tens, so there is no
  per-frame cost worth avoiding), or an HTML-label plugin if the overlay proves awkward.
  It must render in both themes and within the Phase 13 colour budget.
- **Unit and shelf hover cards use unit vocabulary.** Unit: *npm package `strabo` · 142
  files · depends on N units · used by M units · why: package.json*. Shelf: *74 test
  files, 6 scripts: folded support*. No blast radius on a shelf, and no internal `#` ids.
- **Honest sizing and styling.** A unit node is a distinct kind (`unit`, `shelf`), not
  `module`. Area is proportional to file count on a square-root scale with a minimum size,
  and the blue outline is reserved for selection.

Slices: **L18** distinct `unit` / `shelf` node kinds in the view model with their own
styles, square-root file-count sizing, and selection-only outline. **L19** single-unit
auto-open at L1 with the note and breadcrumb. **L20** unit and shelf hover cards in unit
vocabulary. **L21** the shelf as a footer strip inside the unit card, expandable in place.
**L22** unit cards with header, stats, layer bars, hotspots, and test reach. Acceptance:
`system-view.feature` gains "a single-unit repository opens at its layers" (run on the
Strabo repository itself) and "a unit hover shows unit facts, not blast radius".

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

**Q2 (done).** A percentile scorecard in the passport built from the existing measures. `src/analysis/quality.ts` computes per-module complexity (LOC, function count, sum/max decision points, max nesting, signal share), shape (cohesion from member wiring, member count, interface width, depth signal, instability), centrality (direct importers, blast radius, transitive dependencies, cycle membership), evolution (churn, author count, ownership fragmentation, hidden coupling), and protection (test reach, tested dependents share). Each measure is ranked as a repository percentile (0-100). `GET /analysis/quality` serves the scorecard. Unit coverage is `test/unit/quality.test.ts`; acceptance is `test/acceptance/features/module-quality.feature` (`@quality`).

**Q3 (done).** Hunk → function mapping and per-function metric/signal deltas in the change passport. `computeFunctionChanges` maps `git diff -U0` hunks onto recorded function spans by comparing before/after function extractions. For each touched function, the passport reports `decisionPointsBefore`/`After`, `nestingBefore`/`After`, `signalsBefore`/`After`, `signalIntroduced`, `signalResolved`, and `linesBefore`/`After`. The `CohesionChange.functions` field carries the `FunctionChange[]`. Unit coverage is the new case in `test/unit/change-passport.test.ts`.

**Q4 (done).** Public-surface diff and tiered impact in the change passport. `computePublicSurfaceDiff` extracts exported/pub symbols from before/after content per extractor language, compares their type signatures and parameters, and reports added/removed/changed-signature symbols. `computeTieredImpact` classifies importers into **definite** (recorded specifier names a changed symbol), **possible** (other direct importers), and **reachable** (transitive set over use edges). `CohesionChange.publicSurface` carries `PublicSurfaceChange[]` and `CohesionChange.impact` carries `TieredImpact`. Unit coverage is in `test/unit/change-passport.test.ts`.

**Q5 (done).** Churn, authorship, and co-change in one bounded pass. `src/analysis/history.ts` reads the window once with `git log --since --max-count --no-merges --format=%x1e%H%x1f%an --numstat` and derives all three, where the previous `computeChurn` shelled out per file and `computeCoChange` read the whole history (unbounded, no file cap) per file. A commit touching more files than the cap (default 50) is a mass change: it is recorded in `skippedCommits` and left out of co-change, so a rename or format commit cannot invent coupling. Results are cached by HEAD, window, and file set. `computeQualityScorecard` reads it and exposes `history` meta (available, window days, commits scanned, skipped commits) on the scorecard; `GET /analysis/quality` serves it. Unit coverage is `test/unit/history.test.ts`.

**Q6 (done).** Quantitative change impact. `src/analysis/change-metrics.ts` measures each changed file on both sides: complexity (summed function decision points, most complex function, nesting, signals, per-function moves), lines, cohesion, and fan-out from re-resolving the file's own imports against that side's `git ls-tree` file set. Fan-in is a delta only (change-set files that started or stopped importing a target), since an absolute before value would need a baseline rescan. Complexity `+added −removed` sums per-function moves, so a refactor that shifts branching between functions shows on both sides. Blobs are read in one `git cat-file --batch`; measures are cached in memory by content hash, and commit results on disk by commit hash (`strabo-change-metrics-*.json` beside the graph cache). `GET /analysis/review` carries `metrics` (rendered as the review panel's Change metrics table); `GET /analysis/change-metrics[?base=]` and `GET /analysis/change-metrics/history?limit=` serve the per-change-set and per-commit views, the latter shown as `cx`/`cpl` badges in the timeline. Polyglot languages resolve over their same-language working-tree files as an approximation of the baseline (bounded at 400). Unit coverage is `test/unit/change-metrics.test.ts`.

**Q7 (done).** Smell rules with their tripping inputs. `computeSmells` in `src/analysis/quality.ts` reads each module's percentiles, shape, centrality, evolution, and tier and emits `god-module`, `hub-dependency`, `unstable-dependency` (a dependency more unstable than the module, per Martin), `shotgun-surgery` (many co-change partners it does not import), `hidden-coupling` (≥ 50% of co-change with no import path), `cyclic`, `tier-leak` (a mixed tier, or an import into a higher tier), `dead` (a module nothing imports, not an entry point and not a test), and `pass-through`. Every smell carries an `inputs` record. `smellsFromScorecard` projects the per-module rules into a repository report served at `GET /analysis/smells`; the map gains a **Smells** overlay (`smellsOverlay`, `ov-smell`) and the panel names each rule. Unit coverage is `test/unit/quality.test.ts` and `test/unit/smells-overlay.test.ts`; acceptance is the `@smells` scenario in `module-quality.feature`.

**Q8 (done).** The pending-change risk summary and the tests to run. `CohesionChange` gains `testsToRun` (the test files whose forward closure reaches the changed file, from `computeTestReachByFile`), `untestedDependents` (direct dependents no test reaches), and `risk` — `linesTouched × touchedComplexity × definiteImpact × untestedShare`, each input kept — from `computeChangeRisk`. Unit coverage is `test/unit/change-passport.test.ts`. The per-module `scores` (`complexity`, `churn`, `hotspot`, `blastRadius`, `testReach`, `risk`) also ride the scorecard; the `@composites` scenario in `module-quality.feature` covers them.

**Q9 (done).** The Change impact passport card. `src/analysis/impact-passport.ts` composes one file's card from already-recorded facts: a bounded 0-100 **risk** (a weighted product of the normalised max complexity, blast radius, signal count, and untested-dependent share, with every input kept and a `LOW`/`MODERATE`/`HIGH`/`CRITICAL` band), **max and average complexity** with their before → after moves and the unchanged function/class counts, **change coherence** (the largest connected component of the changed symbols over their count, from the recorded intra-file calls), the current-graph **blast radius** and **importers / imports**, the ranked **risk signals**, and the **most complex functions** with their moves. `functionFacts` derives a side's facts once, `buildFileImpactPassport` is pure, and `rollUpImpactPassports` unions blast radius, importers, and imports over the drawn graph for the change set or revision. `CohesionChange.impactPassport` carries the per-file card, `GET /analysis/review` carries the roll-up, and `GET /analysis/impact-passport?file=` serves the Module Passport's new **Impact** tab (compared against HEAD, so a dirty file shows its growth). The shared git content reader is `src/analysis/git-content.ts`. Unit coverage is `test/unit/impact-passport.test.ts`, the route case in `test/unit/server.test.ts`, and the `renderImpactPassport` cases in `test/unit/panels.test.ts`; the card is rendered by `ui/strabo-impact.js` / `ui/strabo-panel-risk.js`.

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

**The gate (Phase 21 G4).** P1 is not only the performance plan's first slice; it gates the
delivery phases of the next evolution. Strabo exists to make large unfamiliar codebases
legible, and it has so far met fixtures and itself. Before Phase 24 lands, P1 runs on at
least one operator-supplied repository of 20k-50k files, cold and warm, and records where
time goes (walk, read, parse, extract, resolve, metrics, analysis, **git history**) and
whether the first paint of the passport, System view, and a Files-mode filter stays usable.
If a number is bad, P2-P5 come before Phase 24. Phase 23's revision graphs and Phase 25's
co-change mining add git passes of their own, so the gate times git mining too, not only the
scan.

## Phase 19 - Branches

Where every branch stands against the trunk, and what merging one would do.

- **B1 (done).** `GET /analysis/branches[?base=]` lists local branches and remote-only
  branches (a remote a local branch tracks is folded into that branch's upstream column),
  newest first and capped at 100. Each carries its tip, its sync with the upstream
  (`ahead`/`behind`/`gone`, from `%(upstream:track)`), and its divergence from the base
  (`%(ahead-behind:)` on Git 2.41+, `rev-list --left-right --count` otherwise); `merged`
  means ahead is zero. The base is the one asked for, else `origin/HEAD`, else
  `main`/`master`/`trunk`/`develop`, else HEAD, and the result names which. Counts are as
  fresh as the last fetch; Strabo never fetches.
- `GET /analysis/review?branch=<name>[&against=<base>]` reviews `merge-base..tip`, the
  pull-request comparison, so the base's newer commits never show as branch work. It adds
  `branch`: ahead/behind, the merge base, `overlap` (paths both sides changed), `conflicts`
  from a real trial merge (`git merge-tree --write-tree`, Git 2.38+, reported unavailable
  on an older Git rather than as clean), and `movedUnderneath`: base-side changes the
  branch's files import, with the nearest branch file that reaches each. Change metrics are
  measured between the two recorded revisions (`computeRangeMetrics`). Impact runs on the
  checked-out graph, and the Change passport is only computed when the branch is checked
  out, since it reads the working tree; the panel says so otherwise.
- UI: **Branches** (`N`, in the overflow menu) lists branches with a behind/ahead bar around
  the base, age, and tags (`merged`, `to push`/`to pull`, `upstream gone`, `no upstream`,
  `stale` after 90 days), with a base picker. Selecting a branch opens the review panel as
  a Branch review with the merge verdict, conflicting files, and what moved underneath,
  and annotates the map like any other review. Right-click delegation carries the verdict.
- **B2 (done).** The branch actions: `POST /analysis/branches/fetch|push|sync`. **Fetch**
  runs `git fetch --prune` on the remotes the listed branches track (else `origin`);
  **Push** appears on a local branch ahead of its upstream (a branch with no upstream gets
  **Publish**, which sets it) and never force-pushes; **Sync** runs on the checked-out
  branch — fetch, fast-forward only when behind (refusing a diverged branch or a dirty tree
  rather than merging), then push when ahead. The three are state-changing, so they are
  accepted only from the page's own origin (`isSameOriginRequest`). `src/analysis/branch-actions.ts`
  validates every branch/remote against a strict pattern before Git sees it, passes arguments
  as a vector, disables credential prompts so an unauthenticated push fails rather than
  hanging, bounds each action with a timeout, and classifies failures (`no-git`, `auth`,
  `not-fast-forward`, `dirty`, `timeout`, …). The panel shows `Fetch`/`Sync` in the header
  and `Push ↑N`/`Publish` per row, disables them while an action runs, and reloads the counts
  from the server's message. Unit coverage is `test/unit/branch-actions.test.ts` (a real bare
  remote) and the added cases in `test/unit/branches-panel.test.ts` and `test/unit/server.test.ts`.

Unit coverage is `test/unit/branches.test.ts` and `test/unit/branches-panel.test.ts`; the
browser scenario is `timeline.feature` `@branches`.

## Phase 20 - Cross-repo and database compatibility

An application is rarely one repository, and its behaviour is only half in code: the other
half is the database and the data in it. Phase 11 compares contracts that repositories
share. This phase adds the database as a workspace member, asks whether a change is safe
for the systems that depend on it, and checks a migration against real data before it runs.

The motivating failure: a new schema was rolled out on the belief that "the test data is a
mess, that is normal", and production turned out to be just as messy, so the migration
broke. Static analysis cannot see that; only a look at the data can.

Principles carry over from Phase 11 and Phase 15:

- Only what was recorded is reported. Dynamic SQL, a migration construct the parser does not
  read, and a table reached only through a query builder are named as gaps, not guessed.
- Anything that touches a live database is **opt-in and read-only**. The connection string
  is never in a config file, never persisted, never logged, and never sent to the narrator.
  Only aggregates leave the database, never rows.

Slices:

- **D1 - Schema snapshot (done).** `src/workspace/schema.ts` reads `.sql` migrations and schema
  dumps lexically and replays them in order into one snapshot per repository: tables,
  columns (type, nullability, default), primary/unique/foreign-key/check constraints, and
  indexes, each with the file and line that declared it. Migration order is the natural sort
  of the path (Flyway `V1__`, `V1.10__`, timestamped and numbered files), with dumps first
  and Flyway repeatables last; `down`/undo files are skipped. A statement the parser cannot
  interpret is listed as a gap. The snapshot is cached per git fingerprint with the other
  workspace facts and is served by `GET /workspace/schema`.
- **D2 - Code against schema (done).** ORM entities and string-literal SQL are matched with the
  snapshot: a table or column code names that no migration creates is reported, with the
  evidence line. `GET /workspace/schema/usage`.
- **D3 - Compatibility diff (done).** Two revisions of the same repository (`base` and `head`,
  default `HEAD` against the working tree) are extracted and compared. Contract and schema
  changes are classified `breaking`, `conditional` (safe for one direction only, with the
  direction named) or `safe`. `GET /workspace/compat?base=<ref>[&head=<ref>]`.
- **D4 - Migration preflight (done).** Each risky operation in a schema diff (new NOT NULL, unique,
  primary key, foreign key, check, narrowing type change, dropped column or table) becomes
  a read-only aggregate query that counts the rows that would make it fail, plus the code
  references to whatever is dropped. `GET /workspace/preflight?base=<ref>`. The queries can
  be run by the operator against any environment.
- **D5 - Live read-only probe (done).** With a database declared in the workspace config
  (`databases: [{ name, dialect, urlEnv }]`, the URL read from that environment variable),
  the preflight queries are executed inside a read-only transaction with a statement
  timeout, and the live schema is introspected and diffed against the migrations, so
  drift between the repository and the database is visible. The driver (`pg`) is an
  optional dependency loaded on demand. `POST /workspace/preflight/run`.

- **D6 - Workspace panel (done).** `ui/strabo-workspace.js` gains `schemaRows`,
  `schemaGapRows`, `schemaDriftRows`, `usageFindingRows` and `usageCaption`; `renderWorkspace` draws
  Database schema, Schema gaps, Table drift and Code against schema, and an older report with no schema
  renders with each section saying so. A **Compatibility and migrations** section
  (`renderWorkspaceTools`, enabled by `handlers.tools`) adds a base-revision field with **Compare**
  (verdict badge, reason, the code that still uses a dropped element, other repositories that declare
  the contract), **Preflight queries** (each check expands to its meaning and SQL; skipped operations
  are listed with their reason) and an **SQL script** download. **Live database** lists the declared
  databases and whether their variable is set, never its value. **Run preflight checks…** is a two-step
  action: it first states what it will do (read-only counts, no rows, connection string not stored) and
  only **Run** connects. **Read live schema** shows where the database and the migrations differ. A
  result is drawn as passed only if it ran and found nothing; a check that could not run reads "could
  not check", and one that has not run reads "not run". Status badges carry their word and a border
  style, never hue alone. Helpers: `compatRows`, `preflightRows`, `resultCaption`, `databaseRows`,
  `liveDriftRows`, `probeConsent`. Unit coverage: `test/unit/workspace-tools-panel.test.ts`. Not yet
  covered by a browser acceptance scenario.

Endpoints: `GET /workspace/schema`, `GET /workspace/schema/usage`, `GET /workspace/compat`,
`GET /workspace/preflight[?format=sql]`, `GET /workspace/databases`, `POST /workspace/preflight/run`,
`POST /workspace/live/schema`.

Known limits, named rather than hidden:

- The DDL reader is lexical. It reads `CREATE/ALTER/DROP TABLE`, `CREATE/DROP INDEX` and `RENAME` for
  PostgreSQL, MySQL, SQLite and T-SQL forms; procedural bodies, views, enums and `EXCLUDE` constraints are not
  recorded (an unreadable ALTER is listed as a gap). Object names are lower-cased, so a table created as
  a quoted mixed-case name in PostgreSQL will not match the preflight's bare identifiers.
- Compatibility does not know a contract's direction, so a required-ness change is `conditional` in both
  directions, and Protobuf field numbers are not recorded, so a renumbered field is not detected.
- Data uses in code are string-literal SQL and five ORM mappings. A query builder or an interpolated
  table records nothing.
- The preflight has no query for a conversion such as `text` to `uuid`; it lists it as skipped. A count is
  only as exact as the engine's own rules where a query is marked approximate.
- Only PostgreSQL can be probed live. The read-only guarantee rests on the read-only transaction, the
  statement timeout, the single-SELECT guard, and the API accepting no SQL; it has been exercised against
  a fake driver, not a live server, so run the first probe against a replica.

Unit coverage: `test/unit/schema.test.ts`, `test/unit/schema-usage.test.ts`,
`test/unit/compat.test.ts`, `test/unit/preflight.test.ts`, `test/unit/probe.test.ts`,
`test/unit/workspace-routes.test.ts`, `test/unit/workspace-schema-panel.test.ts`.

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

## Interoperability: exports, headless checks, and the agent surface (landed)

This shipped as phase 21 of the earlier plan and is kept here as the record of the landed
interoperability surface. Strabo's facts are already computed; they were trapped behind a
browser at the server's origin. Three consumers wanted the same facts without a human
opening the map: CI, other tools, and coding agents. It turned the existing router into a
stable headless contract and added a portable export, rather than building new analysis.
Every output stays evidence-bounded: an export carries what the scan recorded, an agent tool
answers `unavailable` where a fact was not recorded, and the CLI fails a build only on a
rule the operator explicitly asked for.

**What the comparison review changes.** The 2026 codebase-visualization comparison scores
tools on freshness, granularity, directionality and cycles, workflow fit, and
actionability, and names MCP as the workflow-fit differentiator and portable graph
formats as what makes a graph usable in CI and in docs. Strabo already answers
granularity, directionality, and cycles; this phase closes freshness, workflow fit, and
export.

### Exports

- **I1 - Portable graph export.** `GET /export?format=json|dot|mermaid|svg` and
  `strabo export [path] --format=<fmt> --out=<file>` render one deterministic artifact:
  nodes in stable id order, edges sorted, and a versioned envelope carrying the scan
  fingerprint and the revision it was built from. JSON is the graph contract
  `{ nodes, edges, diagnostics, excluded }` widened with `version`, `fingerprint`, and
  `revision`. DOT feeds Graphviz and CI; Mermaid (`graph TD`) feeds Markdown docs.
  `--include-declare` mirrors the Phase 17 `{ includeDeclare: true }` opt-in, so `declare`
  edges are drawn but marked, never silently folded into the dependency graph.
- **I2 - Static view export.** `strabo export --view=<mode> --format=svg` renders the
  deterministic view model (`src/view/view-model.ts`) to SVG, so a map can be pasted into a
  design doc or a README without running the server. Labels stay text rather than paths, so
  the output is selectable and searchable; a legend and a fingerprint caption are part of
  the artifact.

### Freshness

- **I3 - Freshness signal and rebuild.** `GET /status` returns the indexed fingerprint, the
  revision the graph was built from, the current HEAD, and how many commits the two differ
  by; the app shows an **indexed at `<sha>` (N behind)** badge with a **Rebuild** action.
  When HEAD changes and no request has run for the memory-cache window, the server rebuilds
  in the background unless `STRABO_AUTO_REBUILD=0`. Every export and every `check` result
  names the revision it was built from, so a stale artifact is visible rather than trusted.

### Headless checks

- **I4 - `strabo check`.** Runs the scanner and the analysis without the HTTP server, prints
  a human summary or `--format=json`, and exits non-zero only when an opted-in rule trips.
  Rules are named flags: `--fail-on-cycles`, `--fail-on-layer-violations` (the Phase 16
  tier direction check), `--fail-on-new-smells` (Phase 17), and
  `--fail-on-health-regression[=pct]` (Phase 4/17 axes). A fact the scan did not record is a
  warning, never a failure. Each finding names the rule, the node, and the recorded
  evidence.
- **I5 - Baseline and regression compare.** So a pre-existing problem does not block
  adoption, `strabo check --write-baseline` stores the current findings keyed by rule and
  node, and a later `check` fails only on findings absent from that baseline — the same
  before → after shape as the change passport. `--baseline=<file|ref>` reads one
  explicitly; the default lives outside the scanned tree beside the other state
  (`STRABO_STATE_DIR`).

### Agent surface

- **I6 - MCP server.** `strabo mcp` (stdio) exposes the recorded analysis as MCP tools by
  reusing the router's handlers, not a second implementation. Flagship tools:
  `get_overview`, `get_context(file)`, `get_dependency_path(from, to)`, `get_impact(file)`,
  `get_risk(file)`, `get_change_risk()`, `get_cycles`, `get_smells`, `get_tier`, and
  `get_dead_code`. Every tool returns the evidence the analysis already keeps plus an
  explicit `unavailable` reason when a fact was not recorded. The surface is read-only,
  resolves every path through the scan ceiling, is never enabled by merely starting the
  server, and inherits the boundary and same-origin rules from the HTTP API.

### Contract and distribution

- **I7 - One contract, three surfaces.** A single contract test suite runs the same
  assertions through the HTTP route, the MCP tool, and the CLI, so the three cannot drift
  (the Phase 6 pattern). A new analysis is not "done" until it answers on all three
  surfaces, or says on the record why it cannot.
- **I8 - Published demo maps.** A static export of a small set of known open-source
  repositories is built by `strabo export --site` and published (GitHub Pages), so the map
  can be seen without an install and the comparison content can point at a live artifact.
  The site is generated, never hand-edited, stamped with its revision and build date, and
  regenerated on a schedule, so it demonstrates the freshness it claims.

**Kept and left.** Keep Sourcetrail's navigation bar — exploration starts at one file and
expands outward without losing the trail — as the acceptance bar for the drill-down and for
the context an MCP tool hands an agent. Leave repowise's all-in-one platform scope, hosted
indexing, and telemetry (Strabo's non-goals), and leave treating extracted links as
compiler-proof call graphs.

**Known limits, named rather than hidden:**

- An export is a snapshot and rots until regenerated, so it carries its fingerprint and the
  site build is dated.
- MCP tools expose only recorded facts, so hidden coupling, feature envy, and cross-file
  identifier resolution stay `unavailable`, and the tool says so rather than guessing.
- `check` is a gate, not a fix: it names the rule, the node, and the evidence, and never
  rewrites code.

Acceptance: a fixture with a known cycle and a tier direction violation fails
`strabo check --fail-on-cycles --fail-on-layer-violations` and passes once those rules are
baselined; `GET /export?format=json` round-trips to the graph contract; an MCP client calls
`get_dependency_path` and receives the same evidence as `GET /analysis/impact`. Spec:
`test/acceptance/features/interoperability.feature`.

The MCP follow-up that was tracked here (tool aliases, bounded results, edge evidence,
`docs/MCP.md`) is now Phase 24, which supersedes these notes with landed states.

## Phase 21 - Gate: verification, provenance, benchmark

Finish the release-readiness work that already exists instead of starting a new initiative.

- **G1 - One green suite.** *Partial.* `.github/workflows/ci.yml` runs `npm ci`, `npm run
  typecheck`, `npm test`, `npm run build`, and `npm run test:pack` on every push and pull
  request. Acceptance is a separate `continue-on-error` job, so it does not yet gate; make it
  required once it is stable.
- **G2 - Clean-tarball proof.** *Partial.* `test:pack` (`scripts/verify-package.mjs`) packs a
  real tarball, installs it in a clean consumer, starts the shipped server entry
  (`/health`), and runs `strabo report` from the installed package (`scripts/verify-package.mjs:35-145`).
  The installed package now scans and resolves Java and Python; the extraction checklist's
  "one scan per supported language" is not yet met for the other seven.
- **G3 - Provenance.** *Partial.* `docs/PROVENANCE.md` audits the runtime dependencies, dev
  dependencies, vendored grammar `.wasm` files, and binary assets, and states the MIT question.
  Its "Pending human sign-off" table is intentionally blank; a person must confirm before the
  repository is published.
- **G4 - Benchmark (Phase 18 P1).** *Partial.* `scripts/bench.mjs` (`npm run bench`) reports
  walk, read, parse, extract, resolve, metrics, analysis, and history cold, with history also
  warm (`scripts/bench.mjs:39,146-195`), and now first paint of the passport and System view,
  cold and warm; `--out` (or `STRABO_BENCH_OUT`) writes a result under `docs/bench/`, whose
  format `docs/bench/README.md` documents. No 20k-50k-file operator repository was available,
  so no result is committed. If a number is unusable, Phase 18 P2-P5 precede Phase 24.

Acceptance: CI green on main; `docs/PROVENANCE.md` exists (sign-off pending); the benchmark
result is committed under `docs/bench/` (not yet run on an operator repository).

## Phase 22 - Correctness and trust

Numbers on screen that claim more than the evidence proves, or contradict each other.
Several items already landed in part; each entry names what remains.

- **T1 - Re-exports keep dependency paths.** *Done.* Relationship kinds are explicit —
  `import`, `re-export`, `module-declaration` (Rust `mod`), and `executable-module` (Python)
  (`src/types.ts:37,93`, `src/analysis/analysis.ts:16`) — and a barrel `index.ts` re-export is
  recorded as a `re-export`, not a bare `declare` (`src/scan/scan-js.ts:60`,
  `src/scan/languages/rust.ts:428`, `src/scan/languages/python.ts:382`). Impact and blast
  radius traverse re-exports (`buildAdjacency` `includeReExports`); direct fan-in/fan-out still
  exclude a barrel, and the passport says which (`countsIncludeReExports`).
  Acceptance: A → index.ts ⇢ B lists A at distance 2 (`test/unit/re-export-impact.test.ts`).
- **T2 - One meaning per count.** *Partial.* A unit test asserts `blastRadius >=
  directImporters` for every node of every fixture (`test/unit/impact-passport.test.ts`), and
  "Direct importers" and "Direct imports" are separate cells (`ui/strabo-impact.js`). The
  symbol-reference row renders only when the data records a count; no backend exposes one yet,
  so it stays absent rather than invented. Where a count excludes tests, both say so.
- **T3 - Recorded reference, not definite impact.** *Done.* The user-facing labels read
  "recorded reference to a changed symbol" (`src/analysis/change-passport.ts`,
  `src/analysis/review-types.ts`); "definite" survives only as an internal identifier and is
  never rendered. Evidence of connection is not evidence of a behavioural break.
- **T4 - Signals before scores.** *Done.* Change risk is contributing signals — lines touched,
  touched complexity, recorded references, untested share — each with value and threshold, plus
  an optional additive 0-100 score shown only with its components
  (`src/analysis/change-passport.ts`, `src/analysis/signals.ts` `CHANGE_RISK_THRESHOLDS`). One
  zero factor no longer erases significant risk.
- **T5 - Generated output out of every view.** *Done.* Generated directories and markers and
  lockfiles are classified and dropped from change views (`src/scan/exclusions.ts:63`,
  `src/analysis/review.ts`), and each dropped path is named in the review's `excluded` list.
  Acceptance: a commit that only rebuilds `public/app.bundle.js` yields an empty review with
  the exclusion named, as does a lockfile-only commit (`test/unit/review.test.ts`).
- **T6 - Freshness on every figure.** *Done.* `graphProvenance` — fingerprint, scan time, and
  staleness against the working tree — is attached to the repository passport, impact passport,
  change passport, and review at the route layer (`src/api/routes/analysis.ts`, reusing
  `computeFreshness`), carried by the CLI report (`src/cli/report.ts`), and drawn on each
  passport and the edge-evidence overlay (`ui/strabo-panel-*.js`).

## Phase 23 - Revision-aware change review

The change passport computes impact on the current graph and compares with HEAD. Make the
comparison honest.

- **R1 - Graphs per revision.** *Done.* The base graph is built from committed blobs via
  `git show <rev>:<path>` (`src/analysis/structural-diff.ts`; the temp worktree is gone) and
  cached by resolved commit sha: an in-memory LRU in front of an on-disk store under
  `cacheRoot()` (`REVISION_GRAPH_VERSION`, atomic writes, malformed or version-mismatched
  entries ignored and rebuilt). Acceptance: the same revision is served from cache and a
  changed revision gets a distinct key (`test/unit/revision-graph.test.ts`).
- **R2 - Comparisons named by kind.** *Done.* The review result union names
  `commit | working-tree | branch` (`src/analysis/review.ts:32`); a commit review uses
  `--first-parent` (`src/analysis/review.ts:88`), a branch review is `merge-base..tip`
  (`src/analysis/branches.ts:157,167-168`), and the panel titles each
  (`ui/strabo-panel-review.js:149-154`). A generic two-revision review is served only by
  range metrics / structural diff.
- **R3 - Function and graph deltas.** *Done.* Functions added, removed, and changed carry both
  sides' metrics and signals, and edges added and removed come from the two-graph structural
  diff (`src/analysis/change-passport.ts`, `src/analysis/change-metrics.ts`). Acceptance: a
  commit that removes an import shows the edge removed and does not list the former importer as
  affected (`test/unit/change-passport.test.ts`).
- **R4 - Approximations labelled.** *Done.* Impact cells read from the current graph are
  labelled *approximation: current graph*, with a stale note where applicable
  (`ui/strabo-impact.js`).

Acceptance: a fixture where a commit removes an import; the commit review shows the edge
removed and does not list the former importer as affected.

## Phase 24 - Serve agents over MCP

Expose recorded facts to coding agents, so an agent can ask what a file reaches before it
edits. This supersedes the earlier interoperability phase's MCP follow-up.

- **S1 - `strabo mcp [path]`.** *Done.* Stdio JSON-RPC over the same scanner, cache, and
  `resolveRepositoryRoot` boundary (`src/cli.ts:54,68-72`, `src/mcp/server.ts:100-129`).
  Read-only: only `initialize`, `ping`, `tools/list`, and `tools/call` are answered
  (`src/mcp/server.ts:39-63`). No network listener.
- **S2 - Tools returning evidence, never prose.** *Done.* `strabo_passport`, `strabo_file`,
  `strabo_impact`, `strabo_review`, and `strabo_path` are aliases of the canonical tools
  (`src/mcp/tools.ts:47-53`); `strabo_file` returns imports, importers, reach, owners, the
  source line + specifier behind each edge, and now tier and unit composed from the canonical
  tier lens, with `tierUnavailable` in the `unavailable` contract; `strabo_impact` attaches
  tier/unit to each affected entry (`src/mcp/tools.ts`, `docs/MCP.md`).
- **S3 - Bounded, paged results.** *Done.* Lists page at 50 (max 500) with `truncated`,
  `listsTruncated`, and a per-list `path/shown/total/omitted/nextOffset`; an over-cap body is
  replaced by a marker naming the cap (`src/mcp/tools.ts:16-23,108-191`).
- **S4 - `docs/MCP.md`.** *Done.* Config for Claude Code and opencode, the read-only
  boundary, and the `unavailable` contract (`docs/MCP.md`).

Delegate stays, but MCP becomes the cross-platform way agents consume Strabo.

## Phase 25 - Change coupling

`src/analysis/history.ts` builds a co-change map in one bounded git pass. Its *share* is
drawn by the `hidden-coupling` / `shotgun-surgery` smells (`src/analysis/quality.ts`,
`/analysis/smells`); its *edges* now are too. Landed.

- **K1 - A co-change edge.** *Done.* Between files that changed together in at least n
  commits above a coupling ratio (configurable, conservative defaults)
  (`src/analysis/co-change.ts:17-29,82-131`); mass commits stay excluded and are named
  (`src/analysis/history.ts:266-271`, `src/analysis/co-change.ts:46-49`). Served at
  `GET /analysis/co-change` (`src/api/routes/analysis.ts:677-693`).
- **K2 - Evidence is the commits.** *Done.* A per-pair commit list of hash, date, and subject
  is kept with a memory budget (`src/analysis/history.ts:38-55,85-94,208-235`); a pair with
  no listable commits is not drawn (`src/analysis/co-change.ts:118-122`).
- **K3 - Hidden coupling.** *Done.* A co-change pair with no transitive import path in either
  direction is detected (`src/analysis/co-change.ts:104-108,139`) and flagged `hidden` on the
  map and in the passport list (`ui/strabo-graph.js:527`,
  `ui/strabo-panel-inspector.js:345-349`), and a dedicated hidden-coupling overlay draws those
  pairs in a distinct style, off by default (`ui/strabo-overlays.js`,
  `ui/strabo-panel-overlay.js`).
- **K4 - Map and passport.** *Done.* The Module Passport gains a **Changes with** section
  (`ui/strabo-panel-inspector.js:240-252,308-369`); the map draws co-change edges in a
  distinct dashed style, off by default (`ui/strabo-stylesheet.js:95-98`,
  `ui/strabo.js:100-101,2422-2460`). The map-lens half has no unit test.

Acceptance: a fixture repository with scripted history, where a config file and its reader
share commits without an import, surfaces exactly that pair as hidden coupling.

## Phase 26 - Headless report and structural diff

Everything the Review panel shows, without a browser, focused on what changed in the
architecture rather than in the text. Builds on `strabo check` (`src/check/check.ts`,
`src/cli/check.ts`) rather than adding a fourth CLI. Landed.

- **X1 - Structural diff between two revisions.** *Done.* Dependency edges added and removed,
  cycles introduced and resolved, wrong-way tier edges added, entry points added, and newly
  unreached files, all computed from the two graphs, not the text diff
  (`src/analysis/structural-diff.ts:57-170`), with the base graph built from committed blobs
  and cached by commit (Phase 23 R1) and served at `GET /analysis/structural-diff`
  (`src/api/routes/analysis.ts:120-139`). This completes the Phase 17 pending item
  "structural deltas".
- **X2 - `strabo report [path] --base <ref> [--format md|json]`.** *Done.* Changed files,
  reach, structural diff, untested reach, and hotspots touched, as Markdown or JSON
  (`src/cli/report.ts:62-143,183-241`); `test:pack` runs it from the installed tarball
  against a fixture commit that adds a cycle (`scripts/verify-package.mjs:143-145`).
- **X3 - `--fail-on cycle,tier` for CI.** *Done.* A comma-separated rule set extending the
  existing `--fail-on-*` flags, with `cycle→cycles` and `tier→layer-violations` aliases
  (`src/check/check.ts:25-54`, `src/cli/report.ts:138-159`); a non-zero exit only for the
  conditions named, never by default. CI runs it through `test:pack` (Phase 21 G1).
- **X4 - Review panel Structure tab.** *Done.* `renderStructuralDiff` renders X1 as a
  **Structure** section in the review panel (`ui/strabo-panel-review.js:98-134,268-269`), so
  the browser and the report agree. It is a section, not a tab control.

Acceptance: `test:pack` runs `strabo report` from the installed tarball against a fixture
commit that adds a cycle, and the Markdown names that cycle.

## Phase 27 - Measured coverage

Test reach is graph reachability (`src/analysis/coverage.ts`): a file counts as reached if
some test imports its way there, which overstates coverage. Where the repository already has
measured coverage, Strabo uses it. Landed.

- **V1 - Read existing reports only, never run tests.** *Done.* `lcov.info`, Cobertura XML,
  and JaCoCo XML are parsed (`src/analysis/measured-coverage.ts:174-544`) and auto-located
  from a bounded candidate list, within the ceiling
  (`src/analysis/measured-coverage.ts:150-161,624-772`).
- **V2 - Per-file and per-function line coverage.** *Done.* Attached to the Functions tab and
  the Function hotspots overlay (`src/api/routes/symbols.ts:61-91`,
  `ui/strabo-panel-functions.js:72-76,411-416`, `ui/strabo-overlays.js:245-267`).
- **V3 - Report age beside every figure.** *Done.* Age and stale-versus-the-file's-last-change
  are computed, the last commit read with a capped `git log -1`
  (`src/analysis/measured-coverage.ts:651-653,684-687,828-852`).
- **V4 - Measured versus reachable.** *Done.* Every coverage figure carries its basis, and
  the health coverage axis uses measured when present and says so
  (`src/analysis/health.ts:83-113`, `src/analysis/file-health.ts:110-162`).

Acceptance: a fixture with an `lcov.info` where a file is imported by a test but has zero
covered lines shows reachable yet measured 0%.

## Phase 28 - Repository report

The whole-repository sibling of the Phase 26 change report: one document that reads the same
graph the canvas draws, so the browser and the report cannot disagree. It is a composition
layer over analyses that already exist, not a new analysis engine — its only job is to
gather, rank, and render what the scan already recorded. Landed.

- **Z1 - One pure builder, dumb renderers.** *Done.* `buildRepositoryReport`
  (`src/report/repository-report.ts`) assembles `RepositoryReportDocument` from the cached
  graph and the recorded analyses with no I/O of its own, and `renderReportMarkdown` /
  `renderReportHtml` are pure functions over that document, so JSON, Markdown, and HTML are
  three views of one contract (the `graph-export.ts` envelope pattern).
- **Z2 - Pain points: one list, one fixed severity.** *Done.* Cycles, tier leaks, quality
  smells, function hotspots, untested reach, bus factor, dependency advisory/licence, parse
  failures, and a stale graph are projected to a single ranked `PainPoint[]` with a stable id,
  a fixed per-kind severity (never a repository percentile), and the raw `inputs` kept on the
  item (`src/report/repository-report.ts`). Ordering is severity then path, so two runs diff
  to nothing.
- **Z3 - Deterministic suggestions.** *Done.* A flat rule table maps each pain-point kind to
  a short, actionable suggestion that cites the recorded evidence
  (`src/report/suggestions.ts`); a suggestion with no pain point behind it is never emitted.
  The opt-in narrator layer over the same facts is a later follow-up, so suggestions are
  available with no endpoint configured and never speculate.
- **Z4 - Export and surfaces.** *Done.* `strabo report [--base]` gains an optional base
  (no base = repository report, base = the Phase 26 change report) and `--format md|json|html|pdf`
  with `--out`; `strabo summary` is a thin alias that is always repository-scoped. PDF is a
  render of the self-contained HTML through a detected headless Chromium (`playwright`, else a
  system `msedge`/`chrome`), and a missing renderer names the reason and still writes the HTML
  rather than failing. `GET /analysis/report?format=` serves the same document, and the
  Repository passport panel gains an **Export report** action.

Acceptance: on a fixture with a recorded cycle and an untested reach, the Markdown report
names both under **Pain points**, each carries a suggestion, and the JSON document re-renders
to the same Markdown.

## Reading route (landed)

This was phase 22 of the earlier plan; W1-W4 have shipped. The deliverable an hour
of onboarding needs: an ordered list of what to read, assembled from recorded facts.

- **W1 - `GET /analysis/route`.** *Done.* A breadth-limited outward walk from the detected
  entry points over recorded `use` edges, each file with why it is here (reached from X at
  depth n, fan-in, tier, unit); files no entry point reaches are listed separately, never
  forced into the order (`src/analysis/route.ts`, `src/api/routes/analysis.ts:265`).
- **W2 - Honour the System view.** *Done.* One route per unit, with a unit-level summary
  before its files (`src/analysis/route.ts:60-102`).
- **W3 - Route panel.** *Done.* Steps through the files and focuses each on the map, with
  progress remembered per repository in localStorage (`ui/strabo-route.js`). A failed route
  load names the failure and offers Retry, rather than reporting an absent route.
- **W4 - Narrator tour.** *Done.* `POST /narrator/tour` builds the tour from the recorded
  passport and route (`src/narrator/tour.ts`), and the route panel renders the reply inline
  under the shared attribution, with a per-step narration control. The narrator stays opt-in,
  and the tour never changes the route or the map.

Acceptance: on the polyglot fixture the route starts at every declared entry point and no
file appears before a file that imports it within the same unit (`test/unit/route.test.ts`).

### Removed or frozen

- **Git push / sync / publish (Phase 19 B2) — removed.** Every other part of Strabo only
  reads; Git and the operator's existing workflow own state changes. The actions are still in
  the tree, so removing them is open work; branch listing and branch review stay.
- **Live database migration probes — not pursued.** Static contract and schema compatibility
  (Phase 20) is the extension; the live read-only probe (D5) stays as a labelled experiment
  and gets no follow-on.
- **Narrator and member-map presentation — freeze lifted with Phase 22.** The reading route
  landed, so the route's narrator tour (W4) shipped; the narrator keeps working over corrected
  evidence, and further narrative features follow the same evidence-first rule.
- **New languages — none until the existing nine pass Phase 22's acceptance.**
- **Colour budget.** The eight tier hues conflict with the Phase 13 budget rules; resolve in
  the rules, not by exception, before any new colour is added.
- **Out of scope, restated:** hosted or multi-user mode, and runtime tracing
  (OpenTelemetry) — a real signal, but it needs a running system, and that is a different
  product.

### Working agreement for these phases

- One slice per commit; the subject names the slice (`T2: blast radius covers importers`).
- A phase's first commit is its acceptance scenario, failing.
- A section is marked Done only when its acceptance runs in CI. Known gaps stay listed under
  the section as Open, not folded into Done.
- Before a phase is marked done, run Strabo's own review on the phase's commit range and read
  it.

## Out of concept

`Developer Product Graph` and `Chat` are deliberately not planned here. They are separate
products or depend on capabilities Strabo does not claim. `Narrate` was moved to Phase 15,
where it lands strictly as an opt-in, evidence-bounded seam.
