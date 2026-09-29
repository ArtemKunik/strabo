import type { Graph } from '../types.ts';
import { buildAdjacency } from './analysis.ts';
import { computeTestReachByFile } from './coverage.ts';
import { parentDirectory } from './directory.ts';
import {
  fileCoverage,
  isUntested,
  summariseFileCoverage,
  UNDER_COVERED_THRESHOLD,
  type FileCoverage,
} from './file-coverage.ts';
import {
  coverageProvenance,
  type CoverageProvenance,
  type MeasuredCoverageSummary,
} from './measured-coverage.ts';

/**
 * Coverage at the three scopes a caller asks about: the whole project, one folder and its
 * subtree, or one file.
 *
 * Every figure is read from the same {@link fileCoverage} map the map and the passports read,
 * so a file cannot be `measured` in one place and `reachable` in another. A file the report
 * does not name is counted as `notInReport`, never as 0%; a folder roll-up sums only the
 * files it holds, and an empty folder reports a null percent rather than a zero.
 */

export type CoverageScope = 'project' | 'folder' | 'file';

/** One file's coverage row, as a folder listing or file detail returns it. */
export interface CoverageFileEntry {
  file: string;
  basis: 'measured' | 'reachable';
  /** Measured line coverage, 0-100; null on the reachable basis or when unrecorded. */
  value: number | null;
  linesHit: number | null;
  linesFound: number | null;
  /** Whether a test reaches this file over recorded edges. */
  reached: boolean;
  /** True when a report was read but does not name this file. */
  notInReport: boolean;
  /** True when the report predates this file's last commit; null when not assessed. */
  stale: boolean | null;
  /** Whether the file is untested for a consumer at the chosen threshold. */
  untested: boolean;
  /** U3: Reachability depth from the closest test (0 for test, 1 for direct, 2+ for transitive, null if unreached). */
  reachDepth?: number | null;
  /** U3: True when directly imported by at least one test. */
  reachDirect?: boolean;
  /** U3: Shortest path from a test to this file. */
  reachPath?: string[] | null;
  /** Tests whose forward closure reaches this file: the tests to run. File scope only. */
  tests?: string[];
  /**
   * Tests the report attributes a covered line to (U6), from LCOV `TN:` blocks or coverage.py
   * contexts. File scope only, and present only when the report recorded per-test data; the
   * `tests` reachability list is the fallback and is always labelled as such.
   */
  coveringTests?: string[];
  /** Files that import this file. File scope only. */
  importers?: string[];
}

/** One folder's roll-up over its whole subtree. */
export interface CoverageFolderEntry {
  /** Repository-relative folder path, or `.` for the root. */
  folder: string;
  files: number;
  filesMeasured: number;
  notInReport: number;
  reached: number;
  untested: number;
  linesHit: number;
  linesFound: number;
  value: number | null;
  basis: 'measured' | 'reachable';
}

/** The summed figures at one scope, with the basis that decided `untested`. */
export interface CoverageTotals {
  files: number;
  filesMeasured: number;
  notInReport: number;
  reached: number;
  untested: number;
  linesHit: number;
  linesFound: number;
  value: number | null;
  basis: 'measured' | 'reachable';
}

/** A coverage answer at one scope: totals, provenance, and the rows that scope lists. */
export interface CoverageReport {
  scope: CoverageScope;
  /** `.` for the project, the folder path, or the file path. */
  subject: string;
  /** The measured threshold below which a used file is untested. */
  threshold: number;
  totals: CoverageTotals;
  provenance: CoverageProvenance;
  /** Child folders of the subject, sorted by path. Project and folder scope. */
  folders?: CoverageFolderEntry[];
  /** Files directly in the subject folder, sorted by path. Folder scope. */
  files?: CoverageFileEntry[];
  /** The file's own row plus the tests and importers behind it. File scope. */
  file?: CoverageFileEntry;
}

/** The repository root as a folder subject. */
export const ROOT_FOLDER = '.';

/** Build the measured-or-reachable provenance for a summary that may be absent. */
function provenanceOf(measured: MeasuredCoverageSummary | null | undefined): CoverageProvenance {
  if (measured) {
    return coverageProvenance(measured);
  }
  return {
    available: false,
    basis: 'reachable',
    format: null,
    reportPath: null,
    reportModified: null,
    reportAgeMs: null,
    reason: 'no-report-found',
    detail: 'no coverage report was found inside the scan ceiling',
    outOfGraph: [],
    stale: [],
    summary: { filesMeasured: 0, linesFound: 0, linesHit: 0, lineCoverage: null },
  };
}

/** Whether a measured report is the basis this run reads. */
function basisOf(measured: MeasuredCoverageSummary | null | undefined): 'measured' | 'reachable' {
  return measured?.available ? 'measured' : 'reachable';
}

function entryOf(file: string, figure: FileCoverage, basis: 'measured' | 'reachable', threshold: number): CoverageFileEntry {
  return {
    file,
    basis: figure.basis,
    value: figure.value,
    linesHit: figure.linesHit,
    linesFound: figure.linesFound,
    reached: figure.reached,
    notInReport: figure.notInReport,
    stale: figure.stale,
    untested: isUntested(figure, basis, threshold),
    reachDepth: figure.reachDepth,
    reachDirect: figure.reachDirect,
    reachPath: figure.reachPath,
  };
}

