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
  routes — `PUT /settings`, the branch fetch/push/sync actions — are not exposed as tools.
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

Also canonical-only: `get_risk`, `get_cycles`, `get_smells`, `get_tier`, `get_dead_code`,
`get_scope_fence` (changed paths outside a declared zone, plus inside changes imported from
outside), `get_public_api_diff` (exported symbols added, removed, or re-signed between two
revisions, with their recorded consumers), `get_clones` (functions whose normalised bodies
hash the same), `get_string_edges` (environment variables, HTTP routes, and feature flags,
with dynamic keys reported as not resolved), `strabo_rules` (the declared architecture rules
and the edges that violate them), and `get_drift` (one structural-measure series per recent
revision, a gap rather than a zero where the cache has no measure).

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
