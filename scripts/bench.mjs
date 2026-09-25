import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildAdjacency, computeGraphMetrics } from '../src/analysis/analysis.ts';
import { clearHistoryCache, collectHistory } from '../src/analysis/history.ts';
import { computeRepositoryPassport } from '../src/analysis/passport.ts';
import { buildSystemReport } from '../src/analysis/system.ts';
import {
  CACHE_ARTIFACT_VERSION,
  cacheRoot,
  clearDiskCache,
  clearMemoryCache,
  fingerprint,
  getCachedGraph,
} from '../src/cache/graph-cache.ts';
import { describeRepository } from '../src/repository.ts';
import { scanJsTsCalls } from '../src/scan/calls.ts';
import { looksMinified } from '../src/scan/exclusions.ts';
import { findGitIgnoredFiles } from '../src/scan/gitignore.ts';
import { scanJsTsEdges } from '../src/scan/scan-js.ts';
import { isPolyglotSource, scanPolyglotEdges } from '../src/scan/scan-polyglot.ts';
import { collectSourceFiles, isSourceExtension } from '../src/scan/scan.ts';
import { buildSystemViewModel } from '../src/view/view-model.ts';

/**
 * Phase 18 P1: report where a scan's time goes, cold and warm, and record it.
 *
 * The stages below are timed by calling the nearest production function. `scanRepository`
 * has no per-stage seam, so parse, extract, and resolve are the enclosing edge passes and
 * overlap: each of `scanPolyglotEdges`, `scanJsTsEdges`, and `scanJsTsCalls` also performs
 * the other two steps. Numbers are never split or invented to fake a clean partition, and
 * `approximate` on a stage says so. Warm is a real `getCachedGraph` hit, never a bypass.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** scan.ts refuses files past this size; mirrored here so the harness reads the same set. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export const STAGE_NAMES = ['walk', 'read', 'parse', 'extract', 'resolve', 'metrics', 'analysis', 'history'];

export function benchDirectory() {
  const configured = process.env.STRABO_BENCH_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(cacheRoot(), 'bench');
}

function timed(work) {
  const started = performance.now();
  return Promise.resolve()
    .then(work)
    .then((value) => ({ ms: performance.now() - started, value }));
}

function resolveRoot(input) {
  const candidate = path.resolve(input?.trim() || repoRoot);
  let stat;
  try {
    stat = fs.statSync(candidate);
  } catch {
    throw new Error(`Repository path does not exist: ${candidate}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Repository path is not a directory: ${candidate}`);
  }
  return candidate;
}

function isInsideRoot(target, root) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function measureScanStages(root) {
  const exclusions = [];
  const diagnostics = [];

  const walk = await timed(() => collectSourceFiles(root, exclusions, diagnostics));

  const read = await timed(async () => {
    const ignored = await findGitIgnoredFiles(root, walk.value);
    const contentByFile = new Map();
    for (const file of walk.value) {
      if (ignored.has(file) || !isSourceExtension(file)) {
        continue;
      }
      const absolute = path.join(root, file);
      let stat;
      try {
        stat = fs.statSync(absolute);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        continue;
      }
      const content = fs.readFileSync(absolute, 'utf8');
      if (looksMinified(content)) {
        continue;
      }
      contentByFile.set(file, content);
    }
    return contentByFile;
  });

  const contentByFile = read.value;
  const files = [...contentByFile.keys()].sort();

  const extract = await timed(() => scanJsTsEdges(files, contentByFile, { root }));
  const parse = await timed(() => scanPolyglotEdges(files.filter(isPolyglotSource), contentByFile));
  const resolve = await timed(() => scanJsTsCalls(files, contentByFile, { root }));

  return {
    files,
    ms: { walk: walk.ms, read: read.ms, extract: extract.ms, parse: parse.ms, resolve: resolve.ms },
  };
}

/**
 * Time the first usable payload of the two server documents that open a repository.
 *
 * The routes are `GET /analysis/passport` (the repository passport) and
 * `GET /graph?system=1` (the System view model). Each role is timed cold then warm: the
 * second call measures steady state after manifests and filesystem entries are in cache.
 * The System row includes building the report, because that is what the route does before
 * it can return a model.
 */
