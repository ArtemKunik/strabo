import type { FunctionsReport } from './functions.ts';
import type { MeasuredFunctionCoverage } from './measured-coverage.ts';
import type { FunctionSignal } from './signals.ts';

/** One function that tripped at least one recorded signal. */
export interface Hotspot {
  file: string;
  owner: string;
  name: string;
  line: number;
  decisionPoints: number;
  lines: number;
  signals: FunctionSignal[];
  /** Measured coverage when a report names the function; absent means unavailable. */
  coverage?: MeasuredFunctionCoverage;
}

export interface HotspotReport {
  available: true;
  /** Files whose functions were extracted. */
  filesScanned: number;
  /** Candidate files skipped: no extractor, or unreadable. */
  filesSkipped: number;
  functionsExamined: number;
  hotspots: Hotspot[];
}

export interface HotspotOptions {
  limit?: number;
  filesScanned?: number;
  filesSkipped?: number;
}

/**
 * Rank functions by how many signals they tripped, then by complexity and size.
 *
 * Only functions with at least one recorded signal become hotspots. Ordering is fully
 * deterministic (file and line break ties), so a repeated analysis is identical.
 */
export function rankHotspots(reports: FunctionsReport[], options: HotspotOptions = {}): HotspotReport {
  const limit = options.limit ?? 50;
  const hotspots: Hotspot[] = [];
  let functionsExamined = 0;

  for (const report of reports) {
    for (const entry of report.functions) {
      functionsExamined += 1;
      if (entry.signals.length === 0) {
        continue;
      }
      hotspots.push({
        file: report.file,
        owner: entry.owner,
        name: entry.name,
        line: entry.line,
        decisionPoints: entry.metrics?.decisionPoints ?? 0,
        lines: entry.metrics?.lines ?? 0,
        signals: entry.signals,
        ...(entry.coverage ? { coverage: entry.coverage } : {}),
      });
    }
  }

  hotspots.sort(
    (a, b) =>
      b.signals.length - a.signals.length ||
      b.decisionPoints - a.decisionPoints ||
      b.lines - a.lines ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );

  return {
    available: true,
    filesScanned: options.filesScanned ?? reports.length,
    filesSkipped: options.filesSkipped ?? 0,
    functionsExamined,
    hotspots: hotspots.slice(0, limit),
  };
}
