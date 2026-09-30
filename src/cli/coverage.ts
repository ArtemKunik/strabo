import fs from 'node:fs';
import path from 'node:path';

import { resolveRepositoryRoot } from '../boundary/repository-root.ts';
import { getCachedGraph } from '../scan/graph.ts';
import { readEnv } from '../config.ts';
import {
  computeMeasuredCoverage,
  formatAge,
  type MeasuredCoverageSummary,
} from '../analysis/measured-coverage.ts';
import { refreshCoverage } from '../analysis/coverage-refresh.ts';
import {
  fileCoverageReport,
  folderCoverageReport,
  normaliseFolder,
  projectCoverageReport,
  type CoverageFileEntry,
  type CoverageFolderEntry,
  type CoverageReport,
  type CoverageTotals,
} from '../analysis/coverage-report.ts';
import { UNDER_COVERED_THRESHOLD } from '../analysis/file-coverage.ts';

export interface CoverageIo {
  write?: (text: string) => void;
  writeError?: (text: string) => void;
}

/**
 * `strabo coverage [path]` — the repository's recorded test coverage at the scope the caller
 * names: the whole project (default), one folder with `--folder`, or one file with `--file`.
 *
 * The report is read from disk; no test or coverage tool is run. Measured figures come first
 * and static test reach is the labelled fallback, and a file the report does not name is
 * reported as not-in-report rather than as 0%.
 */