async function measureFirstPaint(root, repository, cached) {
  const report = cached.report;
  const cache = {
    status: cached.status,
    fingerprint: cached.fingerprint,
    artifactVersion: CACHE_ARTIFACT_VERSION,
    generatedAt: report.scannedAt,
    stale: cached.stale,
  };
  const passport = () =>
    computeRepositoryPassport(repository.name, report.graph, report.extensionCounts);
  const system = () =>
    buildSystemViewModel(
      buildSystemReport(root, repository.name, report.graph),
      repository,
      cache,
      report.graph,
    );

  const passportCold = await timed(passport);
  const passportWarm = await timed(passport);
  const systemCold = await timed(system);
  const systemWarm = await timed(system);

  return {
    passport: {
      coldMs: passportCold.ms,
      warmMs: passportWarm.ms,
      approximate: false,
      source: 'computeRepositoryPassport (GET /analysis/passport)',
      includes: 'languages, entry points, directories, top files, cycles, unreached files',
    },
    system: {
      coldMs: systemCold.ms,
      warmMs: systemWarm.ms,
      approximate: false,
      source: 'buildSystemReport + buildSystemViewModel (GET /graph?system=1)',
      includes: 'unit roll-up, layers, communities, unit cards, positions',
    },
  };
}

/**
 * Read the corpus provenance manifest a generator wrote, when one is given.
 *
 * A synthetic corpus is not a repository, so its file count and language mix cannot be
 * inferred from `revision`; the manifest makes the measured tree and how to regenerate it
 * part of the committed result instead of an unverifiable claim in prose.
 */
function readCorpusManifest(corpusArg) {
  const configured = typeof corpusArg === 'string' && corpusArg.trim() !== '' ? corpusArg.trim() : null;
  if (!configured) {
    return null;
  }
  const file = path.resolve(configured);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read corpus manifest ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { manifestPath: file, ...parsed };
}

