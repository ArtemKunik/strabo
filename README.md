# Strabo

A standalone app for understanding repository structure, dependencies, and change impact.

Strabo turns a local source repository into an interactive map of its files and
dependencies. Engineers explore the structure, trace relationships, and inspect the
source evidence behind every connection.

> **Guiding principle: evidence over speculation.**
> The map draws only edges it can resolve inside the repository. Anything uncertain is
> reported as a diagnostic, never invented as a link.

## Status

Product concept / extraction proposal. Release readiness is tracked separately.
This repository currently contains a **skeleton**: public contracts and module
boundaries are in place, implementation is stubbed.

## Form factor

Node 22+ package `strabo`, CLI `strabo`. One installable, versioned package with three
public entry points:

| Entry point     | Exposes                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `strabo`        | scanner, view model, symbol extractors, repository artifact scanner, router factory, server factory, optional lineage pack |
| `strabo/server` | `createStraboServer` — self-contained Express app serving `public/` and mounting the router at `/api/strabo` |
| `strabo` CLI    | reads `STRABO_ROOT`, `STRABO_CONFIG`, `STRABO_SCAN_CEILING`, `PORT` and starts the standalone server |

The same scanner, analysis, API, and browser UI are used in standalone and embedded
modes, so there is exactly one implementation of Strabo behaviour.

## Getting started

```sh
# install (bun preferred for local development)
bun install

# typecheck + build
bun run typecheck
bun run build

# run the standalone server against a repository
STRABO_ROOT=/path/to/repo bun run start
# or
STRABO_ROOT=/path/to/repo node bin/strabo.js
```

Then open `http://localhost:3000` (default `PORT`).

### Environment

| Variable             | Meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| `STRABO_ROOT`        | Repository root to scan and serve.                             |
| `STRABO_CONFIG`      | Path to a Strabo config file (catalogue, integrations).        |
| `STRABO_SCAN_CEILING`| Filesystem boundary Strabo may read from. Defaults to root.   |
| `STRABO_CACHE_DIR`   | Where scan artifacts are persisted. Defaults to an OS temp dir. |
| `STRABO_PARSER_DIR`  | Directory holding grammar `.wasm` assets. Defaults to `parsers/vendor`. |
| `PORT`               | HTTP port for the standalone server.                           |

### Choosing a repository

The toolbar's **Choose folder…** dialog browses the filesystem server-side and scans the
folder you pick. A browser cannot hand the server a filesystem path, so the listing is
served by `GET /api/strabo/browse` and is strictly bounded by `STRABO_SCAN_CEILING`.
By default the ceiling is the start root, so the dialog only shows that repository; set
`STRABO_SCAN_CEILING` to a parent directory to scan siblings, for example:

```powershell
$env:STRABO_ROOT = "D:\work\my-repo"
$env:STRABO_SCAN_CEILING = "D:\work"
node bin/strabo.js
```

## Review overlays

The **Review** control annotates the map with a server-computed analysis. Overlays only
annotate nodes the server reported; they never invent edges, and selecting one switches to
Files mode because the analyses are per file.

| Overlay | Endpoint | Meaning |
| ------- | -------- | ------- |
| Change impact | `/analysis/impact` | Changed files and reverse-reachable files by distance (`base` optional) |
| Cycles | `/analysis/cycles` | Files in circular coupling (strongly connected components) |
| Test reach | `/analysis/test-reach` | Modules something depends on that no test reaches |
| Architecture health | `/analysis/architecture-health` | Heuristic axes (cohesion, low coupling, low fan-out, low complexity, coverage), each with the values it came from |

Also exposed but not yet surfaced in the UI: `/analysis/module-depth` and
`/analysis/ownership`.

The canvas toolbar's **Timeline** lists recorded changes (`/analysis/timeline`, newest
first). Selecting one compares that revision with the working tree via
`/analysis/impact?base=<hash>` and highlights the changed and potentially affected files.
When Git metadata is unavailable the panel says so rather than showing an empty history.

## Reading the map

Node **size** encodes transitive dependents, **colour** encodes the top-level directory,
and tests are **diamonds**. The canvas toolbar offers `Focus`, `Trace impact`,
`Start path`, `Boundaries`, and `Clear`; hovering a node reports its blast radius without
selecting it. The strip along the bottom counts tests, modules, and directories, and
clicking an entry filters the map.

Selecting a node opens the **Module Passport**: direct importers, blast radius, direct
imports, depends-on (all), plus Imports and Used by with source evidence and an
`Open in Workspace` action.

