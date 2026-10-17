# Changelog

## 0.2.0

- Plan an extraction before moving anything: for a file set, the outside files it imports
  (cut each, or take it along, with what each drags in), the inside files the rest imports,
  the transitive closure, cycles across the boundary, shared env/route/flag keys, and the
  external packages (`GET /analysis/extraction`, MCP `plan_extraction`).
- Simulate structural edits on a copy of the graph: `cut`, `add`, and `move` report the
  cycles introduced or resolved, wrong-way tier edges, rule violations, test reach lost, and
  blast radius, writing nothing (`GET /analysis/what-if`, MCP `simulate_change`).
- A **Sandbox** window collects those edits from the map's right-click menu or its own form,
  rings the map with the result, shows the extraction plan for a directory, file, or group,
  and can delegate either answer to an agent.
- `strabo_review` / `get_change_risk` take `paths` (globs, files, or folders) so a dirty
  working tree's unrelated changes stay out; totals, impact, and risk are recomputed for the
  kept files, and `scope` names what was kept. `GET /analysis/review` accepts the same
  `paths` query.
- **Changed:** `strabo_review` now returns a compact summary by default, one row per changed
  file (change and file risk, band, cycle size, top signals, edge and test counts), riskiest
  first. Pass `detail: "full"` for the previous full body.
- Ship two agent skills in the package, `skills/strabo-structural-coding` and
  `skills/strabo-review`, that teach a coding agent to look, simulate, and verify with the
  MCP tools, and to review a change by scope, triage, and new-versus-pre-existing problems.

## 0.1.2

- Read HTTP routes declared in code, not only in OpenAPI documents: Express, Fastify, Koa,
  Hono, NestJS, FastAPI, Flask, Spring, JAX-RS, ASP.NET (minimal and controllers), Axum, and
  Actix registrations become endpoints with their line, framework, and handler, so route edges
  and the Structure trace work in repositories without a spec.
- Stop recording a route registration (`app.get('/x', h)`, `@app.get("/x")`) as an outbound
  HTTP call.
- Compare the OpenAPI document with the routes the code registers: undocumented routes and
  unimplemented operations in `GET /analysis/routes/conformance`, the MCP tool
  `get_route_conformance`, a new HTTP API report section, and `strabo check --fail-on=route-drift`.
- Classify HTTP API changes between two revisions as breaking, conditional, or safe (removed
  endpoints, new required parameters and request fields, removed or now-optional response
  fields, incompatible types), naming the recorded callers of each breaking change. It is in
  the change report, `GET /analysis/http-api-diff`, the MCP tool `get_http_api_diff`, and
  `strabo report --base=<ref> --fail-on=http-breaking`.
- List every HTTP endpoint with its handler file, the guard read from its middleware or
  decorators, the tests that reach it, and its callers (`GET /analysis/endpoints`, MCP
  `get_endpoints`), with a per-route passport that adds declared parameters, bodies, and the
  tables near the handler (`GET /analysis/endpoint-passport`, MCP `get_endpoint_passport`), and
  an **HTTP endpoints** review overlay that rings files with an untested or unguarded route.
- Read gRPC services (`.proto` rpcs, streaming kind, message fields, gRPC-gateway routes) and
  GraphQL root fields (schema files and SDL in source) as endpoints, with their implementing
  files and their callers (stub calls, GraphQL selections), in the endpoint list, the
  passport, the workspace service list, and the API diff.
- Notice a second edit to a file that is already modified: the graph cache and the freshness
  badge now fingerprint each changed file's size and mtime, not just the `git status` lines,
  and the on-disk cache is keyed by the package version so an upgrade never serves an old graph.
- The Commit action keeps a staged selection: with something already staged it commits that
  index as it stands, and only stages the whole working tree when nothing is staged.
- Find cytoscape wherever npm installed it, so a host that embeds `strabo-map/server` (where
  it is hoisted) no longer loads the map without its renderer. `@xterm/*` moves to
  `devDependencies`, since it is bundled into the UI at build time.
- Refuse every cross-origin state-changing request with one router-wide guard. The narrator,
  tour, coverage-plan, coverage-weekly, repository add/remove, and terminal-close routes had
  no check of their own.
- Keep the terminal and delegation on this machine: binding `--host 0.0.0.0` shares the map,
  not a shell. `--allow-remote-terminal` (`STRABO_ALLOW_REMOTE_TERMINAL=1`) opts in.
- CLI: a flag's value is no longer read as the repository path (`strabo report --base main`
  failed), `--port` and `--version` are new, a missing path or mistyped command fails with a
  message, and a port already in use is reported in one line instead of a stack trace.

## 0.1.1

- Read Android/Kotlin local device stores (SharedPreferences, EncryptedSharedPreferences,
  DataStore, and raw SQLite) as data hubs, so the Structure data-flow view shows an app's
  writes and reads instead of an empty canvas.
- Fix the tier intent reading: infer a tier from a rule pattern only when it matches no file, so
  a directory shared with a declared tier (`api/**`) no longer names a tier with no node (which
  could not be drawn).
- Draw every tier a ghost edge names, so an intent edge never refers to a missing node.
- Lay the data-flow hubs in a compact grid beside the stack, sized as hubs rather than files.
- Give the Structure edge labels a collision budget, like node labels, so a hub's several edges
  no longer stack their level labels into a doubled read.

## 0.1.0

First public release.

- Scan a local repository into an interactive map of files, dependencies, and change impact.
- Structure view with tiers, support shelf, and recorded data flows, narrated from recorded facts.
- Tree-sitter parsers for TypeScript/TSX, Python, Java, Kotlin, C#, C++, Rust, and SQL.
- CLI (`strabo`), a programmatic API, and a server entry point.
- MCP integration, GitHub Action, and drift reporting.
