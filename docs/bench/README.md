# Benchmark results

`scripts/bench.mjs` (`npm run bench`) times a scan and the first paint of the two server
documents that open a repository. Results are written as JSON, and a run can be committed
here so regressions show across revisions.

## Running

Measure the current repository and leave the JSON in the cache directory:

```bash
npm run bench
# or, pointing at any directory:
node scripts/bench.mjs /path/to/repository
```

Write the result to a named file under this directory:

```bash
node scripts/bench.mjs --out docs/bench/<name>.json /path/to/repository
```

`--out` accepts `--out <path>` or `--out=<path>` and may precede or follow the repository
path. `STRABO_BENCH_OUT` is the environment equivalent; an explicit `--out` wins. When no
output is named, the file lands in `cacheRoot()/bench` with a timestamp (override that
directory with `STRABO_BENCH_DIR`). A result written inside the scanned tree prints a
warning, because scanning that tree would then include the result.

## Committed result

The Phase 21 G4 gate calls for a run on at least one **operator-supplied repository of
20k-50k files, cold and warm**. No such repository is available to the repository owner in
this checkout, so **no result is committed yet**: committing one would require inventing
numbers. Once an operator supplies a repository, run the command above, commit the JSON
under this directory, and note the repository name, revision, and file count.

## JSON shape

`schemaVersion` is `2`. A result is self-describing; the fields are:

| Field | Meaning |
| ----- | ------- |
| `generatedAt` | ISO timestamp of the run. |
| `root`, `rootName` | Absolute path scanned and its base name. |
| `revision` | `head`, `dirty`, `gitUrl` at scan time (null when not a git tree). |
| `fingerprint` | The cache fingerprint the graph was keyed by. |
| `cacheDir` | Default cache directory for results. |
| `outputPath` | Absolute path this run was written to, or `null`. |
| `files` | `scanned` nodes, `edges`, `diagnostics`, `excluded`. |
| `graphCache` | `cold`/`memory`/`disk`, each `{ status, ms }`, from real `getCachedGraph` calls. |
| `history` | `available`, `windowDays`, `commitsScanned` from the git-history pass. |
| `stages` | One row per scan stage (see below). |
| `firstPaint` | The passport and System-view payload builders (see below). |
| `notes` | Caveats about what each number does and does not include. |

### `stages[]`

Each row is `{ stage, coldMs, warmMs, approximate, source, includes }`. `stage` is one of
`walk`, `read`, `parse`, `extract`, `resolve`, `metrics`, `analysis`, `history`. `coldMs`
is the cold pass; `warmMs` is non-null only for `history` (a real warm `collectHistory`).
`approximate: true` marks a row that is the nearest enclosing production call and therefore
also performs the other sub-steps, so the rows are **not additive**. `parse`, `extract`,
and `resolve` overlap for this reason.

### `firstPaint`

Each entry is `{ coldMs, warmMs, approximate, source, includes }`:

| Key | Server route it feeds | Builder |
| --- | --------------------- | ------- |
| `passport` | `GET /analysis/passport` | `computeRepositoryPassport` |
| `system` | `GET /graph?system=1` | `buildSystemReport` + `buildSystemViewModel` |

`coldMs` and `warmMs` are the first and second call across the same cached graph. The
System row also builds the report and reads manifests, so it is not a pure in-memory
number; `passport` is derived from the already-scanned graph.

## Notes on honesty

- Every number comes from calling the production function named in `source`; none is split
  or blended to look like a clean partition.
- `warm` is a real cache hit, never a bypass.
- Grammar loading is one-time and lands in the stage pass, not in the graph-cache cold miss.