export async function runCoverageCommand(
  argv: readonly string[],
  io: CoverageIo = {},
): Promise<number> {
  const write = io.write ?? ((text: string) => void process.stdout.write(text));
  const writeError = io.writeError ?? ((text: string) => void process.stderr.write(text));

  const env = readEnv(process.env, argv);
  const file = flagValue(argv, 'file');
  const folder = flagValue(argv, 'folder');
  if (file && folder) {
    writeError('strabo coverage: pass either --file or --folder, not both.\n');
    return 2;
  }
  const threshold = numberFlag(argv, 'threshold');
  if (threshold !== undefined && (threshold < 0 || threshold > 100)) {
    writeError('strabo coverage: --threshold must be between 0 and 100.\n');
    return 2;
  }
  const effectiveThreshold = threshold ?? UNDER_COVERED_THRESHOLD;

  const repository = resolveRepositoryRoot({
    workspaceRoot: env.root,
    scanCeiling: env.scanCeiling,
    requested: flagValue(argv, 'repository'),
  });
  const cached = await getCachedGraph(repository.root);
  const graph = cached.report.graph;
  const coverageOptions = {
    ceiling: env.scanCeiling,
    ...(env.coverageReports ? { reportPaths: env.coverageReports } : {}),
    ...(file ? { files: [file] } : {}),
  };
  let measured = await computeMeasuredCoverage(repository.root, graph, coverageOptions);

  // An explicit `--refresh` runs the repository's own coverage script first, then re-reads.
  // The CLI is the operator's own terminal, so this is not gated the way the server route is.
  if (hasFlag(argv, 'refresh')) {
    const result = await refreshCoverage(repository.root);
    if (result.ok) {
      writeError(`strabo coverage: ran ${result.command}\n`);
    } else {
      writeError(`strabo coverage: ${result.detail ?? 'the coverage command did not succeed'}\n`);
    }
    // A suite that fails still usually writes the report, so read it back regardless and only
    // fail when the command produced nothing to read.
    measured = await computeMeasuredCoverage(repository.root, graph, coverageOptions);
    if (!result.ok && !measured.available) {
      return result.reason === 'no-script' || result.reason === 'no-manifest' ? 2 : 1;
    }
  }

  let report: CoverageReport | null;
  if (file) {
    report = fileCoverageReport(graph, measured, file, effectiveThreshold);
    if (!report) {
      writeError(`strabo coverage: "${file}" is not a scanned file in this repository.\n`);
      return 1;
    }
  } else if (folder) {
    report = folderCoverageReport(graph, measured, normaliseFolder(folder), effectiveThreshold);
  } else {
    report = projectCoverageReport(graph, measured, effectiveThreshold);
  }

  const body =
    flagValue(argv, 'format') === 'json'
      ? `${JSON.stringify({ repository: repository.name, ...report }, null, 2)}\n`
      : renderHuman(repository.name, report, measured, effectiveThreshold);

  const out = flagValue(argv, 'out');
  if (out) {
    const target = path.resolve(out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    writeError(`strabo coverage: wrote ${report.scope} coverage to ${target}\n`);
  } else {
    write(body);
  }
  return 0;
}

function renderHuman(
  repositoryName: string,
  report: CoverageReport,
  measured: MeasuredCoverageSummary,
  threshold: number,
): string {
  const lines: string[] = [];
  const scopeLabel = report.scope === 'project' ? 'project' : `${report.scope} ${report.subject}`;
  lines.push(`strabo coverage · ${repositoryName} · ${scopeLabel}`);
  lines.push(provenanceLine(measured));
  lines.push(totalsLine(report.totals, threshold));

  if (report.scope === 'file' && report.file) {
    lines.push('');
    lines.push(...fileLines(report.file));
  }

  if (report.folders && report.folders.length > 0) {
    lines.push('');
    lines.push(report.scope === 'project' ? 'folders:' : 'subfolders:');
    for (const entry of report.folders) {
      lines.push(folderLine(entry));
    }
  }

  if (report.files && report.files.length > 0) {
    lines.push('');
    lines.push('files:');
    for (const entry of report.files) {
      lines.push(fileLine(entry));
    }
  }

  return `${lines.join('\n')}\n`;
}

function provenanceLine(measured: MeasuredCoverageSummary): string {
  if (!measured.available) {
    return `basis reachable · ${measured.detail ?? measured.reason ?? 'no report'}`;
  }
  const age = measured.reportAgeMs === null ? '' : ` · report ${formatAge(measured.reportAgeMs)} old`;
  const stale = measured.stale.length > 0 ? ` · ${measured.stale.length} stale` : '';
  return `basis measured · ${measured.format ?? 'report'} ${measured.reportPath ?? ''}${age}${stale}`.trimEnd();
}

function totalsLine(totals: CoverageTotals, threshold: number): string {
  const percent = totals.value === null ? 'unavailable' : `${totals.value}%`;
  const untested =
    totals.basis === 'measured'
      ? `${totals.untested} under ${threshold}%`
      : `${totals.untested} unreached`;
  return `${totals.files} file(s) · ${totals.filesMeasured} measured · ${totals.notInReport} not in report · ${totals.reached} reached · ${untested} · ${totals.linesHit}/${totals.linesFound} lines ${percent}`;
}

function folderLine(entry: CoverageFolderEntry): string {
  const percent = entry.value === null ? 'unavailable' : `${entry.value}%`;
  const untested = entry.basis === 'measured' ? `${entry.untested} under` : `${entry.untested} unreached`;
  return `  ${entry.folder.padEnd(28)} ${percent.padStart(10)}  ${entry.files} file(s), ${entry.filesMeasured} measured, ${untested}`;
}

function fileLine(entry: CoverageFileEntry): string {
  const percent = entry.value === null ? (entry.notInReport ? 'not in report' : 'reachable') : `${entry.value}%`;
  const tags: string[] = [entry.basis];
  if (entry.untested) tags.push('untested');
  if (entry.stale) tags.push('stale');
  return `  ${entry.file.padEnd(48)} ${percent.padStart(12)}  ${tags.join(' · ')}`;
}

function fileLines(entry: CoverageFileEntry): string[] {
  const lines: string[] = [];
  const percent = entry.value === null ? (entry.notInReport ? 'not in report' : 'reachable') : `${entry.value}%`;
  lines.push(`file ${entry.file} · ${percent} · basis ${entry.basis}${entry.untested ? ' · untested' : ''}${entry.stale ? ' · stale' : ''}`);
  const tests = entry.tests ?? [];
  lines.push(tests.length > 0 ? `tests that reach it (${tests.length}): ${tests.join(', ')}` : 'no test reaches this file over recorded edges');
  const importers = entry.importers ?? [];
  lines.push(importers.length > 0 ? `imported by (${importers.length}): ${importers.join(', ')}` : 'nothing imports this file');
  return lines;
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length).trim();
      return value || undefined;
    }
    if (arg === `--${name}`) {
      const value = (argv[index + 1] ?? '').trim();
      return value.startsWith('-') || !value ? undefined : value;
    }
  }
  return undefined;
}

function numberFlag(argv: readonly string[], name: string): number | undefined {
  const parsed = Number.parseFloat(flagValue(argv, name) ?? '');
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A bare `--name` switch, or an `--name=value` form. */
function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}
