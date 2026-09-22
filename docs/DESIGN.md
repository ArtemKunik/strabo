# Strabo design

Internals, contracts, and the designed-but-unbuilt surface. Shipped behaviour and how to
run Strabo live in [README.md](../README.md); the phased plan for what is still being built
lives in [ROADMAP.md](./ROADMAP.md).

> **Guiding principle: evidence over speculation.**
> The map draws only edges it can resolve inside the repository. Anything uncertain is
> reported as a diagnostic, never invented as a link. A feature is documented here as
> *designed* until it resolves.

## Form factor

Node 22+ package `strabo`, CLI `strabo`. One installable, versioned package with three
public entry points:

| Entry point     | Exposes                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `strabo`        | scanner, view model, symbol extractors, repository artifact scanner, router factory, server factory, optional lineage pack |
| `strabo/server` | `createStraboServer` — self-contained Express app serving `public/` and mounting the router at `/api/strabo` |
| `strabo` CLI    | `strabo [path]` starts the standalone server; `strabo export`, `strabo check`, and `strabo mcp` are the headless surfaces (interoperability, landed). The root is read from the path argument, `STRABO_ROOT`, or the working directory, plus `STRABO_CONFIG`, `STRABO_SCAN_CEILING`, `PORT` |

The same scanner, analysis, API, and browser UI are used in standalone and embedded
modes, so there is exactly one implementation of Strabo behaviour.

## Repository boundary and security

`resolveRepositoryRoot` is the sole route-level resolution boundary. The resolved root
must be inside `scanCeiling`, checked with path-relative containment rather than prefix
matching. File drill-down repeats this containment check before reading source. This
prevents path traversal and prevents host-wide scans by default.

The environment variable `STRABO_SCAN_CEILING` only ever *narrows* what the server may
read. Widening the boundary at runtime through `PUT /api/strabo/settings` is refused unless
the process was started with `STRABO_ALLOW_CEILING_WIDENING=1` (or `--allow-ceiling-widening`).
The permission itself is startup-only: a request body carrying `allowCeilingWidening` is
refused with `400`, and a persisted flag from an older version is ignored, so a request can
never grant itself a wider boundary — not directly, and not by surviving a restart.

The standalone server binds `127.0.0.1` by default (`STRABO_HOST` / `--host` overrides it).
API routes additionally refuse a `Host` header that names anything other than the server
itself, so a malicious page cannot reach the server through DNS rebinding.

## Architecture

```
Browser app (public/)          framework-free UI · Cytoscape renderer · floating panel windows
HTTP API                       router mounted at /api/strabo
Repository boundary            resolveRepositoryRoot + scanCeiling
Scanner                        JS/TS + polyglot resolvers
Graph cache                    memory (60s) + disk artifact · workspace fact cache
Analysis & layout              metrics, impact, cycles, blocks, depth, ownership, passport
Workspace analysis             declared multi-repo flows · contract drift
Optional integration seams     catalogue · vulnerability · lineage pack
```

The graph contract of a scan is:

```ts
{ nodes, edges, diagnostics, excluded }
```

- **Node** — repository-relative id, a kind, display metadata. Test-like paths receive
  `kind: "test"`, a manifest-declared starting file receives `kind: "entry"` (with the
  `entryReason` that named it), otherwise `kind: "module"`.
- **Edge** — source, target, kind, evidence. Exists only when both endpoints resolve
  inside the scanned repository.
- **Diagnostics** — unresolved or ambiguous facts, retained instead of invented links.
- **Exclusions** — why directories, filename patterns, gitignored files, and
  bundle-shaped files were skipped.

## Entry points

A file becomes an entry point only when a manifest names it and it resolves to a scanned
source file:

- `package.json` — `main`, `bin` (string or map), and every string leaf of `exports`.
- `Cargo.toml` — `[[bin]]` (`path`, or a `name` resolving to `src/bin/<name>.rs` / `src/main.rs`),
  `[lib]` (`path` or `src/lib.rs`), and the `src/main.rs` convention.
