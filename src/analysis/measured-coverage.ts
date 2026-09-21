import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { isInside, toPosix } from '../boundary/repository-root.ts';
import type { Graph } from '../types.ts';

const run = promisify(execFile);

/**
 * Read the coverage reports a repository already has. This module never runs a test or a
 * coverage tool: it only parses an `lcov.info`, a Cobertura XML, or a JaCoCo XML that is
 * already on disk inside the scan ceiling.
 *
 * Every figure is a recorded one. A file the report does not name is left out rather than
 * assumed covered, a function the report does not name is `unavailable`, and a report that
 * is absent or malformed yields `available: false` with a reason rather than zeros. The
 * reachability in `coverage.ts` stays the fallback, and every figure carries which it is.
 */

export type CoverageFormat = 'lcov' | 'cobertura' | 'jacoco';

export type CoverageUnavailableReason =
  | 'no-report-found'
  | 'report-unreadable'
  | 'report-malformed'
  | 'no-lines-recorded';

/** One function's recorded measured coverage. */
export interface MeasuredFunctionCoverage {
  name: string;
  /** Declaration line the report records; 0 when the format records none. */
  line: number;
  /** Lines the report attributes to this function; 0 when it records no per-function lines. */
  linesFound: number;
  linesHit: number;
  /**
   * Per-function line coverage percent, or null when the format records only an execution
   * count (LCOV `FNDA`) and no line span. Null is `unavailable`, never 0%.
   */
  lineCoverage: number | null;
  /** Execution count when the format records one, else null. */
  hits: number | null;
}

/** A parser's output: recorded per-file lines and functions, with no graph knowledge. */
export interface ParsedFileCoverage {
  /** The path exactly as the report wrote it. */
  rawPath: string;
  linesFound: number;
  linesHit: number;
  lineCoverage: number | null;
  functions: MeasuredFunctionCoverage[];
  functionsFound: number;
  functionsHit: number;
}

export interface ParsedCoverageReport {
  format: CoverageFormat;
  files: ParsedFileCoverage[];
}

/** One file's measured coverage, mapped onto the scanned graph. */
export interface MeasuredFileCoverage extends ParsedFileCoverage {
  /** Repository-relative POSIX path, or the literal report path when it falls outside. */
  file: string;
  /** False when `file` is not a node in the scanned graph; such a path is still listed. */
  inGraph: boolean;
  /** HEAD's last commit touching this file, ISO-8601; null when it was not read. */
  lastCommit: string | null;
  /** True when the report predates `lastCommit`; null when staleness was not assessed. */
  stale: boolean | null;
}

export interface MeasuredSummary {
  /** Graph nodes the report names. */
  filesMeasured: number;
  linesFound: number;
  linesHit: number;
  /** 0-100, or null when the report records no line counts. */
  lineCoverage: number | null;
}

/** The measured-coverage report for one repository, plus where it came from. */
export interface MeasuredCoverageSummary {
  /** True when a report was found and parsed; never true for a malformed or absent one. */
  available: boolean;
  /** `measured` when a report was read, otherwise the static-reach fallback. */
  basis: 'measured' | 'reachable';
  format: CoverageFormat | null;
  /** Repository-relative path of the report that was read. */
  reportPath: string | null;
  /** The report file's own mtime, ISO-8601, or null. */
  reportModified: string | null;
  /** `now - reportModified` in milliseconds, or null. */
  reportAgeMs: number | null;
  reason?: CoverageUnavailableReason;
  detail?: string;
  /** Candidates found inside the ceiling that could not be read or parsed. */
  skipped: Array<{ path: string; reason: string }>;
  /** Report-named files that are not graph nodes, sorted. Never silently dropped. */
  outOfGraph: string[];
  /** Per-file measured coverage, sorted by mapped path. */
  files: MeasuredFileCoverage[];
  /** Graph files whose measured figure predates that file's last commit. */
  stale: string[];
  summary: MeasuredSummary;
}

/** The provenance a route or axis can carry without the whole per-file list. */
export interface CoverageProvenance {
  available: boolean;
  basis: 'measured' | 'reachable';
  format: CoverageFormat | null;
  reportPath: string | null;
  reportModified: string | null;
  reportAgeMs: number | null;
  reason?: CoverageUnavailableReason;
  detail?: string;
  outOfGraph: string[];
  stale: string[];
  summary: MeasuredSummary;
}

