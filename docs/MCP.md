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
| `strabo_file` | `get_context` | one file's change-impact passport, with its recorded import edges and their evidence |
| `strabo_impact` | `get_impact` | reverse-dependency impact of the pending change set or a revision |
| `strabo_review` | `get_change_risk` | the pending working-tree change set and its rolled-up risk |
| `strabo_path` | `get_dependency_path` | the shortest recorded path between two files, each hop with evidence |

Also canonical-only: `get_risk`, `get_cycles`, `get_smells`, `get_tier`, `get_dead_code`.

File-level tools carry the recorded edge, not only the target path: each edge is the graph's
own record with `evidence.line` (the 1-based import line) and `evidence.specifier` (the
specifier as authored), so a claim can be checked against the source.

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
