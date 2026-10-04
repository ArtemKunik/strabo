# Changelog

## Unreleased

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
