# MCP server

`strabo mcp` serves the recorded analysis over the Model Context Protocol on stdio, so an
agent can ask about a repository without a browser and without a second implementation: the
tools call the same router handlers the HTTP surface uses.

## Configure a client

Both snippets run Strabo from a checkout; replace the path with your install. Pass the
repository as the positional argument (or set `STRABO_ROOT`), and set `STRABO_STATE_DIR` if
you want the cache somewhere other than the default.

Claude Code, in a project `.mcp.json`:

```json
{
  "mcpServers": {
    "strabo": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/strabo/bin/strabo.js", "mcp", "/path/to/repo"],
      "env": {
        "STRABO_SCAN_CEILING": "/path/to",
        "STRABO_STATE_DIR": "/path/to/strabo-state"
      }
    }
  }
}
```

opencode, in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "strabo": {
      "type": "local",
      "command": ["node", "/path/to/strabo/bin/strabo.js", "mcp", "/path/to/repo"],
      "enabled": true,
      "environment": {
        "STRABO_SCAN_CEILING": "/path/to",
        "STRABO_STATE_DIR": "/path/to/strabo-state"
      }
    }
  }
}
```

## The read-only boundary

- The transport is stdio. The server writes JSON-RPC responses to stdout and diagnostics to
  stderr, and never opens a network listener, so it is not reachable from the network and
  cannot be used to write to the repository.
- Only `initialize`, `ping`, `tools/list`, and `tools/call` are answered. State-changing HTTP
  routes — `PUT /settings`, `POST /settings/restart`, the branch `fetch|pull|sync|push|drop`
  actions, and `POST /analysis/commit` — are not exposed as tools.
- Every path resolves through the configured scan ceiling, the same boundary the server uses.
  A `repository` argument outside the ceiling is refused, not silently clamped.
- Starting the server is explicit: the bare `strabo` command serves the HTTP UI; only
  `strabo mcp` starts this surface.

## Tools

Canonical names and aliases share one implementation, so they cannot drift.

| Alias | Canonical | Answers |
| --- | --- | --- |
| `strabo_passport` | `get_overview` | repository passport: languages, size, entry points, hubs, cycles, unreached modules |
| `strabo_file` | `get_context` | one file's change-impact passport, with its recorded import edges, their evidence, and its tier and unit |
| `strabo_impact` | `get_impact` | reverse-dependency impact of the pending change set or a revision, each affected file with its tier and unit |
| `strabo_review` | `get_change_risk` | the pending working-tree change set and its rolled-up risk |
| `strabo_path` | `get_dependency_path` | the shortest recorded path between two files, each hop with evidence |
| `strabo_coverage` | `get_coverage` | test coverage at the project, folder, or file scope from the repository's own measured report, with test-reach as the labelled fallback |

Also canonical-only: `get_risk`, `get_cycles`, `get_smells`, `get_tier`, `get_tier_flow`
(the application logical structure from the tier lens: ranked tiers, cross-tier dependency
edges with weights and cross-unit flags, support tiers on the shelf, and the intra-tier
ratio), `get_structure_data_flow` (the data-flow reading of the Structure view: recorded
reads and writes routed through data hubs between role tiers, dataset lineage, which hubs a
contract governs, and the honesty diagnostics), `get_dead_code`, `get_scope_fence` (changed
paths outside a declared zone, plus
inside changes imported from outside), `get_uncovered_changes` (changed-line coverage:
git-diff additions intersected with the repository's measured coverage report, with
uncovered modified functions, public-surface functions first), `get_http_api_diff` (HTTP
endpoints, parameters, and body fields changed between two revisions, classified breaking,
conditional, or safe, with the recorded callers of each breaking change), `get_public_api_diff`
(exported symbols added, removed, or re-signed between two revisions, with their recorded
consumers), `get_clones` (functions whose normalised bodies hash the same), `get_string_edges`
(environment variables, HTTP routes, and feature flags, with dynamic keys reported as not
resolved), `get_route_conformance` (the OpenAPI operations a repository documents against the
routes its source registers, with the gaps on both sides), `strabo_rules` (the declared
architecture rules and the edges that violate them),
`get_drift` (one structural-measure series per recent revision, a gap rather than a zero
where the cache has no measure), `get_data_products` (the recorded data layer: datasets,
declared data products with their ports, owners, contracts, and conformance findings,
undeclared product candidates, and event/message flows), `get_data_lineage` (static lineage
for one dataset or all of it: the recorded `derives` edges with their evidence lines and the
upstream and downstream datasets), `get_dataset_consumers` (who reads a dataset or column:
recorded readers, downstream datasets, governing contracts, and owning data products),
`get_data_contracts` (the governed data contracts: definitions with declared-vs-DTO origin,
governed boundaries with conformance, uncontracted crossings, orphaned contracts, unverified
matches), `get_contract_consumers` (downstream files and units for one contract id or field),
and `check_contract_conformance` (schema fields, access roles, and recorded deviations per
governed edge; uncontracted pairs are reported, never conforming).

File-level tools carry the recorded edge, not only the target path: each edge is the graph's
own record with `evidence.line` (the 1-based import line) and `evidence.specifier` (the
specifier as authored), so a claim can be checked against the source.

`strabo_file` also carries the file's tier and unit, composed from the canonical `get_tier`
lens rather than a second classifier:

- `tier` is the role the file plays (`frontend`, `api`, `domain`, `data`, `integration`,
  `infra`, `build`, `tests`, or `unclassified`), with `tierEvidence` listing the recorded
  evidence behind it and `tierMixed: true` when two tiers share the strongest evidence.
- `unit` is the build unit the file belongs to, from the tier lens's own unit roots (the
  longest enclosing unit, else the root `.`).
- `strabo_impact` attaches the same `tier` and `unit` to every entry in `affected`.

Tier and unit are never guessed. When the tier lens cannot be read at all, the result names
`tierUnavailable` and leaves both fields `null`; when the lens simply did not classify the
file, `tier` is `null` with a `tierNote` explaining why, and the unit is still derived from
the path.

## Bounded results

A tool result is capped so one call cannot hand an agent an unbounded string:

- Each list is paged at 50 items by default. Pass `limit` (up to 500) and `offset` to page.
- A cut list makes the result say so: `truncated: true`, `listsTruncated`, and a `truncation`
  array naming each list's `path`, `shown`, `total`, `omitted`, and `nextOffset`. A short
  list is untouched.
- A body over the serialized cap is replaced by a marker naming the cap and how to narrow the
  query, rather than being silently truncated. The entire graph is never returned by a tool.

## The `unavailable` contract

Strabo reports only what the scan recorded. A fact it does not have is named, never guessed:

- A tool call that fails returns `{ "unavailable": true, "status": <http status>, "detail":
  <body> }` with `isError`, so the agent sees the reason instead of a plausible value.
- Inside a successful payload, a missing measurement is `null` and explained in `note` (for
  example, `"no symbol extractor for this language"`), and an absent optional fact is omitted
  rather than fabricated.
- When edge evidence could not be read, the file-level result carries
  `evidenceUnavailable` instead of empty edges that would look complete.
- When the tier lens could not be read, `strabo_file` and `strabo_impact` carry
  `tierUnavailable` and leave `tier` and `unit` `null`, rather than inferring a role.