export interface MeasuredCoverageOptions {
  /** Explicit report path(s) from env/config; relative to `root`, or absolute inside `ceiling`. */
  reportPaths?: readonly string[];
  /** The scan ceiling. A candidate outside it is never read; defaults to `root`. */
  ceiling?: string;
  /** Limit the `git log` staleness read to these graph files (e.g. one file for `/symbols`). */
  files?: readonly string[];
  /** Cap on `git log -1` calls, so a wide report cannot stall a request. Defaults to 200. */
  maxStalenessFiles?: number;
  /** Injectable clock; defaults to `Date.now`. */
  now?: () => number;
  /** Injectable report reader; defaults to a bounded read inside the ceiling. */
  readReport?: (absolutePath: string) => string | null;
  /** Injectable mtime reader; defaults to `fs.statSync`. */
  modifiedAt?: (absolutePath: string) => string | null;
  /** Injectable per-file last-commit reader; defaults to a bounded, cached `git log -1`. */
  lastCommitAt?: (file: string) => Promise<string | null>;
}

/**
 * Conventional report locations, in priority order. These are read directly even when the
 * scanner prunes the directory (`coverage/`, `target/`): the graph excludes generated
 * output, but the report's own path is evidence, not a source file.
 */
export const DEFAULT_COVERAGE_REPORT_PATHS: readonly string[] = [
  'coverage/lcov.info',
  'lcov.info',
  'coverage/lcov',
  'coverage.xml',
  'cobertura.xml',
  'coverage/cobertura.xml',
  'coverage/coverage.xml',
  'build/cobertura.xml',
  'target/site/jacoco/jacoco.xml',
  'build/reports/jacoco/test/jacocoTestReport.xml',
];

const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const LAST_COMMIT_CACHE_LIMIT = 2000;

/** HEAD's last-commit date per file, so a repeated request does not re-shell per file. */
const lastCommitCache = new Map<string, string | null>();

/** Drop the cached last-commit dates; tests call this so one case cannot read another's. */
export function clearMeasuredCoverageCache(): void {
  lastCommitCache.clear();
}

/** Detect the report format from its file name and content, or null when it is neither. */
export function detectCoverageFormat(filePath: string, content: string): CoverageFormat | null {
  const name = filePath.toLowerCase();
  const head = content.slice(0, 8192);
  if (name.endsWith('.xml') && /<coverage[\s>]/.test(head)) {
    return 'cobertura';
  }
  if (name.endsWith('.xml') && /<report[\s>]/.test(head)) {
    return 'jacoco';
  }
  if (!name.endsWith('.xml') && /^\s*(TN:|SF:|DA:|FN:|end_of_record)/m.test(content)) {
    return 'lcov';
  }
  if (/<coverage[\s>]/.test(head)) {
    return 'cobertura';
  }
  if (/<report[\s>]/.test(head) && /<package[\s>]/.test(head)) {
    return 'jacoco';
  }
  if (/^\s*(TN:|SF:)/m.test(content)) {
    return 'lcov';
  }
  return null;
}

/** Parse a report's text with the named format, or the detected one. */
export function parseCoverageText(
  content: string,
  filePath = '',
  format?: CoverageFormat,
): ParsedCoverageReport | null {
  const resolved = format ?? detectCoverageFormat(filePath, content);
  switch (resolved) {
    case 'lcov':
      return parseLcov(content);
    case 'cobertura':
      return parseCobertura(content);
    case 'jacoco':
      return parseJacoco(content);
    default:
      return null;
  }
}

