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

`--corpus <manifest.json>` (`STRABO_BENCH_CORPUS`) attaches a corpus provenance manifest
written by `scripts/bench-corpus.mjs` to the result under `corpus`. Pass it when the scanned
tree is synthetic, so the committed result says what was measured and how to regenerate it.

## Synthetic corpus (Phase 21 G4)

The G4 gate calls for a run on at least one **operator-supplied repository of 20k-50k
files, cold and warm**. No such repository was available, so the committed result was
measured on a **deterministic synthetic corpus** instead. It is *not* an operator
repository and is *not* committed; the generator is.

Generate it outside the repository (the OS temp directory is the intended home):

```bash
node scripts/bench-corpus.mjs --out <tmp>/strabo-bench-corpus --files 20000 --seed 20260925
```

The generator writes the tree plus a sibling `<out>.manifest.json`. The same `--seed` and
`--files` always produce byte-identical source files and a byte-identical manifest, so the
run is checkable by regenerating it. Layout and mix:

| Language | Files | Extensions |
| -------- | ----: | ---------- |
| TypeScript | 8500 | `.ts` |
| JavaScript | 2800 | `.js` |
| TSX | 1200 | `.tsx` |
| Python | 2050 | `.py` (includes one `__init__.py` per package) |
| Java | 1600 | `.java` |
| C# | 1200 | `.cs` |
| Rust | 1025 | `.rs` (includes one `lib.rs` per crate) |
| C++ | 1000 | `.h`, `.cpp` |
| Kotlin | 400 | `.kt` |
| SQL | 400 | `.sql` |
| **Total** | **20175** | |

Files carry internal imports in the form each scanned language uses: relative imports for
JS/TS (plus a shared `shared/kernel` package), package-relative modules for Python,
packages and imports for Java and Kotlin, namespaces for C#, `mod`/`use crate::` for Rust,
quoted includes for C++, and standalone schema for SQL. The manifest records the per-language
and per-extension counts from this run.

## Committed result

`synthetic-20k.json` is a real run on that corpus:

```bash
node scripts/bench-corpus.mjs --out <tmp>/strabo-bench-corpus --files 20000 --seed 20260925
npm run bench -- --out docs/bench/synthetic-20k.json \
  --corpus <tmp>/strabo-bench-corpus.manifest.json <tmp>/strabo-bench-corpus
```

Caveats, stated in the result's `notes` as well:

- The corpus is **synthetic, not an operator repository**. It mirrors scale and language
  mix, not the dependency shape, history, or file sizes of a real codebase.
- The corpus is **not a Git tree**, so `revision`, `fingerprint`, and `history` are
  `null`/`unavailable`: `collectHistory` runs and returns quickly, but no commits are
  mined, and the graph cache has no fingerprint to persist against (the `disk` tier is a
  real miss, not a stale hit). A result on an operator repository will differ.
- Timing is host-specific. Every run tells you where time went on *this* machine; the
  committed numbers are one such run, not a target.

## JSON shape

`schemaVersion` is `2`. A result is self-describing; the fields are:

| Field | Meaning |
| ----- | ------- |
| `generatedAt` | ISO timestamp of the run. |
| `root`, `rootName` | Absolute path scanned and its base name. |
| `revision` | `head`, `dirty`, `gitUrl` at scan time (null when not a git tree). |
| `fingerprint` | The cache fingerprint the graph was keyed by (null when not a git tree). |
| `corpus` | Provenance of a synthetic corpus (`kind`, `seed`, `generatedFiles`, `languages`, `extensions`, `regenerate`), or `null` for a real repository. |
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
