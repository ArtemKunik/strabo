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
| 12 | Frontend foundation | M0-M3 done (`ui/` esbuild bundle, keyed `ui/view.js`, observable `ui/store.js` with deep links, member map ported off `replaceChildren`); design/a11y milestones pending |
| 13 | Visual design | M0, M2-M6 done (zoom clamp + compensated labels, rail placement + dock flash, directory islands + edge contrast, chrome consolidation, type/controls/copy, first run); M1 colour budget done (R1-R9); M1a one-source-of-truth for colour pending |
| 14 | Function inventory and complexity | Done (A1-A7: body metrics, intra-file calls, Functions tab, deterministic signals incl. linear scan/sort in loops, Hotspots overlay) |
| 15 | Optional LLM narrator | Done (A8 config + provider client; A9 Functions-tab Narrate affordance with status and model-generated-narrative attribution) |
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
- **Data contracts**: Protobuf messages, OpenAPI `components.schemas`, and JSON Schema
  objects, normalised to field name, type, and required-ness.
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
`test/unit/workspace.test.ts`. The panel does not draw service flows yet.

Next: language DTO contracts and marking cross-repo flow endpoints on the map.

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
  and ARIA on tabs/menus/cards. The tokens and shared controls are what Phase 13 M4 spends;
  they land once, here.
- **M5 - Scale.** List virtualization for long panels, incremental graph overlay, and
  jsdom unit tests for panels.

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

- **M1a - One source of truth for colour.** **R11 has landed** (the canvas stylesheet is
  built from `getComputedStyle` via `graphTheme()`, so it reads the tokens rather than
  copying them); R10 and R12-R14 remain. The diagnosis below is the state before that: canvas
  could not read CSS custom properties, so `ui/strabo-view.js` hardcoded 15 hex literals
  duplicating `styles.css`.
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

  Known limit: two deep fixture paths can trim to the same tail (`…om/acme/app`). Revealing
  the full path needs hover, which needs pointer events on the layer; not done.

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
