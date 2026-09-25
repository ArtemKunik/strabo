# Headless surfaces

The same scan that backs the server also backs a CLI and an agent tool surface. Starting
the server is the default; the rest are explicit subcommands.

## Export, check, and MCP

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
[MCP.md](./MCP.md).

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

The document has six parts:

- **Overview** — languages and size, entry points, top-level directories, and the most
  depended-upon files by fan-in.
- **Pain points** — cycles, tier leaks, smells, hotspots, untested reach, bus factor,
  advisories and denied licences, parse failures, and a stale graph, ranked by severity.
- **Pending change set** — the working tree's staged, unstaged, and untracked files with the
  same reverse-reachability impact the Review panel shows.
- **Architecture drift** — one line per structural measure (cycles, largest cycle, modules,
  largest module, dependency edges, largest blast radius) across the ten most recent
  revisions, each point naming its revision. A measure the revision cache cannot supply is a
  gap (`—`), never a zero. Skip it with `--no-drift`.
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
`--no-hotspots`, `--no-ownership`, and `--no-drift` skip an analysis; a skipped section is
named as not computed. `--format` and `--out` use the `--flag=value` form.

## Change report: scope fence and public API

`strabo report --base <ref>` is the change report. Two Phase 29 sections answer "did an agent
stay in its lane, and is this a breaking change?" with facts:

```sh
# scope fence: list changes outside a declared zone, and inside changes imported from outside
node bin/strabo.js report --base=main --expect='src/auth/**' --format=md

# the public API diff and the drift section are always computed for a change report
node bin/strabo.js report --base=main --format=json
```

- **Scope fence** (`--expect`, repeatable or comma-separated globs) lists every changed path
  outside the zone, plus every changed path inside it whose recorded importers lie outside it.
  It is a filter over the review, pure evidence: a path matches a glob or it does not.
- **Public API** lists exported and `pub` symbols added, removed, or re-signed between the two
  revisions, per language, and names the recorded consumers of a removed or changed symbol.

Declared-architecture rules (`strabo.rules.yml`, or the `rules:` key of `strabo.groups.yml`)
turn operator intent into a check failure: a rule id is passed straight to `--fail-on`, e.g.
`strabo check --fail-on=domain-no-infra` fails on an edge the rule forbids and names the rule,
the edge, and its evidence line.

## Pull request comments (GitHub Action)

The repository root is also a GitHub Action. It runs the change report for a pull request
against its base commit, posts it as one comment that later pushes update in place, adds it
to the job summary, and fails the check only for the rules named in `fail-on`.

```yaml
# .github/workflows/strabo.yml
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  strabo:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ArtemKunik/strabo@main
        with:
          fail-on: cycle,tier        # optional; empty reports without failing
          expect: 'src/auth/**'      # optional scope fence
```

Inputs: `base` (defaults to the pull request's base commit, fetched if the checkout is
shallow), `fail-on`, `expect`, `comment` (`true`), `version` (the `strabo-map` release to run,
`latest` by default), and `github-token`. Outputs: `report` (the Markdown file) and `failed`.