- `pom.xml` — `<mainClass>`, resolved from the class name to its `.java`/`.kt` file.

An extensionless target is tried with common source extensions and an `index.*` fallback.
A manifest target naming build output resolves back to source through the `tsconfig.json`
`outDir` → `rootDir` mapping (`dist/index.js` → `src/index.ts`, with a `dist/` → `src/`
convention when no tsconfig names one). A declared target with no scanned source behind it
is not invented as an entry point.

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
| TypeScript, TSX | `parsers/vendor/typescript`, `parsers/vendor/tsx` | Member extraction (classes, interfaces, enums, module functions); imports resolve through the JS/TS scanner above |
| JavaScript, JSX | `parsers/vendor/tsx` | Member extraction, sharing the TypeScript extractor; `.js`, `.jsx`, `.mjs`, `.cjs` parse with the TSX grammar, because JavaScript has no type assertions, so a leading `<` is always JSX |
| SQL | `parsers/vendor/sql` | Implemented: `table` edges from a file that uses a table or view (`FROM`/`JOIN`, `UPDATE`, `DELETE`, `INSERT`, `ALTER`, `CREATE INDEX ... ON`, trigger `ON`, `REFERENCES`) to the one file that defines it (`CREATE TABLE`/`VIEW`/`MATERIALIZED VIEW`); `import` edges from `\i`/`\ir`, `:r`, `source`, and `@` includes of another `.sql` file; member extraction (tables/views and their columns) |
| Python | `parsers/vendor/python` | Implemented: `import` and `from ... import` (absolute, relative, aliased, wildcard, and deferred inside a function) -> repository modules, counted from source roots discovered through `__init__.py`; member extraction (classes, methods, class attributes, and the instance state assigned as `self.x`) |
| C++ | `parsers/vendor/cpp` | Implemented: `#include "..."` -> repository files, resolved beside the including file, from the repository root, then by unique path suffix (standing in for an unknown `-I` directory); `#include <...>` is a system header and never an edge. Member extraction (classes, structs, fields, methods) with positional `public:`/`private:` access, and a declaration merged with its out-of-line definition. An implementation file also reports the fields its own headers declare, each marked `declaredIn`, so cohesion and data flow work for a class split across `.h`/`.cpp`; the headers come from the recorded include edges, never from a search |

Resolution is **import-based**, plus references that do not need an import. An import only
becomes an edge when it resolves to a file in the repository; imports are treated as
external unless they share at least two leading package/namespace segments with the
repository, so a common reverse-DNS root (`com`, `io`, `org`) is not mistaken for proof of
an internal reference.

JS/TS additionally resolves **all specifier styles** through the repository's own
config files: root-relative (`/src/...`), `tsconfig.json`/`jsconfig.json` `paths`
(including `extends` chains) and `baseUrl`, `vite.config` / `webpack.config` `alias`
tables (object and `{ find, replacement }` forms, incl. `path.resolve(__dirname, …)`
and `fileURLToPath(new URL(…))` replacements — executed never, only read), and
`package.json` subpath `imports` (`#...`). A specifier claimed by one of these
mechanisms but missing on disk is an `unresolved` diagnostic; pure bare packages
(`react`, `lodash`) stay silent externals.
Evidence records how each edge resolved (`path alias`, `repo root`, `package subpath`).

Java, C#, and Kotlin types used in the file body are resolved against the declaring
package/namespace even without an `import`/`using`; Rust resolves inline
`crate::`/`self::`/`super::` paths used without a `use`. When a Java/C#/Kotlin simple name
is declared by more than one file in that package/namespace, Strabo reports an `ambiguous`
diagnostic instead of guessing. Remaining limit: there is no full type inference, so
references that cannot be matched by name are left as diagnostics rather than speculative
edges.