/** Parse an LCOV tracefile: `SF` file records with `DA` lines and `FN`/`FNDA` functions. */
export function parseLcov(content: string): ParsedCoverageReport {
  interface Accumulator {
    rawPath: string;
    lineNumbers: Set<number>;
    hitLines: Set<number>;
    functions: Map<string, { line: number; hits: number | null }>;
    lf: number;
    lh: number;
    fnf: number;
    fnh: number;
  }

  const files: ParsedFileCoverage[] = [];
  let current: Accumulator | null = null;

  const flush = (): void => {
    if (!current) {
      return;
    }
    let linesFound = current.lineNumbers.size;
    let linesHit = current.hitLines.size;
    // A report may record only `LH`/`LF`; fall back to those when there are no `DA` lines.
    if (linesFound === 0 && current.lf > 0) {
      linesFound = current.lf;
      linesHit = current.lh;
    }
    const functions = [...current.functions.entries()]
      .map(([name, value]) => ({
        name,
        line: value.line,
        linesFound: 0,
        linesHit: 0,
        lineCoverage: null,
        hits: value.hits,
      }))
      .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
    files.push({
      rawPath: current.rawPath,
      linesFound,
      linesHit,
      lineCoverage: percent(linesHit, linesFound),
      functions,
      functionsFound: current.fnf > 0 ? current.fnf : functions.length,
      functionsHit: current.fnh > 0 ? current.fnh : functions.filter((fn) => (fn.hits ?? 0) > 0).length,
    });
    current = null;
  };

  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === 'end_of_record') {
      flush();
      continue;
    }
    if (line.startsWith('SF:')) {
      // A new `SF` before `end_of_record` still closes the previous file.
      flush();
      current = {
        rawPath: line.slice(3).trim(),
        lineNumbers: new Set(),
        hitLines: new Set(),
        functions: new Map(),
        lf: 0,
        lh: 0,
        fnf: 0,
        fnh: 0,
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (line.startsWith('DA:')) {
      const [linePart = '', countPart = ''] = line.slice(3).split(',');
      const lineNumber = Number.parseInt(linePart, 10);
      const count = Number.parseInt(countPart, 10);
      if (Number.isFinite(lineNumber) && Number.isFinite(count)) {
        current.lineNumbers.add(lineNumber);
        if (count > 0) {
          current.hitLines.add(lineNumber);
        }
      }
    } else if (line.startsWith('FN:')) {
      const rest = line.slice(3);
      const comma = rest.indexOf(',');
      const lineNumber = comma === -1 ? Number.NaN : Number.parseInt(rest.slice(0, comma), 10);
      const name = comma === -1 ? '' : rest.slice(comma + 1).trim();
      if (name && Number.isFinite(lineNumber)) {
        const existing = current.functions.get(name);
        current.functions.set(name, { line: lineNumber, hits: existing?.hits ?? null });
      }
    } else if (line.startsWith('FNDA:')) {
      const rest = line.slice(5);
      const comma = rest.indexOf(',');
      const hits = comma === -1 ? Number.NaN : Number.parseInt(rest.slice(0, comma), 10);
      const name = comma === -1 ? '' : rest.slice(comma + 1).trim();
      if (name) {
        const existing = current.functions.get(name) ?? { line: 0, hits: null };
        current.functions.set(name, {
          line: existing.line,
          hits: Number.isFinite(hits) ? hits : existing.hits,
        });
      }
    } else if (line.startsWith('LF:')) {
      current.lf = intOr(line.slice(3), 0);
    } else if (line.startsWith('LH:')) {
      current.lh = intOr(line.slice(3), 0);
    } else if (line.startsWith('FNF:')) {
      current.fnf = intOr(line.slice(4), 0);
    } else if (line.startsWith('FNH:')) {
      current.fnh = intOr(line.slice(4), 0);
    }
  }
  // A file record without a trailing `end_of_record` is still reported.
  flush();

  files.sort((a, b) => a.rawPath.localeCompare(b.rawPath));
  return { format: 'lcov', files };
}

/**
 * Parse a Cobertura XML (coverage.py and many JVM/.NET tools).
 *
 * A `<class>` is one file; its class-level `<lines>` are read with the `<method>` blocks
 * removed, so method lines are not double-counted. A method's own `<lines>` give its
 * per-function line coverage.
 */