The **Member map** in the inspector groups declared types, fields, properties, and methods
with their visibility and type where symbol extraction is available (Java, Kotlin, Rust,
and C# today); other languages report that extraction is not implemented rather than an
empty list. Where the scan recorded field references inside method bodies — an explicit
`this.x` / `self.x`, or an unshadowed bare name — it also shows **Data flow** panels
(`Sources / inputs`, `Resources / hubs`, `Transforms`, `Sinks / outputs`) and per-member
read/write wiring. When nothing was recorded, the panels say so; cross-file access is not
claimed.

See `docs/ROADMAP.md` for the phased plan.

## Tests

```sh
npm test              # unit tests (Node's built-in runner, no browser)
npm run acceptance:install   # once: download Chromium
npm run acceptance    # Cucumber + Playwright, writes an HTML report with screenshots
npm run test:pack     # release readiness: pack, install in a clean consumer, run shipped code
```

`npm run test:pack` builds the real tarball, asserts the published file set (dist, public,
all four grammar assets, bin, README; no src/test/node_modules), installs it into a fresh
consumer project, and runs the shipped `strabo` and `strabo/server` entry points including
a Java resolution so packaged grammar assets are proven to load.

Browser acceptance lives in `test/acceptance/` and drives a real Chromium against the
standalone server, asserting only published API and UI behaviour. See
`test/acceptance/README.md`.

## Repository boundary and security

`resolveRepositoryRoot` is the sole route-level resolution boundary. The resolved root
must be inside `scanCeiling`, checked with path-relative containment rather than prefix
matching. File drill-down repeats this containment check before reading source. This
prevents path traversal and prevents host-wide scans by default.

## Architecture

```
Browser app (public/)          framework-free UI · Cytoscape renderer · optional host adapters
HTTP API                       router mounted at /api/strabo
Repository boundary            resolveRepositoryRoot + scanCeiling
Scanner                        JS/TS + polyglot resolvers
Graph cache                    memory (60s) + disk artifact
Analysis & layout              metrics, impact, cycles, blocks, depth, ownership
Optional integration seams     catalogue · vulnerability · lineage pack
```

The graph contract of a scan is:

```ts
{ nodes, edges, diagnostics, excluded }
```

- **Node** — repository-relative id, a kind, display metadata. Test-like paths receive
  `kind: "test"`, otherwise `kind: "module"`.
- **Edge** — source, target, kind, evidence. Exists only when both endpoints resolve
  inside the scanned repository.
- **Diagnostics** — unresolved or ambiguous facts, retained instead of invented links.
- **Exclusions** — why directories, filename patterns, gitignored files, and
  bundle-shaped files were skipped.

## Parsers

Parsing uses **`web-tree-sitter` (WASM)**, not native bindings: it keeps `npm install`
clean with no per-platform toolchain and ships recognisable, package-owned assets.
Grammar `.wasm` files are vendored from the `tree-sitter-wasm` devDependency into
`parsers/vendor/` by `npm run vendor:parsers` (run automatically by `prepare`), so a
published tarball owns its parsers and needs no network or build step at runtime.

Parser runtime state is process-global, so polyglot scans are serialised through a
promise queue. A missing grammar is reported as `unavailable`/`unsupported`, never as an
implicit failure.

| Language | Grammar | Resolution |
| -------- | ------- | ---------- |
| Java | `parsers/vendor/java` | Implemented: package + nested-type imports -> repository files |
| Rust | `parsers/vendor/rust` | Implemented: `mod` declarations, module paths, `use`/`pub use` (items, re-exports), and inline `crate::`/`self::`/`super::` paths |
| C# | `parsers/vendor/c_sharp` | Implemented: `using`, `using static`, and alias directives -> namespaces/types |
| Kotlin | `parsers/vendor/kotlin` | Implemented: `package` + `import` (wildcards, aliases, nested types) -> repository files |
| C++, SQL | not vendored | Recognised and reported as unsupported |
| COBOL, ABL | not vendored | Out of scope for now; treated as non-source files |

Resolution is **import-based**, plus references that do not need an import. An import only
becomes an edge when it resolves to a file in the repository; imports are treated as
external unless they share at least two leading package/namespace segments with the
repository, so a common reverse-DNS root (`com`, `io`, `org`) is not mistaken for proof of
an internal reference.

Java, C#, and Kotlin types used in the file body are resolved against the declaring
package/namespace even without an `import`/`using`; Rust resolves inline
`crate::`/`self::`/`super::` paths used without a `use`. When a Java/C#/Kotlin simple name
is declared by more than one file in that package/namespace, Strabo reports an `ambiguous`
diagnostic instead of guessing. Remaining limit: there is no full type inference, so
references that cannot be matched by name are left as diagnostics rather than speculative
edges.

## Layout
```
src/
  boundary/        resolveRepositoryRoot, scanCeiling containment
  scan/            collectSourceFiles, scanRepository, exclusion + gitignore handling
  resolve/         language facts -> internal repository paths
  analysis/        metrics, impact, coverage, cycles, depth, ownership, blocks
  view/            deterministic server-side view model
  cache/           memory + disk graph cache, fingerprints, refresh
  api/             router composition and focused routes
  integrations/    optional catalogue, vulnerability, and lineage seams
public/            framework-free browser app (consumes the HTTP contract only)
parsers/           package-owned native and vendor grammar assets
bin/               `strabo` CLI
test/unit/         unit tests
test/acceptance/   Gherkin .feature browser acceptance specs
```

## Non-goals

- Building a full source-code intelligence platform or resolving every external dependency.
- Requiring any catalogue, vulnerability, or lineage integration for a local scan.
- Treating extracted links as compiler-proof call graphs.
- Exposing arbitrary filesystem paths outside the configured scan ceiling.
- Adding user-specific analytics, ranking, or decision automation.

## Naming

Named for Strabo (c. 64 BC – AD 24), whose *Geographica* compiled the known world
almost entirely from other people's accounts — and who said plainly which of those
sources he trusted and which he would not repeat.