SQL has no imports, so its edges follow **schema objects**: a file that uses a relation
links to the single file that creates it. Names match case-insensitively and loosely on
schema, as a search path would (`public.users` finds a `users` created without a schema);
temporary tables and CTE names never define or reference anything. A relation no file
defines is treated as external and stays silent, a relation created by more than one file
(common with re-run migrations) is an `ambiguous` diagnostic with no edge, and an include
of a `.sql` file that does not exist is `unresolved`. The grammar is strongest on
PostgreSQL/ANSI DDL and DML; dialect-specific statements it cannot parse (`GRANT`,
T-SQL `[bracketed]` names, `CREATE PROCEDURE`) are reported as a `parse-failure` warning
for the file while the statements around them still contribute. Functions, procedures,
types, and `DROP`/`TRUNCATE` are not tracked yet.

The SQL **member map** lists each table or view as a type and each column as a field it
owns, with the declared type (`DECIMAL(10, 2)`, `INT[]`). Columns come from
`CREATE TABLE` and `ALTER TABLE ... ADD COLUMN`, so a migration that only adds columns
still shows them. SQL has no access modifiers (visibility reads `n/a`) and no methods that
read or write columns, so the data-flow panels are unavailable and **cohesion is reported
as unavailable** rather than scored, in file health and in the change passport. View
columns and functions are not extracted: a select list declares no types, and the grammar
drops most `plpgsql` function bodies to error recovery, so only an arbitrary subset would
appear.

## Layout

```
src/
  boundary/        resolveRepositoryRoot, scanCeiling containment
  scan/            collectSourceFiles, scanRepository, entry-point detection, exclusion + gitignore handling
  resolve/         language facts -> internal repository paths
  analysis/        metrics, impact, coverage, cycles, depth, ownership, blocks, passport
  workspace/       declared multi-repo analysis: coordinates, package/service flows, contracts
  view/            deterministic server-side view model
  cache/           memory + disk graph cache, workspace fact cache, fingerprints, refresh
  api/             router composition and focused routes
  integrations/    optional catalogue, vulnerability, and lineage seams
ui/                framework-free browser app source (ES modules, no framework)
public/            generated UI served by the server, bundled from ui/ by `build:ui`
parsers/           package-owned native and vendor grammar assets
bin/               `strabo` CLI
test/unit/         unit tests
test/acceptance/   Gherkin .feature browser acceptance specs
```

`scripts/build-ui.mjs` bundles `ui/` into `public/` with esbuild (not minified, so the
served code stays readable); `npm run build` runs it after `tsc`. The published package
ships the built `public/`, so a consumer never needs a build step. The UI stays
framework-free: `ui/view.js` is a small `h()` / `mount()` keyed renderer that panels adopt
incrementally, and `ui/store.js` is the observable state store whose single subscription
drives re-renders and mirrors the repository, mode, node, and open panel into the URL, so a
view can be shared as a deep link.

## Designed but not yet built

Kept here rather than in the README so a designed surface is never documented as if it
resolves. Each item is either parked deliberately or tracked in [ROADMAP.md](./ROADMAP.md).

- **Workspace depth.** Cross-repo flows are computed and shown, but service flows are not
  drawn on the map yet, and language DTO contracts are not modelled.
- **Dependency risk (online).** Advisories and licenses require the opt-in OSV.dev /
  deps.dev lookup; only inventory and file mapping always resolve.
- **Member-map extras in parked scope.** The visual extras (Night vision, Compare
  versions, the Play walkthrough animation, the Architecture Health radar) exist, but are
  parked from the core rather than invested in further.
- **Function hotspots and architecture-health axes.** Answer code quality, not repository
  comprehension, so they are parked from the onboarding path.
- **Delegate everywhere.** The agent hand-off is implemented on Windows only and answers
  `501` elsewhere.
- **Language parity.** Nine grammars, one maintainer: TypeScript/JavaScript, Python, and
  Java are the depth languages; the other resolvers are best-effort rather than parity.

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