export function parseCobertura(content: string): ParsedCoverageReport {
  interface Accumulator {
    rawPath: string;
    lineHits: Map<number, number>;
    functions: MeasuredFunctionCoverage[];
    attrFound: number;
    attrHit: number;
  }

  const byFile = new Map<string, Accumulator>();
  const ensure = (rawPath: string): Accumulator => {
    const existing = byFile.get(rawPath);
    if (existing) {
      return existing;
    }
    const created: Accumulator = { rawPath, lineHits: new Map(), functions: [], attrFound: 0, attrHit: 0 };
    byFile.set(rawPath, created);
    return created;
  };

  const classPattern = /<class\b([^>]*?)(?:\/>|>([\s\S]*?)<\/class>)/g;
  for (const match of content.matchAll(classPattern)) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    const rawPath = attr(attrs, 'filename');
    if (!rawPath) {
      continue;
    }
    const entry = ensure(rawPath);

    const bodyWithoutMethods = body.replace(/<method\b[\s\S]*?<\/method>/g, '');
    for (const lineMatch of bodyWithoutMethods.matchAll(/<line\b([^>]*?)\/?>/g)) {
      const number = intAttr(lineMatch[1], 'number');
      if (number !== null) {
        entry.lineHits.set(number, Math.max(entry.lineHits.get(number) ?? 0, intAttr(lineMatch[1], 'hits') ?? 0));
      }
    }
    entry.attrFound += intAttr(attrs, 'lines-valid') ?? 0;
    entry.attrHit += intAttr(attrs, 'lines-covered') ?? 0;

    for (const methodMatch of body.matchAll(/<method\b([^>]*?)(?:\/>|>([\s\S]*?)<\/method>)/g)) {
      const methodAttrs = methodMatch[1] ?? '';
      const name = attr(methodAttrs, 'name');
      if (!name) {
        continue;
      }
      const methodLines = new Map<number, number>();
      for (const lineMatch of (methodMatch[2] ?? '').matchAll(/<line\b([^>]*?)\/?>/g)) {
        const number = intAttr(lineMatch[1], 'number');
        if (number !== null) {
          methodLines.set(number, intAttr(lineMatch[1], 'hits') ?? 0);
        }
      }
      const linesFound = methodLines.size;
      const linesHit = [...methodLines.values()].filter((hits) => hits > 0).length;
      let lineCoverage = percent(linesHit, linesFound);
      if (lineCoverage === null) {
        const rate = floatAttr(methodAttrs, 'line-rate');
        if (rate !== null) {
          lineCoverage = round1(rate * 100);
        }
      }
      const firstLine = methodLines.size > 0 ? Math.min(...methodLines.keys()) : intAttr(methodAttrs, 'line') ?? 0;
      entry.functions.push({ name, line: firstLine, linesFound, linesHit, lineCoverage, hits: null });
    }
  }

  const files: ParsedFileCoverage[] = [...byFile.values()].map((entry) => {
    let linesFound = entry.lineHits.size;
    let linesHit = [...entry.lineHits.values()].filter((hits) => hits > 0).length;
    if (linesFound === 0 && entry.attrFound > 0) {
      linesFound = entry.attrFound;
      linesHit = entry.attrHit;
    }
    const functions = entry.functions.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
    return {
      rawPath: entry.rawPath,
      linesFound,
      linesHit,
      lineCoverage: percent(linesHit, linesFound),
      functions,
      functionsFound: functions.length,
      functionsHit: functions.filter((fn) => (fn.lineCoverage ?? 0) > 0 || (fn.linesHit > 0)).length,
    };
  });

  files.sort((a, b) => a.rawPath.localeCompare(b.rawPath));
  return { format: 'cobertura', files };
}

/**
 * Parse a JaCoCo XML.
 *
 * A file is `package/sourcefile`. `sourcefile` lines give the file's coverage; `<method>`
 * blocks under the matching `<class>` give per-function line counters. Multi-module
 * `<group>` output is read the same way, since the package scan finds nested packages.
 */
