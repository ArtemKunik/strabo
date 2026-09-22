# Strabo

A standalone app for understanding repository structure, dependencies, and change impact.

Strabo turns a local source repository into an interactive map of its files and
dependencies. Engineers explore the structure, trace relationships, and inspect the
source evidence behind every connection.

> **Guiding principle: evidence over speculation.**
> The map draws only edges it can resolve inside the repository. Anything uncertain is
> reported as a diagnostic, never invented as a link.

## Status

Implemented and running: scanner, resolvers, graph cache, HTTP API, and the browser app,
including review overlays, the Change impact passport, the Module Passport, the Member map,
the Repository passport, Git review, branch review and actions, workspace analysis,
dependency risk, and the opt-in narrator. Design internals
and the deliberately parked surface live in [docs/DESIGN.md](docs/DESIGN.md); the phased
plan and what is still pending live in [docs/ROADMAP.md](docs/ROADMAP.md).

## Form factor

Node 22+ package `strabo`, CLI `strabo`. The public entry points and the shared-contract
design are documented in [docs/DESIGN.md](docs/DESIGN.md#form-factor).

## Running Strabo

Requires Node 22+ and npm. From the repository root:

```sh
npm install          # also builds dist/ and vendors the parser .wasm files (prepare)
npm start            # maps the repository you are standing in
```

Open `http://localhost:3000` (the default `PORT`). The server scans the root, builds the
graph, and serves the interactive map.

To map a different repository, pass its path or set `STRABO_ROOT`:

```sh
npm start -- /path/to/repo
# `npm start` is `node bin/strabo.js`, so this is the same thing
node bin/strabo.js /path/to/repo
```

The root is resolved from the path argument, then `STRABO_ROOT`, then the working
directory. The resolved root and scan ceiling are printed at startup, so a run against
the wrong directory is visible rather than silent. Use `STRABO_SCAN_CEILING` to allow
scanning repositories outside the start root; see [Environment](#environment).

## Headless use: export, check, and MCP

The same scan backs the server, a CLI, and an agent tool surface. Starting the server is
the default; the rest are explicit subcommands:

```sh
# portable graph: json (a versioned envelope), dot, mermaid, or svg
node bin/strabo.js export /path/to/repo --format=mermaid
node bin/strabo.js export --format=svg --view=system --out=map.svg

# headless checks for CI; only the rules you name can fail the build
node bin/strabo.js check --fail-on-cycles --fail-on-layer-violations
node bin/strabo.js check --write-baseline        # record today's findings
node bin/strabo.js check --fail-on-new-smells    # then fail only on new ones

# the recorded analysis over MCP (stdio), read-only
node bin/strabo.js mcp
```

`check` exits non-zero only when a finding is absent from the baseline, so a pre-existing
problem does not block adoption. A fact the scan did not record is a warning, never a
failure. The same facts are on the HTTP surface: `GET /api/strabo/export?format=...` and
`GET /api/strabo/status`, which reports the revision the graph was indexed at, the current
`HEAD`, and how many commits the two differ by. `strabo export --site --out=<dir>` writes a
static site of one map per repository, for publishing demo maps without an install. The MCP
tools, their client config, and the read-only boundary are documented in
[docs/MCP.md](docs/MCP.md).

Environment: `STRABO_AUTO_REBUILD=0` stops the server from rebuilding a stale graph in the
background when a request observes `HEAD` moving; the map is then rebuilt only on
**Refresh**.

## Repository report

`strabo report [path]` writes a whole-repository report; `strabo summary [path]` is the same
report under a name that says so. It is a composition of the analyses the map already runs —
the Repository passport, cycles, quality smells, function hotspots, test reach, ownership,
dependency risk, and scan diagnostics — ranked into one **pain points** list. Each pain point
carries a fixed severity (never a repository percentile) and the recorded `inputs` behind it,
so two runs sort the same way and the report diffs cleanly.

```sh
node bin/strabo.js report --format=md                    # Markdown (default)
node bin/strabo.js report --format=json --out=report.json
node bin/strabo.js report --format=html --out=report.html
node bin/strabo.js report --format=pdf  --out=report.pdf
node bin/strabo.js report --base=main --format=md        # the change report (Phase 26)
```

The document has five parts:

- **Overview** — languages and size, entry points, top-level directories, and the most
  depended-upon files by fan-in.
- **Pain points** — cycles, tier leaks, smells, hotspots, untested reach, bus factor,
  advisories and denied licences, parse failures, and a stale graph, ranked by severity.
- **Pending change set** — the working tree's staged, unstaged, and untracked files with the
  same reverse-reachability impact the Review panel shows.
- **Suggestions** — one deterministic action per pain point, citing the recorded evidence.
  There is no model prose: a suggestion with no pain point behind it is never emitted, so the
  section is available with nothing configured and never speculates. (A narrator layer over
  the same facts is a later, opt-in follow-up.)
- **Evidence** — the counts, and a named list of any section the caller did not compute, so a
  missing analysis is visible rather than shown as empty.

A section with nothing recorded says so ("no recorded pain point crossed a threshold"). The
same document is on the HTTP surface at `GET /analysis/report?format=md|json|html`, which the
Repository passport's **Export report** action downloads, so the browser and the CLI cannot
disagree.

PDF is a render of the self-contained HTML through a detected headless Chromium: a local
`playwright` install first, otherwise a system Edge/Chrome. Neither is a shipped dependency,
so when no renderer is found the report writes the `.html` beside the requested file and says
why — a missing renderer is named, not a silent empty file. `--no-change`, `--no-smells`,
`--no-hotspots`, and `--no-ownership` skip an analysis; a skipped section is named as not
computed. `--format` and `--out` use the `--flag=value` form.

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

See [Running Strabo](#running-strabo) to start the server.

### Environment

| Variable             | Meaning                                                        |
| -------------------- | -------------------------------------------------------------- |
| `STRABO_ROOT`        | Repository root to scan and serve. Overridden by a path argument; defaults to the working directory. |
| `STRABO_CONFIG`      | Path to a Strabo config file (workspace repositories, catalogue, integrations). |
| `STRABO_SCAN_CEILING`| Filesystem boundary Strabo may read from. Defaults to root; narrowing it is editable at runtime from **Settings**. |
| `STRABO_ALLOW_CEILING_WIDENING` | Startup-only `1`/`true` (or `--allow-ceiling-widening`) permits **Settings** to widen `scanCeiling` beyond its startup value. Off by default; never accepted from a request and never persisted, so a request cannot grant itself a wider boundary. |
| `STRABO_HOST` | Interface the server binds (`--host` overrides it). Defaults to `127.0.0.1`; set `0.0.0.0` only to expose the server deliberately. |
| `STRABO_CACHE_DIR`   | Where scan artifacts are persisted. Defaults to an OS temp dir. |
| `STRABO_STATE_DIR`   | Where known repositories, settings, and check baselines are persisted. Defaults to `STRABO_CACHE_DIR`. |
| `STRABO_AUTO_REBUILD`| `0`/`false`/`off` stops the server from rebuilding a stale graph in the background when a request observes `HEAD` moving. On by default. |
| `STRABO_PARSER_DIR`  | Directory holding grammar `.wasm` assets. Defaults to `parsers/vendor`. |
| `STRABO_RISK`        | `1` or `online` enables CVE/license lookup via OSV.dev and deps.dev. Off by default. |
| `STRABO_RISK_DENY`   | Comma-separated SPDX ids the license policy denies. Defaults to strong copyleft. |
| `STRABO_NARRATOR_ENDPOINT` | Chat-completions endpoint for the opt-in LLM narrator. Must be `https:` or loopback. Off unless set with a model. |
| `STRABO_NARRATOR_MODEL` | Model name to request from the narrator endpoint. |
| `STRABO_NARRATOR_KEY_ENV` | Environment variable holding the narrator API key. Defaults to `STRABO_NARRATOR_API_KEY`. |
| `STRABO_NARRATOR_BUDGET` | Maximum narrator requests per server session. Defaults to 20. |
| `STRABO_NARRATOR_SEND_SOURCE` | `1`/`true` also sends recorded source snippets, not just evidence. Off by default. |
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
so the limit is visible rather than looking like a broken control. The ceiling can also be
changed while the server runs from **Settings** (see below).

## Settings

The toolbar's **Settings** button opens a floating window with four groups: **Appearance**
and **Rendering** (browser preferences), **Server** (the scan ceiling and the online risk
lookup), and **Narrator** (the opt-in setup described under
[LLM narrator](#llm-narrator-opt-in)).

**Appearance** preferences are stored in `localStorage` under `strabo.settings.v1` and
applied immediately:

| Preference | Meaning |
| ---------- | ------- |
| Theme | `System`, `Dark`, or `Light`. `System` follows `prefers-color-scheme` and updates live. |
| Reduce motion | Collapse the app's transitions and the member-map playback; also follows the OS preference. |
| Default detail | Whether the map opens in **Directories** or **Files** mode, unless a URL mode or a per-repository preference overrides it. |
| Show node labels | Hide every node label for a cleaner map. Directory-island labels are a separate layer and are unaffected. |

The theme is applied as `data-theme` on `<html>`; the surface, ink, border, and canvas
colours are CSS custom properties, so both the chrome and the Cytoscape graph re-skin
together (the graph stylesheet reads `--graph-*` at runtime). Reduce motion sets
`data-reduce-motion`, which the graph viewport also honours.

**Rendering** chooses the map's renderer: **GPU rendering (WebGL2)** on draws on the GPU,
off on the 2D canvas. Cytoscape fixes its renderer when the map is constructed, so changing
this reloads the page and says so before it is clicked; when the browser exposes no WebGL2
context the toggle is disabled and names that reason. Diagnostics reports the renderer
actually in use.

**Server settings** are read from `GET /api/strabo/settings` and written with
`PUT /api/strabo/settings`:

| Field | Editable | Meaning |
| ----- | -------- | ------- |
| `workspaceRoot` | no | The start root the process was launched with. |
| `scanCeiling` | yes | The boundary every path is resolved through. `null` resets it to the startup value. |
| `allowCeilingWidening` | no | Startup-only permission, shown read-only. Set it with `STRABO_ALLOW_CEILING_WIDENING` or `--allow-ceiling-widening`. |
| `riskOnline` | yes | Whether OSV.dev / deps.dev lookups are enabled (`STRABO_RISK`). |
| `configPath`, `riskDeniedLicenses` | no | The workspace config path and the denied-license policy, shown for reference. |

A ceiling update takes effect immediately for the graph, browse, and repository routes. It
is process-local: a restart returns to `STRABO_SCAN_CEILING`. **Narrowing** the boundary is
always allowed. **Widening** it beyond the ceiling in force is refused unless the process
was started with `STRABO_ALLOW_CEILING_WIDENING=1` (or `--allow-ceiling-widening`), so a
default process cannot grow its own read boundary at runtime — not directly, and not by
persisting the permission, since the flag is never accepted from a request and never
written to the settings file. A body carrying `allowCeilingWidening` is refused with
`400`. Treat the server as an operator tool and do not expose it to untrusted users. The
requested path must name an existing directory; anything else is rejected with `400` and
the ceiling is left unchanged.

The standalone server binds `127.0.0.1` by default (`STRABO_HOST` / `--host` overrides it;
`0.0.0.0` listens on every interface and logs a warning saying so). API routes additionally
refuse a `Host` header that names anything other than the server itself (loopback, or the
configured interface), so a malicious page cannot reach the server through DNS rebinding:
a rebinding domain resolves to 127.0.0.1 but arrives with the attacker's Host, which never
matches.

## Review overlays

The **Review** control annotates the map with a server-computed analysis. Overlays only
annotate nodes the server reported; they never invent edges, and selecting one switches to
Files mode because the analyses are per file.

| Overlay | Endpoint | Meaning |
| ------- | -------- | ------- |
| Change impact | `/analysis/impact` | Changed files and reverse-reachable files by distance (`base` optional) |
| Cycles | `/analysis/cycles` | Files in circular coupling (strongly connected components) |
| Test reach | `/analysis/test-reach` | Modules something depends on that no test reaches |
| Module depth | `/analysis/module-depth` | Files whose interface is wide relative to their implementation, or that pass through to another module |
| Ownership | `/analysis/ownership` | Recorded authors per file joined to dependency reach; a single-author module with dependents is a bus-factor signal |
| Architecture health | `/analysis/architecture-health` | Heuristic axes (cohesion, low coupling, low fan-out, low complexity, coverage), each with the values it came from |
| Function hotspots | `/analysis/functions` | Functions whose recorded metrics cross a fixed threshold (nested loops, deep nesting, high complexity, long body, many parameters, recursion), ranked worst-first |

## Repository passport

Opening an unfamiliar repository shows a **Repository passport** once, before the operator
has reason to trust the map. It is a server-computed summary of the same graph the canvas
draws (`GET /analysis/passport`), so the two cannot disagree:

- **Languages and size** — source files per language (extensions sharing a language are
  summed, so `.js` and `.mjs` count once as JavaScript), with file, edge, directory, test,
  diagnostic, and exclusion counts.
- **Entry points** — the files a manifest declares as starting points, each with the
  declaration that named it (`package.json` `main`/`bin`/`exports`, `Cargo.toml` `[[bin]]`
  or `src/main.rs`, `pom.xml` `mainClass`). A manifest naming build output resolves back
  to source through the `tsconfig.json` `outDir` → `rootDir` mapping (`dist/index.js` →
  `src/index.ts`), so a TypeScript package still reports its entries. These also carry
  `kind: "entry"` and a star shape on the map, so the graph has a visible starting point.
- **Top-level directories** — the coarsest grouping, with file and incoming counts. (Deliberately
  not called "layers": the System view already uses that word for depth-derived tiers.)
- **Most depended-upon files (by fan-in)** — the ranked text answer to "which files decide
  this codebase", which a canvas cannot give at a glance. Barrel files that only re-export
  show their re-export count alongside, so a forwarder never reads as a "0 fan-out" leaf.
- **Cycles and used-but-untested modules** — the same evidence the review overlays carry.

Every section comes from the scan; a section with nothing recorded says so rather than
showing an empty list. The passport is browser-local per repository, so it greets a
first visit and stays out of the way afterwards.

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

## Commit (narrator, opt-in)

With **Settings → Commit → Narrator commit** on, the **Change impact** panel — whose list is
the working tree's own changes — gains a **Commit…** action. It asks
`POST /narrator/commit-message` for a message written from the recorded changes: every
changed file with its status and line counts, plus the reverse-dependency impact. The evidence
is built server-side from the scan, never sent by the browser, so a caller cannot steer what is
described. The message appears in a dialog to read and edit before anything runs; confirming
commits the whole working tree (`git add -A`) with that message and pushes the current branch,
and **Push after commit** can be turned off. The message reaches Git as an argument, never a
shell, and the push is never forced, so a diverged branch is reported after the commit is made
rather than overwritten. The preference is browser-local and off by default; the narrator must
be configured to generate a message, and one can be typed by hand when it is not.

## Source viewer

The **Source** window (`S`, or **View source** in the Module Passport and the Edge panel)
reads one file inline instead of opening a browser tab: `/source?file=` returns the working
tree and `/source?file=&ref=` a past version read with `git show`. Lines are numbered, the
evidence line is marked, and a file Git cannot return as text (binary, or over the size cap)
is named rather than shown as empty.

Each file row in **Review changes** carries a **Diff** action that opens the same window on
the change, through `/diff`. The route mirrors the review's own two sides rather than guessing
them — `ref=<hash>` for a commit, `base=<mergeBase>&head=<tipHash>` for a branch, `staged=1`
or the default unstaged working tree, and `untracked=1` for a file Git does not track (read
whole, as additions). The unified diff is parsed into hunks with an old and a new line number
per line, so an added line carries only a new number and a removed line only an old one.
Binary and unchanged files say so; the viewer never shows "no changes" for a file it could
not read.

## Change impact passport

Every changed file also carries a **Change impact passport** — the same card in the Review
panel (rolled up over the change set or a branch revision) and, for any selected file, on
the Module Passport's **Impact** tab (`GET /analysis/impact-passport?file=`). It reads:

- **Risk** — a bounded 0-100 score with a `LOW`/`MODERATE`/`HIGH`/`CRITICAL` band, built
  from normalised inputs that are kept on the card: the most complex function's decision
  points, blast radius, recorded signal count, and the share of direct dependents no test
  reaches. It is a heuristic, not a repository percentile.
- **Max and average complexity** — the most complex and mean function decision points
  (`C35`, `8.4`), each with its `grown +C3` / `shed −C2` move against the baseline, plus how
  many functions and classes did not move.
- **Change coherence** — a 0-100 concentration of the changed symbols: the largest connected
  component of the changed functions over their count, using the recorded intra-file calls.
  One changed symbol is trivially coherent (`100`).
- **Blast radius** and **importers / imports** — the current graph's counts over `use` edges.
- **Risk signals** — the recorded function signals, most severe first, with the value that
  tripped each (e.g. *High complexity logic · maximum C35*).
- **Most complex functions** — the reviewed side's worst functions by decision points, each
  with its move from the baseline.

The roll-up counts blast radius, importers, and imports as distinct-file unions over the
drawn graph, takes the worst file's risk band, and pools the average complexity. A side the
scan or Git cannot read is `null` and named in `note`, never a zero.

## Branches

The **Branches** panel (`N`) lists local and remote branches, newest first, each with its
sync against its upstream (`N to push`, `M to pull`, `upstream gone`, `no upstream`), its
divergence from a base you can pick (the remote's default branch by default), and its age.
Counts come from the local object store and are as fresh as the last fetch.

Branches is the one place Strabo writes to Git, and only through explicit buttons:

- **Fetch** runs `git fetch --prune` on the remote(s) the listed branches track (else
  `origin`, or the repository's only remote), so the ahead/behind counts update.
- **Push** appears on a local branch that is ahead of its upstream; a branch with no
  upstream gets **Publish**, which pushes it and sets the upstream. It never force-pushes.
- **Sync** runs on the checked-out branch: fetch, then fast-forward when behind (it refuses
  a diverged branch or a dirty tree rather than merging), then push when ahead.

The three actions are state-changing, so they are accepted only from the page's own origin
(`isSameOriginRequest`). Every branch and remote name is validated against a strict pattern
before it reaches Git, arguments are passed as a vector (never a shell), credential prompts
are disabled so an unauthenticated push fails with a reason instead of hanging, and each
action is time-bounded. A failure is classified (`no-git`, `auth`, `not-fast-forward`,
`dirty`, `timeout`, …) and shown in the status bar.

## Workspace analysis

`STRABO_CONFIG` can name a workspace: several local repositories analyzed together.

```json
{ "name": "acme", "repositories": ["../core", "services/api"] }
```

Roots are relative to the config file, and every one is still resolved through
`STRABO_SCAN_CEILING`, so naming a path can never widen what Strabo may read. Without a
config the workspace is the single configured root, so multi-repo analysis stays opt-in.
`GET /api/strabo/workspace` returns the repositories, the package and service flows between
them, and the data contracts they share.

**Cross-repo flows** are package publish/consume edges. A repository's published coordinate
is read from its own manifest (`package.json` `name`, `Cargo.toml` `[package] name`,
`pom.xml` `groupId:artifactId`); a sibling's recorded external import matches it exactly, or
by Maven `groupId` prefix. The flow carries the importing file, line, and specifier, and the
publishing manifest. Nothing is inferred from names or proximity, and if two repositories
claim the same coordinate both flows are emitted rather than one being chosen silently.

**Data contracts** are extracted from Protobuf messages, OpenAPI `components.schemas`,
JSON Schema objects, and language-native DTOs — TypeScript interfaces and object type aliases
(also `.js`), Python `@dataclass`/pydantic/`TypedDict` classes, Kotlin `data class` primary
constructors, Java and C# `record`s, and Rust structs with named fields — normalised to field
name, type, and required-ness. A language DTO is keyed by its bare type name, so the same
shape declared in two repositories matches; only shapes with a clear DTO reading are taken.
The
`/api/strabo/workspace/contracts` endpoint returns them alongside **contract drift**: where
the same contract id is declared by more than one repository, the fields that are missing on
a side, have a different type, or disagree on required-ness. An identical shared contract is
kept with no deviations rather than silently omitted.

**Service flows** join an outbound HTTP call recorded in one repository's source to an
endpoint a sibling declares in its OpenAPI `paths`. A call is recorded when a verb-named
callee (`get`/`post`/…), `fetch`, `requests.request`, `GetAsync`, OkHttp `url`/`URI.create`,
or `reqwest::get` is passed a string-literal URL or absolute path; the endpoint's host and
path prefix come from the first `servers[0].url` (or Swagger 2 `host`/`basePath`). The join
needs a recorded host, path, and method on both sides, so a relative call or a serverless
endpoint is evidence without a flow, and a call whose method is not recorded joins only when
that host and path declares exactly one method. The `/api/strabo/workspace/services` endpoint
returns the declared endpoints and the joined flows.

The **Workspace** panel (dock entry, or `window.straboTest.workspace()`) renders the recorded
report: each repository with its commit, dirty state, and published coordinate; the
cross-repo flows; the service endpoints and service flows; the contracts; and the drift.
Opening the panel also rings, on the map, the local files the report records on one side of a
cross-repo flow. A section with nothing recorded says so
("No cross-repo flows recorded.") rather than showing an empty list, and a shared contract
that matches field-for-field is labelled clean. The panel is read-only and a config error is
shown in the panel, not thrown.

Each repository's graph comes from the shared graph cache, and its coordinate and contracts
are cached per git fingerprint, so an unchanged repository is never rescanned or
re-extracted. A root that is not a git working tree is not cached under a key that cannot be
checked.

### Databases and compatibility

An application is rarely one repository, and half of how it behaves is in the database. The
workspace treats the database as a member and asks whether a change is safe for what depends
on it.

**Schema snapshot** (`GET /api/strabo/workspace/schema`). Each repository's `.sql` files are
replayed in order into one schema: tables, columns with normalised types, nullability and
defaults, primary/unique/foreign-key/check constraints, and indexes, each with the file and
line that declared it. Order is the natural sort of the path (so `V2__` runs before `V10__`),
schema dumps first and Flyway repeatables last; `down`/undo scripts are skipped. A statement
the parser cannot apply is listed as a **gap**, not skipped silently. A table two repositories
both declare is compared like a shared contract.

**Code against schema** (`GET /workspace/schema/usage`). Tables and columns that code names,
from string-literal SQL and from JPA, TypeORM, SQLAlchemy, Diesel and SeaORM mappings, are
checked against every declared schema in the workspace. A finding is evidence, not a verdict: an
unknown table may be created by an ORM auto-migration or live in a database the workspace does
not include, and a bare `SELECT` literal is marked `weak`.

**Compatibility** (`GET /workspace/compat?base=<ref>[&head=<ref>][&repository=]`). Two
revisions of a repository (default `HEAD` against the working tree) are extracted and compared.
Contract and schema changes are `breaking`, `conditional` (safe for one direction only, and the
reason says which) or `safe`. Schema changes are judged by whether the application still running
against the database keeps working: a NOT NULL column with no default, or a constraint old
writes can violate, is breaking even though the migration itself succeeds. A change lists the
code that still names a dropped column or writes without a new required one, and the other
repositories that declare the same contract. A revision that cannot be read is reported as
unavailable, never as "no changes".

**Migration preflight** (`GET /workspace/preflight?base=<ref>[&format=sql]`). Static analysis
cannot see the data, which is where a migration actually fails. Each risky operation (a new NOT
NULL, unique, primary key, foreign key or check, a narrowing type change, a dropped column or
table) becomes a read-only aggregate query that counts the rows that would trip it. `format=sql`
renders them as a script an operator can run against any environment; an operation that cannot
be expressed as a query is listed as skipped with its reason.

**Live read-only probe.** Declare a database in the workspace config by the *name of the
environment variable* that holds its connection string. A config with a URL in it is refused:

```json
{
  "name": "acme",
  "repositories": ["api", "db"],
  "databases": [{ "name": "prod", "dialect": "postgres", "urlEnv": "STRABO_DB_PROD" }]
}
```

`POST /workspace/preflight/run` `{ "database": "prod", "base": "HEAD" }` runs the generated
checks and returns the counts. `POST /workspace/live/schema` `{ "database": "prod" }` reads the
live catalog in the same shape as the migrations and reports where they differ, in both
directions. The probe is narrow by construction: the connection string is read from the
environment when a run starts and is never stored, logged or returned (errors are scrubbed of
it); every statement runs in its own `READ ONLY` transaction with a statement timeout; the
request takes a database name and a revision, never SQL, and a final guard refuses anything that
is not a single plain `SELECT`; only counts and catalog metadata come back, never a table row.
Both routes accept only the page's own origin. The PostgreSQL driver is the optional peer
dependency `pg` (`npm install pg` next to Strabo); nothing is loaded until a probe runs.
`GET /workspace/databases` lists the declared databases (whether the variable is set, never its
value) and the recent runs.

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
  `Cargo.toml` (Cargo), `pom.xml` (Maven), and `gradle.lockfile` / `libs.versions.toml` /
  `build.gradle(.kts)` (Gradle). Only a lockfile names an exact version, so a manifest-only
  dependency is listed with `version: null` rather than guessed from a range.
- **Imports** are recorded per file during the scan. A bare specifier is an external
  reference, not a graph edge — its target is outside the repository — so the scan stores it
  separately in `graph.externalImports`. That is what lets a finding name the file that
  imports the package (npm, Cargo, and conservative Maven `groupId` prefix matches, plus a
  short table of well-known libraries such as `okhttp3` whose package differs from their
  groupId). Platform packages (`android.*`, `kotlin.*`, Node builtins), the repository's own
  JVM packages, Rust modules, and workspace crates are local, not undeclared dependencies.
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

Online lookup is one of only two features that contact a third party, and it is off unless
`STRABO_RISK=online` is set; responses are cached under `STRABO_CACHE_DIR` to avoid repeat
calls. `POST /vulnerabilities` remains a host-injectable seam for an external provider.

## LLM narrator (opt-in)

`GET /narrator`, `POST /narrator`, and `GET /narrator/runs` expose an optional narrative
layer over recorded evidence; `GET /narrator/models`, `POST /narrator/test`,
`POST /narrator/key`, and `DELETE /narrator/key` back the in-app setup. **It is inert by default**: without an endpoint and a model,
`GET /narrator` reports `configured: false` and nothing is sent anywhere.

- It is set up in **Settings → Narrator**: pick a provider preset (Ollama, LM Studio,
  OpenAI, Anthropic, OpenRouter, or Custom), fetch the provider's model list, choose the key
  source, toggle whether recorded source snippets are sent, set the request budget, and
  **Test connection**. The one line *Narrator is off · Set up →* opens it.
- The endpoint must be `https:` or a loopback `http:` address; a plaintext call off the
  machine is refused rather than attempted.
- The key comes from an environment variable named in the settings, or from a key stored on
  this machine: write-only, bound to the endpoint host, kept in the state directory with
  owner-only permissions, and never logged, cached, or audited. Changing the endpoint host
  clears the stored key. It is sent as an `Authorization: Bearer` header and never appears
  in a status reply, an audit entry, or a log line.
- Environment variables still win: a field set by `STRABO_NARRATOR_*` is shown as locked and
  a browser write to it is rejected, so a managed deployment cannot be overridden from the
  UI. Settings writes are accepted only from the page's own origin.
- Anthropic uses its OpenAI-compatible endpoint, so no provider-specific adapter is needed.
- Only recorded evidence is sent by default. Source snippets are included only when
  `STRABO_NARRATOR_SEND_SOURCE` is set. Evidence and source are wrapped in delimited tags as
  untrusted data, and a literal closing tag inside them is neutralised so it cannot inject
  instructions.
- The prompt is bounded; replies are cached by git fingerprint + model + prompt version, and
  a per-session budget (default 20) stops runaway calls. `GET /narrator/runs` lists what was
  requested — model, host, fingerprint, size, cache state — never the key or the body.
- The reply is narrative text, labelled `kind: "narrative"` and kept apart from recorded
  evidence. It is never executed and never written back to source.
- The **Functions** tab shows the narrator status and a **Narrate** button. It sends only the
  recorded functions (line, metrics, signals, same-file calls) from `buildNarratorEvidence`
  and renders the reply under a "model-generated narrative" attribution — or the reason it is
  unavailable, which is `not-configured` until the operator sets an endpoint and model.

⌘/ctrl-click toggles a node into a group, and shift-drag box-selects a region — Cytoscape's
own selection, so it costs nothing to build. Once two or more are selected, a **Delegate
selection…** button and a count appear on the canvas toolbar (`G`), and right-clicking any
selected node opens the same Delegate menu scoped to the whole group instead of just that
one node; right-clicking a node outside the group targets only that node, leaving the group
untouched underneath. The generated prompt renders one evidence subsection per file rather
than merging every file's facts into a single list, so it stays clear which claim belongs
to which file.

## Reading the map

Node **size** encodes transitive dependents, **position** (the directory islands) encodes the
top-level directory, **shape** encodes the kind (tests are **diamonds**, manifest-declared
entry points are **stars**), and hue is reserved
for status — a changed or affected node carries the fixed status scale, and never directory
identity — so two statuses that can appear together differ by border shape as well as colour.
The canvas toolbar offers `Focus`, `Trace impact`,
`Start path`, `Boundaries`, `Calls`, and `Clear`; hovering a node reports its blast radius without
selecting it. The strip along the bottom counts tests, modules, and directories, and
clicking an entry filters the map. The zoom controls on the canvas adjust the viewport, and
the status bar reports the diagnostics and exclusion counts, the node kinds on screen, and
the active renderer (WebGL2 or canvas).

In file mode each directory is drawn as a plate behind its files. Dragging a plate moves the
whole directory as one group, so the map can be re-arranged; a press that lands on a file
still selects or drags that file, so the plate's padding and the gaps between nodes are the
handle. The arrangement is stored per repository in `localStorage` and replayed on the next
visit, and **Reset map layout** on the empty-canvas right-click menu restores the computed
positions.

**Calls** (toolbar `C`, file mode) swaps the map from import coupling to the recorded
function-call graph: a dashed edge means the source file calls a function the target file
declares. The switch is a change of reading, not of reachability — a call edge always sits
beside the import edge that made the call possible. It is deliberately partial and
evidence-bound; only a syntactically-provable call becomes an edge:

- a name bound by an import plus a bare call — `import { foo } from './a'; foo()`,
  `from m import foo; foo()`, `use crate::m::foo; foo()`, `using static Type; foo()`, and the
  default and aliased forms;
- a namespace- or module-qualified call — `ns.foo()`, `mod.foo()`, `crate::mod::foo()`,
  `util::foo()`, `Type.foo()`, `Type::foo()`, `Helper.foo()`;
- in C++, a call to a function declared in a directly included header (`#include "widget.h"`).

Everything else is left unclaimed rather than guessed: a value receiver (`obj.method()`,
`helper.doWork()`), a dynamic call, a re-exported or non-imported name, a call whose target is
ambiguous, and any instance method — resolving those needs type inference the scan does not
do. SQL has no calls; its table references are already edges. The same-file call analysis in
the Functions tab is unchanged.

### Floating panels

Every panel — Repository passport, Review, Dependency risk, Timeline, Branches, Narrator,
Overlay, Edge evidence, Legend, the Module passport, Diagnostics, Member map, Workspace,
Settings, and Keyboard shortcuts — opens as a **floating window** rather than a
docked column, so the map keeps the full width. Drag a window by its header to move it,
double-click the header (or use `–`) to collapse it to its title bar, and close it with `×`.
The **dock** along the bottom restores any window, showing a solid chip for an open window,
an outlined chip for a collapsed one, and a plain chip for a closed one. Position and
collapsed state are remembered per panel in `localStorage`, so a layout survives a reload.

A drill-in view carries an in-panel **← Back** that steps down to the view it replaced:
the Review panel walks back through the reviews shown this session (working tree, then
each commit or branch, disabled at the start of the history), the Module Passport returns
to the module it was opened from and then to the map, and the Member map returns to the
Module Passport it was opened from.

Selecting a node opens the **Module Passport**: direct importers, blast radius, direct
imports, depends-on (all), plus Imports and Used by with source evidence and an
`Open in Workspace` action. Dependencies, Dependents, Members, Functions, and Impact are
separate tabs so a large file does not push its member list off screen.

The **Functions** tab is a sortable table with one row per function and a summary line
(function count, total and max complexity, max nesting, signal count). Columns cover name,
visibility or entry badge, lines, span, complexity, nesting, loops, calls (count), callers
(count or entry badge), and signals (chips); the default order is signal count, then
complexity. A function the runtime or a framework invokes — a test, `main`, a handler, or
a function passed by reference — carries an **entry** badge with the attribute or line that
proved it, instead of reading as dead code with "no callers". Callers resolve within the
file only, so a public function with none says *no callers in this file (cross-file not
resolved)*. Expanding a row shows the full signature, the recorded metrics, and every call
site with its line, and a call site jumps to the callee's own row. A language without a
symbol extractor reports that extraction is not implemented, and a function whose body was
not read shows `signature only` rather than a fabricated zero. The same recorded metrics
drive deterministic cost signals (nested loops, a linear scan or sort inside a loop, deep
nesting, high complexity, long body, many parameters, recursion); the **Function hotspots**
review overlay ranks the functions that trip at least one and marks the files that carry
them. Each signal names the recorded value and threshold, so it points at evidence rather
than a verdict.

Selecting an edge opens **Edge evidence**: the relationship kind, the recorded specifier and
line, and how the import resolved (`module tree`, `alias`, and so on). Unrecorded fields read
`not recorded` rather than being guessed, and the panel offers actions to open either
endpoint or trace a path between them.

The **Member map** in the inspector groups declared types, fields, properties, and methods
with their visibility and type where symbol extraction is available (TypeScript/TSX,
JavaScript/JSX, Python, Java, Kotlin, Rust, C#, and C++ today); other languages report that extraction is not implemented
rather than an empty list. Where the scan recorded field references inside method bodies — an explicit
`this.x` / `self.x`, or an unshadowed bare name — it also shows **Data flow** panels
(`Sources / inputs`, `Resources / hubs`, `Transforms`, `Sinks / outputs`) and per-member
read/write wiring. When nothing was recorded, the panels say so; cross-file access is not
claimed. For a language that splits a type across files (C++), the one file's extraction
also reads the headers its recorded include edges name, so a class declared in a header and
defined in a `.cpp` is reconstructed without searching or guessing a path.

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

The unit suite runs entirely in Node. The DOM panels are covered through jsdom
(`test/unit/panels.test.ts`), so a panel's model-to-tree transform is asserted without a browser.
The panels live in `ui/strabo-panel-*.js` (one module per topic, with shared DOM primitives in
`ui/strabo-panel-kit.js`) and are re-exported by `ui/strabo-panels.js`, the stable entry point the
tests and `ui/strabo.js` import.

`npm run test:pack` builds the real tarball, asserts the published file set (dist, public,
all four grammar assets, bin, README; no src/test/node_modules), installs it into a fresh
consumer project, and runs the shipped `strabo` and `strabo/server` entry points including
a Java resolution so packaged grammar assets are proven to load.

Browser acceptance lives in `test/acceptance/` and drives a real Chromium against the
standalone server, asserting only published API and UI behaviour. See
`test/acceptance/README.md`.

## Internals and design

The repository boundary, architecture, graph contract, parser resolution rules, source
layout, entry-point detection, non-goals, and the deliberately parked surface are
documented in [docs/DESIGN.md](docs/DESIGN.md), kept apart from shipped behaviour so a
designed surface is never documented as if it resolves.

## License

[MIT](LICENSE)
