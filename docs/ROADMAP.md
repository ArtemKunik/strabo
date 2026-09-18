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
| 4 | Architecture health | Done (heuristic axes with derived values) |
| 5 | Timeline and compare versions | Done (commit list + impact against a revision) |
| 6 | Release readiness | Done (`npm run test:pack`: pack, clean-consumer install, contract tests) |
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
- `SOURCE / INPUTS -> RESOURCES / HUBS -> TRANSFORMS -> SINKS / OUTPUTS` panels.
- Reads/writes and field-to-behaviour wiring are recorded only where the scan can prove
  them (an explicit `this.x` / `self.x`, or an unshadowed bare name), and otherwise shown
  as `unavailable`. Cross-file identifier resolution is still not claimed.

Spec: `test/acceptance/features/member-map.feature`.

## Phase 4 - Architecture health

Heuristic signals derived from the graph and symbols, each labelled as a signal rather
than a verdict: cohesion (LCOM proxy), complexity, fan-out, coupling, and coverage
(reusing test reach). Rendered as an axis score with the contributing values.

Spec: `test/acceptance/features/architecture-health.feature`.

## Phase 5 - Timeline and compare versions

Git history as a timeline, and graph diff between two revisions. `getChangedFiles`
already accepts a base ref, so impact between revisions is the first slice.

Spec: `test/acceptance/features/timeline.feature`.

## Phase 6 - Release readiness

- `npm pack` and install the tarball in a clean fixture; run scan and acceptance there.
- Contract tests for `createStraboServer` and `createStraboRouter` in an embedded host.
- Verify grammar assets are present in the tarball (`parsers/vendor`).

## Out of concept

`Developer Product Graph`, `Chat`, and `Narrate` are deliberately not planned here. They
are separate products or depend on capabilities Strabo does not claim.