export function parseJacoco(content: string): ParsedCoverageReport {
  interface Accumulator {
    rawPath: string;
    lineHits: Map<number, number>;
    functions: MeasuredFunctionCoverage[];
    fallbackFound: number;
    fallbackHit: number;
  }

  const byFile = new Map<string, Accumulator>();
  const ensure = (rawPath: string): Accumulator => {
    const existing = byFile.get(rawPath);
    if (existing) {
      return existing;
    }
    const created: Accumulator = { rawPath, lineHits: new Map(), functions: [], fallbackFound: 0, fallbackHit: 0 };
    byFile.set(rawPath, created);
    return created;
  };

  for (const pkg of content.matchAll(/<package\b([^>]*?)>([\s\S]*?)<\/package>/g)) {
    const packageName = attr(pkg[1] ?? '', 'name') ?? '';
    const packageBody = pkg[2] ?? '';

    for (const source of packageBody.matchAll(/<sourcefile\b([^>]*?)>([\s\S]*?)<\/sourcefile>/g)) {
      const name = attr(source[1] ?? '', 'name');
      if (!name) {
        continue;
      }
      const entry = ensure(packageName ? `${packageName}/${name}` : name);
      for (const lineMatch of (source[2] ?? '').matchAll(/<line\b([^>]*?)\/?>/g)) {
        const number = intAttr(lineMatch[1], 'nr');
        if (number !== null) {
          entry.lineHits.set(number, Math.max(entry.lineHits.get(number) ?? 0, intAttr(lineMatch[1], 'ci') ?? 0));
        }
      }
    }

    for (const cls of packageBody.matchAll(/<class\b([^>]*?)>([\s\S]*?)<\/class>/g)) {
      const sourceName = attr(cls[1] ?? '', 'sourcefilename');
      if (!sourceName) {
        continue;
      }
      const entry = ensure(packageName ? `${packageName}/${sourceName}` : sourceName);
      const classBody = cls[2] ?? '';
      const bodyWithoutMethods = classBody.replace(/<method\b[\s\S]*?<\/method>/g, '');
      for (const counter of bodyWithoutMethods.matchAll(/<counter\b([^>]*?)\/?>/g)) {
        if (attr(counter[1] ?? '', 'type') === 'LINE') {
          entry.fallbackFound += (intAttr(counter[1], 'missed') ?? 0) + (intAttr(counter[1], 'covered') ?? 0);
          entry.fallbackHit += intAttr(counter[1], 'covered') ?? 0;
        }
      }
      for (const method of classBody.matchAll(/<method\b([^>]*?)>([\s\S]*?)<\/method>/g)) {
        const name = attr(method[1] ?? '', 'name');
        if (!name) {
          continue;
        }
        let covered: number | null = null;
        let missed: number | null = null;
        for (const counter of (method[2] ?? '').matchAll(/<counter\b([^>]*?)\/?>/g)) {
          if (attr(counter[1] ?? '', 'type') === 'LINE') {
            covered = intAttr(counter[1], 'covered');
            missed = intAttr(counter[1], 'missed');
          }
        }
        const recorded = covered !== null || missed !== null;
        const linesHit = covered ?? 0;
        const linesFound = recorded ? linesHit + (missed ?? 0) : 0;
        entry.functions.push({
          name,
          line: intAttr(method[1], 'line') ?? 0,
          linesFound,
          linesHit,
          lineCoverage: recorded ? percent(linesHit, linesFound) : null,
          hits: null,
        });
      }
    }
  }

  const files: ParsedFileCoverage[] = [...byFile.values()].map((entry) => {
    let linesFound = entry.lineHits.size;
    let linesHit = [...entry.lineHits.values()].filter((hits) => hits > 0).length;
    if (linesFound === 0 && entry.fallbackFound > 0) {
      linesFound = entry.fallbackFound;
      linesHit = entry.fallbackHit;
    }
    const functions = entry.functions.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
    return {
      rawPath: entry.rawPath,
      linesFound,
      linesHit,
      lineCoverage: percent(linesHit, linesFound),
      functions,
      functionsFound: functions.length,
      functionsHit: functions.filter((fn) => (fn.lineCoverage ?? 0) > 0 || fn.linesHit > 0).length,
    };
  });

  files.sort((a, b) => a.rawPath.localeCompare(b.rawPath));
  return { format: 'jacoco', files };
}

/**
 * The coverage figure for one file from a measured report, or null when the report does not
 * name it. A named file with no line counts returns a measured figure whose `value` is null
 * and whose detail says so, so the caller never turns "unrecorded" into 0%.
 */
export interface FileCoverageFigure {
  basis: 'measured' | 'reachable';
  value: number | null;
  detail: string;
  reportModified: string | null;
  reportAgeMs: number | null;
  stale: boolean | null;
}

export function measuredFileFigure(
  report: MeasuredCoverageSummary,
  file: string,
): FileCoverageFigure | null {
  if (!report.available) {
    return null;
  }
  const entry = report.files.find((candidate) => candidate.inGraph && candidate.file === file);
  if (!entry) {
    return null;
  }
  const age = ageDetail(report.reportModified, report.reportAgeMs);
  const stale = entry.stale ? ' · stale' : '';
  if (entry.lineCoverage === null) {
    return {
      basis: 'measured',
      value: null,
      detail: `measured: the report records no line counts for this file${age}${stale}`,
      reportModified: report.reportModified,
      reportAgeMs: report.reportAgeMs,
      stale: entry.stale,
    };
  }
  return {
    basis: 'measured',
    value: entry.lineCoverage,
    detail: `measured ${entry.lineCoverage}% of ${entry.linesFound} line(s)${age}${stale}`,
    reportModified: report.reportModified,
    reportAgeMs: report.reportAgeMs,
    stale: entry.stale,
  };
}