/** Sum one figure per file into totals, keeping `not in report` apart from 0%. */
function totalsOf(
  files: readonly string[],
  coverage: ReadonlyMap<string, FileCoverage>,
  basis: 'measured' | 'reachable',
  threshold: number,
): CoverageTotals {
  const aggregate = summariseFileCoverage(files, coverage);
  let reached = 0;
  let untested = 0;
  for (const file of files) {
    const figure = coverage.get(file);
    if (!figure) {
      continue;
    }
    if (figure.reached) {
      reached += 1;
    }
    if (isUntested(figure, basis, threshold)) {
      untested += 1;
    }
  }
  return {
    files: aggregate.files,
    filesMeasured: aggregate.filesMeasured,
    notInReport: aggregate.notInReport,
    reached,
    untested,
    linesHit: aggregate.linesHit,
    linesFound: aggregate.linesFound,
    value: aggregate.value,
    basis: aggregate.basis,
  };
}

/** Every graph file whose id sits at or below `folder`. */
function filesInFolder(graph: Graph, folder: string): string[] {
  if (folder === ROOT_FOLDER || folder === '') {
    return graph.nodes.map((node) => node.id);
  }
  const prefix = `${folder}/`;
  return graph.nodes
    .filter((node) => node.id === folder || node.id.startsWith(prefix))
    .map((node) => node.id);
}

/**
 * The immediate child folder of `folder` that holds `file`, or null when the file sits
 * directly in `folder` (or outside it).
 */
function childFolderOf(folder: string, file: string): string | null {
  let relative: string;
  if (folder === ROOT_FOLDER || folder === '') {
    relative = file;
  } else if (file.startsWith(`${folder}/`)) {
    relative = file.slice(folder.length + 1);
  } else {
    return null;
  }
  const slash = relative.indexOf('/');
  if (slash === -1) {
    return null;
  }
  const segment = relative.slice(0, slash);
  return folder === ROOT_FOLDER || folder === '' ? segment : `${folder}/${segment}`;
}

/** Group files by their immediate child folder of `folder`, preserving order. */
function rollupByChildFolder(
  files: readonly string[],
  coverage: ReadonlyMap<string, FileCoverage>,
  folder: string,
  basis: 'measured' | 'reachable',
  threshold: number,
): CoverageFolderEntry[] {
  const children = new Map<string, string[]>();
  for (const file of files) {
    const child = childFolderOf(folder, file);
    if (child === null) {
      continue;
    }
    const list = children.get(child);
    if (list) {
      list.push(file);
    } else {
      children.set(child, [file]);
    }
  }
  return [...children.entries()]
    .map(([child, members]) => ({ folder: child, ...totalsOf(members, coverage, basis, threshold) }))
    .sort((a, b) => a.folder.localeCompare(b.folder));
}

/** The project-wide coverage report, broken down by top-level folder. */
export function projectCoverageReport(
  graph: Graph,
  measured: MeasuredCoverageSummary | null | undefined,
  threshold: number = UNDER_COVERED_THRESHOLD,
): CoverageReport {
  const coverage = fileCoverage(graph, measured ?? null);
  const basis = basisOf(measured);
  const files = graph.nodes.map((node) => node.id);
  return {
    scope: 'project',
    subject: ROOT_FOLDER,
    threshold,
    totals: totalsOf(files, coverage, basis, threshold),
    provenance: provenanceOf(measured),
    folders: rollupByChildFolder(files, coverage, ROOT_FOLDER, basis, threshold),
  };
}

/** The coverage report for one folder and its subtree, with child folders and direct files. */
export function folderCoverageReport(
  graph: Graph,
  measured: MeasuredCoverageSummary | null | undefined,
  folder: string,
  threshold: number = UNDER_COVERED_THRESHOLD,
): CoverageReport {
  const subject = normaliseFolder(folder);
  const coverage = fileCoverage(graph, measured ?? null);
  const basis = basisOf(measured);
  const files = filesInFolder(graph, subject);
  const direct = files
    .filter((file) => parentDirectory(file) === subject)
    .sort()
    .map((file) => entryOf(file, coverage.get(file) as FileCoverage, basis, threshold));
  return {
    scope: 'folder',
    subject,
    threshold,
    totals: totalsOf(files, coverage, basis, threshold),
    provenance: provenanceOf(measured),
    folders: rollupByChildFolder(files, coverage, subject, basis, threshold),
    files: direct,
  };
}

/** The coverage report for one file, with the tests that reach it and its importers. */
export function fileCoverageReport(
  graph: Graph,
  measured: MeasuredCoverageSummary | null | undefined,
  file: string,
  threshold: number = UNDER_COVERED_THRESHOLD,
): CoverageReport | null {
  const coverage = fileCoverage(graph, measured ?? null);
  const figure = coverage.get(file);
  if (!figure) {
    return null;
  }
  const basis = basisOf(measured);
  const tests = computeTestReachByFile(graph).get(file) ?? [];
  const importers = [...(buildAdjacency(graph).backward.get(file) ?? [])].sort();
  // Per-test attribution (U6) when the report records it; absent means the format could not
  // say, so the reachability `tests` list stands as the labelled fallback.
  const coveringTests = (measured?.files ?? []).find((measuredFile) => measuredFile.file === file)?.coveringTests;
  return {
    scope: 'file',
    subject: file,
    threshold,
    totals: totalsOf([file], coverage, basis, threshold),
    provenance: provenanceOf(measured),
    file: {
      ...entryOf(file, figure, basis, threshold),
      tests,
      importers,
      ...(coveringTests && coveringTests.length > 0 ? { coveringTests } : {}),
    },
  };
}

/** `./src/`, `src//`, and `/` normalise to `src` and the root; separators are dropped. */
export function normaliseFolder(folder: string): string {
  const trimmed = folder
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  return trimmed === '' ? ROOT_FOLDER : trimmed;
}
