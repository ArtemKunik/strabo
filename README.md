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

## Running Strabo

Requires Node 22+ and npm. From the repository root:

```sh
npm install          # also builds dist/ and vendors the parser .wasm files (prepare)
```

Then set `STRABO_ROOT` to the repository you want to map and start the server:

```sh
# bash / zsh
STRABO_ROOT=. npm start
```

```powershell
# PowerShell (the `VAR=value cmd` prefix is not valid here)
$env:STRABO_ROOT = "."
npm start
```

```bat
:: cmd.exe
set STRABO_ROOT=.
npm start
```

Open `http://localhost:3000` (the default `PORT`). The server scans `STRABO_ROOT`,
builds the graph, and serves the interactive map. Use `STRABO_SCAN_CEILING` to allow
scanning repositories outside the start root; see [Environment](#environment).

`npm start` is `node bin/strabo.js`, so `STRABO_ROOT=/path/to/repo node bin/strabo.js`
is equivalent.

## Getting started

Requires Node 22+ and npm.

```sh
# install; the `prepare` script also builds dist/ and vendors the parser .wasm files
npm install

# typecheck + build (tsc, then the UI bundle)
npm run typecheck
npm run build
# or just the UI bundle
npm run build:ui
```

The server takes its repository root from `STRABO_ROOT` — there is no positional
argument, and it exits with an error if the variable is unset. See
[Running Strabo](#running-strabo) to start it.

### Environment

| Variable             | Meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| `STRABO_ROOT`        | Repository root to scan and serve.                             |
| `STRABO_CONFIG`      | Path to a Strabo config file (workspace repositories, catalogue, integrations). |
| `STRABO_SCAN_CEILING`| Filesystem boundary Strabo may read from. Defaults to root.   |
| `STRABO_CACHE_DIR`   | Where scan artifacts are persisted. Defaults to an OS temp dir. |
| `STRABO_STATE_DIR`   | Where known repositories are persisted. Defaults to `STRABO_CACHE_DIR`. |
| `STRABO_PARSER_DIR`  | Directory holding grammar `.wasm` assets. Defaults to `parsers/vendor`. |
| `STRABO_RISK`        | `1` or `online` enables CVE/license lookup via OSV.dev and deps.dev. Off by default. |
| `STRABO_RISK_DENY`   | Comma-separated SPDX ids the license policy denies. Defaults to strong copyleft. |
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

Opened repositories are remembered (outside the scanned tree, so they never dirty it) and
the **Repository** selector reopens the last one on load. `GET /api/strabo/repositories`
lists them, `POST` remembers a selection, and `DELETE ?root=` forgets one. Every path is
still resolved through the scan ceiling, so remembering a path can never widen what Strabo
may read.

The **Choose folder** dialog browses the filesystem through `GET /api/strabo/browse`, which
is bounded by the same ceiling. When the dialog reaches the ceiling its **Up** button is
disabled and a note names the boundary and the `STRABO_SCAN_CEILING` variable that set it,
so the limit is visible rather than looking like a broken control.

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
first). Selecting one reviews **that commit's own changes** via
`/analysis/review?base=<hash>` — its files, statuses, and line counts, plus the files that
can reach them through the dependency graph. When Git metadata is unavailable the panel says
so rather than showing an empty history.

## Git review

**Review changes** on the canvas toolbar reviews the pending working tree through
`/analysis/review`, split into **Staged**, **Unstaged**, and **Untracked** files. A commit
selected from the timeline uses the same endpoint with `base=<ref>`.

Both forms report per-file status (`added`, `modified`, `deleted`, `renamed`, …) and the
insertions/deletions Git recorded, then the reverse-reachability impact — the same
traversal the change-impact overlay uses. A file with no line counts (binary, or an
untracked file that cannot be read) is reported as **uncounted** rather than as zero lines,
and a changed path outside the scanned graph is listed as such instead of being drawn as
if it had impact.

Commit review uses `git show --first-parent` rather than a bare `<ref>` diff. A bare diff
would fold in uncommitted working-tree edits, and `<ref>^..<ref>` fails on a root commit;
`--first-parent` reports a merge against its first parent and resolves for the root.

The review panel's **Change passport** adds each changed file's cohesion before and after
the change. Cohesion comes from the recorded member wiring, which needs only the file's own
content, so it is read from the baseline revision with `git show <base>:<path>` — HEAD for
the working tree, the first parent for a commit — and re-extracted for the reviewed copy. A
file whose language has no extractor, is new, or was deleted names the missing side rather
than showing a fabricated score.

## Workspace analysis

`STRABO_CONFIG` can name a workspace: several local repositories analyzed together.

```json
{ "name": "acme", "repositories": ["../core", "services/api"] }
```

Roots are relative to the config file, and every one is still resolved through
`STRABO_SCAN_CEILING`, so naming a path can never widen what Strabo may read. Without a
config the workspace is the single configured root, so multi-repo analysis stays opt-in.
`GET /api/strabo/workspace` returns the repositories, the flows between them, and the data
contracts they share.

**Cross-repo flows** are package publish/consume edges. A repository's published coordinate
is read from its own manifest (`package.json` `name`, `Cargo.toml` `[package] name`,
`pom.xml` `groupId:artifactId`); a sibling's recorded external import matches it exactly, or
by Maven `groupId` prefix. The flow carries the importing file, line, and specifier, and the
publishing manifest. Nothing is inferred from names or proximity, and if two repositories
claim the same coordinate both flows are emitted rather than one being chosen silently.

**Data contracts** are extracted from Protobuf messages, OpenAPI `components.schemas`, and
JSON Schema objects, normalised to field name, type, and required-ness. The
`/api/strabo/workspace/contracts` endpoint returns them alongside **contract drift**: where
the same contract id is declared by more than one repository, the fields that are missing on
a side, have a different type, or disagree on required-ness. An identical shared contract is
kept with no deviations rather than silently omitted.

Each repository's graph comes from the shared graph cache, and its coordinate and contracts
are cached per git fingerprint, so an unchanged repository is never rescanned or
re-extracted. A root that is not a git working tree is not cached under a key that cannot be
checked.

## Delegate to an agent

Right-clicking a node, edge, diagnostic, commit, overlay item, the Git review panel, or
empty canvas opens a **Delegate** menu that hands the selected item to a coding agent.
`POST /delegate` accepts only `opencode` or `claude`, writes the prompt to a temp file, and
opens the agent's **interactive TUI** with the repository as its working directory.

Delegating from the Git review panel hands the agent the same evidence shown on screen —
every changed file's status and line counts, plus the reverse-impact list — and asks it to
explain the change **as a function of the app**: what capability or behaviour it adds,
changes, or removes, not just which files moved. The agent still reads the actual diff
itself; Strabo only ever hands over what it recorded, never a guess at intent.

The TUI is seeded with a prompt that names the task file, so the operator can add their own
instruction before sending — the delegation does not silently run Strabo's canned task.
`opencode --prompt` prefills the editable input (the CLI has no auto-submit flag); its
one-shot `run` subcommand is deliberately not used. Claude's positional prompt is submitted
immediately, so its seed asks for a summary and waits rather than editing anything.

The repository is resolved through the scan ceiling like every other route, and delegated
text only ever lands in the prompt file — it is never interpolated into a shell command.
`GET /delegate` lists recent launches (a log, not supervision, since a terminal outlives
the server); `GET /delegate/:id` returns one run. The endpoint is Windows-only and answers
`501` elsewhere.

## Dependency risk

`GET /analysis/risk` reports supply-chain risk for one repository. **Inventory and file
mapping are always available; advisories and licenses require the opt-in online lookup.**

- **Inventory** parses `package-lock.json` / `package.json` (npm), `Cargo.lock` /
  `Cargo.toml` (Cargo), and `pom.xml` (Maven). Only a lockfile names an exact version, so a
  manifest-only dependency is listed with `version: null` rather than guessed from a range.
- **Imports** are recorded per file during the scan. A bare specifier is an external
  reference, not a graph edge — its target is outside the repository — so the scan stores it
  separately in `graph.externalImports`. That is what lets a finding name the file that
  imports the package (npm, Cargo, and conservative Maven `groupId` prefix matches).
- **Advisories** come from [OSV.dev](https://osv.dev): one batched query per package set,
  then the full record per advisory id. Severity is the advisory's own label; Strabo never
  computes or downgrades it.
- **Licenses** come from [deps.dev](https://deps.dev), classified against an SPDX policy.
  `OR` takes the least risky branch (either license may be chosen) and `AND` the most risky
  (all must be satisfied); an unrecognised identifier is `unknown`, never treated as
  permissive.
- **Impact** joins a finding to the files that import the package and then walks reverse
  dependencies, so a vulnerable dependency shows the files that can reach it by distance.

A dependency whose version cannot be resolved is listed but not queried, because both APIs
answer for exact versions. When the online lookup is off the report says so rather than
returning an empty advisory list that would read as a clean bill of health.

Online lookup is the only feature that contacts a third party, and it is off unless
`STRABO_RISK=online` is set; responses are cached under `STRABO_CACHE_DIR` to avoid repeat
calls. `POST /vulnerabilities` remains a host-injectable seam for an external provider.

⌘/ctrl-click toggles a node into a group, and shift-drag box-selects a region — Cytoscape's
own selection, so it costs nothing to build. Once two or more are selected, a **Delegate
selection…** button and a count appear on the canvas toolbar (`G`), and right-clicking any
selected node opens the same Delegate menu scoped to the whole group instead of just that
one node; right-clicking a node outside the group targets only that node, leaving the group
untouched underneath. The generated prompt renders one evidence subsection per file rather
than merging every file's facts into a single list, so it stays clear which claim belongs
to which file.

## Reading the map

Node **size** encodes transitive dependents, **colour** encodes the top-level directory,
and tests are **diamonds**. The canvas toolbar offers `Focus`, `Trace impact`,
`Start path`, `Boundaries`, and `Clear`; hovering a node reports its blast radius without
selecting it. The strip along the bottom counts tests, modules, and directories, and
clicking an entry filters the map. The zoom controls on the canvas adjust the viewport, and
the status bar reports the diagnostics and exclusion counts, the node kinds on screen, and
the active renderer (WebGL2 or canvas).

### Floating panels

Every panel — Review, Dependency risk, Timeline, Overlay, Edge evidence, Legend, the Module
Passport, Diagnostics, and the Member map — opens as a **floating window** rather than a
docked column, so the map keeps the full width. Drag a window by its header to move it,
double-click the header (or use `–`) to collapse it to its title bar, and close it with `×`.
The **dock** along the bottom restores any window, showing a solid chip for an open window,
an outlined chip for a collapsed one, and a plain chip for a closed one. Position and
collapsed state are remembered per panel in `localStorage`, so a layout survives a reload.

Selecting a node opens the **Module Passport**: direct importers, blast radius, direct
imports, depends-on (all), plus Imports and Used by with source evidence and an
`Open in Workspace` action. Dependencies, Dependents, and Members are separate tabs so a
large file does not push its member list off screen.

Selecting an edge opens **Edge evidence**: the relationship kind, the recorded specifier and
line, and how the import resolved (`module tree`, `alias`, and so on). Unrecorded fields read
`not recorded` rather than being guessed, and the panel offers actions to open either
endpoint or trace a path between them.

The **Member map** in the inspector groups declared types, fields, properties, and methods
with their visibility and type where symbol extraction is available (TypeScript/TSX, Java,
Kotlin, Rust, and C# today); other languages report that extraction is not implemented
rather than an empty list. Where the scan recorded field references inside method bodies — an explicit
`this.x` / `self.x`, or an unshadowed bare name — it also shows **Data flow** panels
(`Sources / inputs`, `Resources / hubs`, `Transforms`, `Sinks / outputs`) and per-member
read/write wiring. When nothing was recorded, the panels say so; cross-file access is not
claimed.

**Member map** opens that file in its own large floating workspace: member cards with
cluster tags and read/write counts, the four `DATA FLOW` panels behind a read/write divider,
an Architecture Health radar, and a Dependency constellation of fields, methods, and
repository consumers. Controls include Find member, Order, Show wiring, zoom levels,
Explain this class, Night vision, Compare versions, Show only this flow, and Reset layout.

**Flow walkthrough** walks the class in five steps — fingerprint, members, wiring, data
flow, consumption — with Prev / Play / Step. Every caption comes from recorded data, so a
step with no evidence says so instead of inventing a story. While **Play** runs, the region
for the current step comes forward and the others step back, member cards reveal in cluster
order, and the `data flow` step pulses the recorded panels while a dot falls down the
`read / write` divider. Hovering a field or method traces the members the scan recorded it
reading or writing, and the rest recede.

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
Browser app (public/)          framework-free UI · Cytoscape renderer · floating panel windows
HTTP API                       router mounted at /api/strabo
Repository boundary            resolveRepositoryRoot + scanCeiling
Scanner                        JS/TS + polyglot resolvers
Graph cache                    memory (60s) + disk artifact · workspace fact cache
Analysis & layout              metrics, impact, cycles, blocks, depth, ownership
Workspace analysis             declared multi-repo flows · contract drift
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
| TypeScript, TSX | `parsers/vendor/typescript`, `parsers/vendor/tsx` | Member extraction (classes, interfaces, enums, module functions); imports resolve through the JS/TS scanner above |
| SQL | `parsers/vendor/sql` | Implemented: `table` edges from a file that uses a table or view (`FROM`/`JOIN`, `UPDATE`, `DELETE`, `INSERT`, `ALTER`, `CREATE INDEX ... ON`, trigger `ON`, `REFERENCES`) to the one file that defines it (`CREATE TABLE`/`VIEW`/`MATERIALIZED VIEW`); `import` edges from `\i`/`\ir`, `:r`, `source`, and `@` includes of another `.sql` file; member extraction (tables/views and their columns) |
| C++ | not vendored | Recognised and reported as unsupported |
| COBOL, ABL | not vendored | Out of scope for now; treated as non-source files |

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
  scan/            collectSourceFiles, scanRepository, exclusion + gitignore handling
  resolve/         language facts -> internal repository paths
  analysis/        metrics, impact, coverage, cycles, depth, ownership, blocks
  workspace/       declared multi-repo analysis: published coordinates, flows, contracts
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
incrementally — the tests strip and the member map are ported, the heavy member-map sections
via a keyed `host()` so a step or zoom change reuses their nodes — and `ui/store.js` is the
observable state store whose single subscription drives re-renders and mirrors the
repository, mode, node, and open panel into the URL, so a view can be shared as a deep link.

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

## License

[MIT](LICENSE)