/** The provenance a route or axis carries, without the whole per-file list. */
export function coverageProvenance(report: MeasuredCoverageSummary): CoverageProvenance {
  return {
    available: report.available,
    basis: report.basis,
    format: report.format,
    reportPath: report.reportPath,
    reportModified: report.reportModified,
    reportAgeMs: report.reportAgeMs,
    ...(report.reason ? { reason: report.reason } : {}),
    ...(report.detail ? { detail: report.detail } : {}),
    outOfGraph: report.outOfGraph,
    stale: report.stale,
    summary: report.summary,
  };
}

/** Read and map the measured coverage for a repository, bounded by the scan ceiling. */
export async function computeMeasuredCoverage(
  root: string,
  graph: Graph,
  options: MeasuredCoverageOptions = {},
): Promise<MeasuredCoverageSummary> {
  const ceiling = path.resolve(options.ceiling ?? root);
  const now = options.now ?? Date.now;
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const candidates = candidateReportPaths(root, ceiling, options.reportPaths);

  const skipped: Array<{ path: string; reason: string }> = [];
  let chosen: { reportFile: string; parsed: ParsedCoverageReport } | null = null;

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const content = options.readReport ? options.readReport(candidate) : readReportFile(candidate);
    if (content === null) {
      skipped.push({ path: toPosix(path.relative(root, candidate)), reason: 'unreadable' });
      continue;
    }
    const parsed = parseCoverageText(content, candidate);
    if (!parsed || parsed.files.length === 0) {
      skipped.push({ path: toPosix(path.relative(root, candidate)), reason: 'malformed' });
      continue;
    }
    chosen = { reportFile: candidate, parsed };
    break;
  }

  if (!chosen) {
    const found = candidates.some((candidate) => fs.existsSync(candidate));
    const malformed = skipped.some((entry) => entry.reason === 'malformed');
    return emptySummary(
      malformed ? 'report-malformed' : found ? 'report-unreadable' : 'no-report-found',
      skipped,
    );
  }

  const reportModified = options.modifiedAt
    ? options.modifiedAt(chosen.reportFile)
    : reportModifiedAt(chosen.reportFile);

  const files: MeasuredFileCoverage[] = chosen.parsed.files
    .map((entry) => {
      const mapped = mapReportPath(root, entry.rawPath);
      return {
        ...entry,
        file: mapped,
        inGraph: nodeIds.has(mapped),
        lastCommit: null,
        stale: null,
      };
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.rawPath.localeCompare(b.rawPath));

  const selected = options.files ? new Set(options.files) : null;
  const cap = options.maxStalenessFiles ?? 200;
  const head = options.lastCommitAt ? null : await gitHead(root);
  let assessed = 0;
  for (const entry of files) {
    if (!entry.inGraph || (selected && !selected.has(entry.file))) {
      continue;
    }
    if (assessed >= cap) {
      break;
    }
    assessed += 1;
    const lastCommit = options.lastCommitAt
      ? await options.lastCommitAt(entry.file)
      : await lastCommitAt(root, head, entry.file);
    entry.lastCommit = lastCommit;
    entry.stale =
      reportModified && lastCommit
        ? Date.parse(reportModified) < Date.parse(lastCommit)
        : null;
  }

  const inGraph = files.filter((entry) => entry.inGraph);
  const summary = summarise(inGraph);
  const stale = files
    .filter((entry) => entry.stale === true)
    .map((entry) => entry.file)
    .sort();
  const outOfGraph = files
    .filter((entry) => !entry.inGraph)
    .map((entry) => entry.file)
    .sort();
  const detail =
    reportModified === null ? 'the report has no readable timestamp' : undefined;

  return {
    available: true,
    basis: 'measured',
    format: chosen.parsed.format,
    reportPath: toPosix(path.relative(root, chosen.reportFile)),
    reportModified,
    reportAgeMs: reportModified ? Math.max(0, now() - Date.parse(reportModified)) : null,
    ...(summary.linesFound === 0
      ? { reason: 'no-lines-recorded' as const, detail: 'the report records no line counts' }
      : detail
        ? { detail }
        : {}),
    skipped,
    outOfGraph,
    files,
    stale,
    summary,
  };
}