export async function runBenchmark(repoArg, outArg, corpusArg) {
  const root = resolveRoot(repoArg);
  const repository = await describeRepository(root);
  const rev = await fingerprint(root);
  const benchDir = benchDirectory();
  const outputPath = typeof outArg === 'string' && outArg.trim() !== '' ? path.resolve(outArg) : null;
  const corpus = readCorpusManifest(corpusArg);

  // Empty every cache the measured paths read before the cold pass.
  clearMemoryCache(root);
  clearDiskCache(root);
  clearHistoryCache();

  const scan = await measureScanStages(root);

  const historyCold = await timed(() => collectHistory(root, scan.files));
  const historyWarm = await timed(() => collectHistory(root, scan.files));

  // The cold miss is timed here, after the stage pass, so the parser runtime is already warm;
  // one-time grammar loading lands in the stage pass's parse/resolve rows, not this number.
  clearMemoryCache(root);
  clearDiskCache(root);
  const cold = await timed(() => getCachedGraph(root));
  const memory = await timed(() => getCachedGraph(root));
  clearMemoryCache(root);
  const disk = await timed(() => getCachedGraph(root));

  const report = cold.value.report;
  const metrics = await timed(() => computeGraphMetrics(report.graph, buildAdjacency(report.graph)));
  const analysis = await timed(() => computeRepositoryPassport(root, report.graph, report.extensionCounts));
  const firstPaint = await measureFirstPaint(root, repository, cold.value);

  const measured = {
    walk: { coldMs: scan.ms.walk, approximate: false, source: 'collectSourceFiles', includes: 'directory walk' },
    read: {
      coldMs: scan.ms.read,
      approximate: true,
      source: 'harness read loop (mirrors scan.ts:44-76)',
      includes: 'git check-ignore, stat, size cap, readFileSync, minified check',
    },
    parse: {
      coldMs: scan.ms.parse,
      approximate: true,
      source: 'scanPolyglotEdges',
      includes: 'polyglot extract and resolve',
    },
    extract: {
      coldMs: scan.ms.extract,
      approximate: true,
      source: 'scanJsTsEdges',
      includes: 'JS/TS reference extraction and resolve',
    },
    resolve: {
      coldMs: scan.ms.resolve,
      approximate: true,
      source: 'scanJsTsCalls',
      includes: 'JS/TS call parse and extract',
    },
    metrics: {
      coldMs: metrics.ms,
      approximate: false,
      source: 'buildAdjacency + computeGraphMetrics',
      includes: 'adjacency and transitive reach',
    },
    analysis: {
      coldMs: analysis.ms,
      approximate: false,
      source: 'computeRepositoryPassport',
      includes: 'passport; recomputes metrics, cycles, and coverage',
    },
    history: {
      coldMs: historyCold.ms,
      approximate: false,
      source: 'collectHistory',
      includes: 'one bounded git log --numstat window',
    },
  };

  const stages = STAGE_NAMES.map((stage) => ({
    stage,
    coldMs: measured[stage].coldMs,
    warmMs: stage === 'history' ? historyWarm.ms : null,
    approximate: measured[stage].approximate,
    source: measured[stage].source,
    includes: measured[stage].includes,
  }));

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    root,
    rootName: repository.name,
    revision: { head: repository.head, dirty: repository.dirty, gitUrl: repository.gitUrl },
    fingerprint: rev,
    corpus,
    cacheDir: benchDir,
    outputPath,
    files: {
      scanned: report.graph.nodes.length,
      edges: report.graph.edges.length,
      diagnostics: report.graph.diagnostics.length,
      excluded: report.graph.excluded.length,
    },
    graphCache: {
      cold: { status: cold.value.status, ms: cold.ms },
      memory: { status: memory.value.status, ms: memory.ms },
      disk: { status: disk.value.status, ms: disk.ms },
    },
    history: {
      available: historyCold.value.available,
      windowDays: historyCold.value.windowDays,
      commitsScanned: historyCold.value.commitsScanned,
    },
    stages,
    firstPaint,
    notes: [
      ...(corpus
        ? [
            `This result was measured on a ${corpus.kind ?? 'synthetic'} corpus, not an operator repository; ` +
              `seed ${corpus.seed}, ${corpus.generatedFiles} generated source files. Regenerate with: ${corpus.regenerate}.`,
          ]
        : []),
      'Stage rows call the nearest production function; scanRepository exposes no per-stage seam.',
      'parse, extract, and resolve overlap: each enclosing edge pass also performs the other two steps, so the rows are not additive.',
      'The cold graph-cache miss is timed after the cold stage pass, so its parser runtime is warm; one-time grammar loading is inside the stage pass, not that number.',
      'Node construction (entry points, line counts) and external-import collection are not separately measured.',
      'First paint rows time the builder the server calls for that payload; the System row also builds the report and reads manifests, so it is not a pure in-memory number.',
    ],
  };
}

function padRight(value, width) {
  return String(value).padEnd(width);
}

function milliseconds(value) {
  return value === null ? '-' : value.toFixed(1);
}

