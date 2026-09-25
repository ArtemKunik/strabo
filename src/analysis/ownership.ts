import type { Graph } from '../types.ts';
import { computeGraphMetrics } from './analysis.ts';
import { run } from '../process.ts';

export interface FileAuthorHistory {
  file: string;
  authors: string[];
  commits: number;
}

export interface OwnershipContext {
  file: string;
  distinctAuthors: number;
  commits: number;
  transitiveDependents: number;
}

/** Read Git authorship per file. */
export async function getFileAuthorHistory(
  root: string,
  files: readonly string[],
): Promise<FileAuthorHistory[]> {
  const results: FileAuthorHistory[] = [];
  for (const file of files) {
    try {
      const { stdout } = await run('git', ['log', '--format=%an', '--', file], {
        cwd: root,
        maxBuffer: 4 * 1024 * 1024,
      });
      const authors = [...new Set(stdout.split('\n').map((line) => line.trim()).filter(Boolean))];
      results.push({ file, authors, commits: stdout.split('\n').filter(Boolean).length });
    } catch {
      results.push({ file, authors: [], commits: 0 });
    }
  }
  return results;
}

/**
 * Combine authorship with dependency reach.
 *
 * History-based signals, not assigned ownership or a people-performance rating.
 */
export function computeOwnership(history: FileAuthorHistory[], graph: Graph): OwnershipContext[] {
  const metrics = computeGraphMetrics(graph);
  return history
    .map((entry) => ({
      file: entry.file,
      distinctAuthors: entry.authors.length,
      commits: entry.commits,
      transitiveDependents: metrics.transitiveDependents.get(entry.file) ?? 0,
    }))
    .sort((a, b) => b.transitiveDependents - a.transitiveDependents || a.file.localeCompare(b.file));
}