function emptySummary(
  reason: CoverageUnavailableReason,
  skipped: Array<{ path: string; reason: string }>,
): MeasuredCoverageSummary {
  const detail: Record<CoverageUnavailableReason, string> = {
    'no-report-found': 'no coverage report was found inside the scan ceiling',
    'report-unreadable': 'a coverage report was found but could not be read',
    'report-malformed': 'a coverage report was found but could not be parsed',
    'no-lines-recorded': 'the report records no line counts',
  };
  return {
    available: false,
    basis: 'reachable',
    format: null,
    reportPath: null,
    reportModified: null,
    reportAgeMs: null,
    reason,
    detail: detail[reason],
    skipped,
    outOfGraph: [],
    files: [],
    stale: [],
    summary: { filesMeasured: 0, linesFound: 0, linesHit: 0, lineCoverage: null },
  };
}

function candidateReportPaths(
  root: string,
  ceiling: string,
  explicit: readonly string[] | undefined,
): string[] {
  const list = explicit && explicit.length > 0 ? explicit : DEFAULT_COVERAGE_REPORT_PATHS;
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const absolute = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(root, trimmed);
    // A report outside the ceiling is never read, even when configured explicitly.
    if (!isInside(absolute, ceiling) || seen.has(absolute)) {
      continue;
    }
    seen.add(absolute);
    resolved.push(absolute);
  }
  return resolved;
}

/**
 * Map a report path onto a repository-relative POSIX path.
 *
 * A relative path (the common CI case) is used as written. An absolute path under `root`
 * is made relative; one outside is kept literally so the caller can report it rather than
 * silently dropping it. Nothing is resolved against a filename that is not in the report.
 */
function mapReportPath(root: string, rawPath: string): string {
  const normalised = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!path.isAbsolute(normalised)) {
    return normalised;
  }
  const relative = toPosix(path.relative(path.resolve(root), path.resolve(normalised)));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return normalised;
  }
  return relative;
}

function readReportFile(absolutePath: string): string | null {
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) {
      return null;
    }
    return fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }
}

function reportModifiedAt(absolutePath: string): string | null {
  try {
    return fs.statSync(absolutePath).mtime.toISOString();
  } catch {
    return null;
  }
}

/**
 * Bound the per-file read. The existing history window (`history.ts`, 90 days / 2000
 * commits) is one pass over the whole repository and does not carry a per-file last-commit
 * date, so the date is read directly here — but only for the files the report names, one
 * `git log -1` each, capped by the caller and cached by HEAD plus path.
 */
async function gitHead(root: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: root });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function lastCommitAt(root: string, head: string | null, file: string): Promise<string | null> {
  if (head === null) {
    return null;
  }
  const key = `${head}\u0000${file}`;
  if (lastCommitCache.has(key)) {
    return lastCommitCache.get(key) ?? null;
  }
  let value: string | null = null;
  try {
    const { stdout } = await run('git', ['log', '-1', '--format=%cI', '--', file], { cwd: root });
    value = stdout.trim() || null;
  } catch {
    value = null;
  }
  lastCommitCache.set(key, value);
  while (lastCommitCache.size > LAST_COMMIT_CACHE_LIMIT) {
    const oldest = lastCommitCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    lastCommitCache.delete(oldest);
  }
  return value;
}

function summarise(files: readonly MeasuredFileCoverage[]): MeasuredSummary {
  let linesFound = 0;
  let linesHit = 0;
  for (const entry of files) {
    linesFound += entry.linesFound;
    linesHit += entry.linesHit;
  }
  return {
    filesMeasured: files.length,
    linesFound,
    linesHit,
    lineCoverage: percent(linesHit, linesFound),
  };
}

/** A 0-100 percentage rounded to one decimal, or null when there is nothing to divide. */
export function percent(hit: number, found: number): number | null {
  if (found <= 0) {
    return null;
  }
  return Math.round((hit / found) * 1000) / 10;
}

function ageDetail(reportModified: string | null, reportAgeMs: number | null): string {
  if (reportModified === null || reportAgeMs === null) {
    return '';
  }
  return ` · report ${formatAge(reportAgeMs)} old`;
}

/** A compact age: minutes, hours, or days, for a caption next to a figure. */
export function formatAge(ageMs: number): string {
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function intOr(value: string, fallback: number): number {
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function intAttr(attrs: string | undefined, name: string): number | null {
  const value = attr(attrs ?? '', name);
  if (value === null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function floatAttr(attrs: string | undefined, name: string): number | null {
  const value = attr(attrs ?? '', name);
  if (value === null) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function attr(attrs: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return match?.[1] ?? null;
}