export function formatBenchmark(result) {
  const lines = [];
  lines.push('Strabo scan benchmark');
  lines.push(`repo         ${result.rootName} (${result.root})`);
  lines.push(`revision     ${result.revision.head ?? 'no git'}${result.revision.dirty ? ' (dirty)' : ''}`);
  lines.push(`fingerprint  ${result.fingerprint ?? 'none (no git)'}`);
  lines.push(`generated    ${result.generatedAt}`);
  lines.push(`results      ${result.outputPath ?? result.cacheDir}`);
  if (result.corpus) {
    lines.push(
      `corpus       ${result.corpus.kind ?? 'synthetic'} (seed ${result.corpus.seed}, ` +
        `${result.corpus.generatedFiles} files)`,
    );
  }
  lines.push('');

  lines.push('Graph cache (real getCachedGraph):');
  lines.push(`  ${padRight('tier', 8)} ${padRight('status', 10)} ${padRight('ms', 10)}`);
  for (const [tier, entry] of Object.entries(result.graphCache)) {
    lines.push(`  ${padRight(tier, 8)} ${padRight(entry.status, 10)} ${padRight(milliseconds(entry.ms), 10)}`);
  }
  lines.push('');

  lines.push('Scan stages (cold pass, nearest enclosing call):');
  lines.push(`  ${padRight('stage', 9)} ${padRight('cold ms', 10)} ${padRight('warm ms', 10)} ${padRight('approx', 7)} source`);
  for (const stage of result.stages) {
    lines.push(
      `  ${padRight(stage.stage, 9)} ${padRight(milliseconds(stage.coldMs), 10)} ${padRight(
        milliseconds(stage.warmMs),
        10,
      )} ${padRight(stage.approximate ? 'yes' : 'no', 7)} ${stage.source}`,
    );
  }
  lines.push('');
  lines.push('First paint (server payload builders, cold then warm):');
  lines.push(`  ${padRight('payload', 9)} ${padRight('cold ms', 10)} ${padRight('warm ms', 10)} source`);
  for (const [payload, entry] of Object.entries(result.firstPaint)) {
    lines.push(
      `  ${padRight(payload, 9)} ${padRight(milliseconds(entry.coldMs), 10)} ${padRight(
        milliseconds(entry.warmMs),
        10,
      )} ${entry.source}`,
    );
  }
  lines.push('');
  lines.push(
    `Files: ${result.files.scanned} scanned, ${result.files.edges} edges, ` +
      `${result.files.diagnostics} diagnostics, ${result.files.excluded} excluded`,
  );
  lines.push(
    `History: ${result.history.available ? `${result.history.commitsScanned} commits` : 'unavailable'}, ` +
      `${result.history.windowDays}-day window`,
  );
  lines.push('');
  lines.push('approx yes = that number is the enclosing call, which also performs the other sub-steps.');

  return lines.join('\n');
}

function writeResult(result) {
  const file =
    result.outputPath ??
    (() => {
      const stamp = result.generatedAt.replace(/[:.]/g, '-');
      const slug = result.rootName.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'repo';
      return path.join(result.cacheDir, `bench-${slug}-${stamp}.json`);
    })();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  return file;
}

/**
 * Parse `--out <path>` / `--out=<path>` and a single positional repository path.
 *
 * `STRABO_BENCH_OUT` is the environment equivalent of `--out`; an explicit flag wins.
 */
function parseArgs(argv) {
  let repo;
  let out = process.env.STRABO_BENCH_OUT;
  let corpus = process.env.STRABO_BENCH_CORPUS;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      out = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
    } else if (arg === '--corpus') {
      corpus = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--corpus=')) {
      corpus = arg.slice('--corpus='.length);
    } else if (repo === undefined) {
      repo = arg;
    }
  }
  return { repo, out, corpus };
}

async function main(args) {
  const options = parseArgs(args);
  const result = await runBenchmark(options.repo, options.out, options.corpus);
  const targetDir = result.outputPath ? path.dirname(result.outputPath) : result.cacheDir;
  if (isInsideRoot(targetDir, result.root)) {
    process.stderr.write(
      `Warning: bench results land inside the scanned tree (${targetDir}); pass --out outside it or set STRABO_BENCH_DIR.\n`,
    );
  }
  process.stdout.write(`${formatBenchmark(result)}\n`);
  const file = writeResult(result);
  process.stdout.write(`\nJSON written to ${file}\n`);
}

const entry = process.argv[1];
const isDirectRun = entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href;
if (isDirectRun) {
  await main(process.argv.slice(2));
}
