import type { Diagnostic, GraphEdge } from '../types.ts';
import {
  POLYGLOT_RESOLVERS,
  isResolvedPolyglotLanguage,
  polyglotLanguageOf,
  type PolyglotLanguage,
} from './languages/resolvers.ts';

export type { PolyglotLanguage } from './languages/resolvers.ts';

export interface PolyglotResult {
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

const emptyResult: PolyglotResult = { edges: [], diagnostics: [] };

let queue: Promise<PolyglotResult> = Promise.resolve(emptyResult);

/**
 * Serialise polyglot scans so shared parser state is never mutated concurrently.
 *
 * Parser runtime state is process-global, so scans run one at a time through this queue.
 * Errors are re-thrown after the queue resets so callers are not left with silently empty results.
 */
export function scanPolyglotEdges(
  files: readonly string[],
  contentByFile?: ReadonlyMap<string, string>,
): Promise<PolyglotResult> {
  const task = queue.then(() => extractAndResolve(files, contentByFile));
  queue = task.then(
    (result) => result,
    (error) => { queue = Promise.resolve(emptyResult); throw error; },
  );
  return task;
}

async function extractAndResolve(
  files: readonly string[],
  contentByFile?: ReadonlyMap<string, string>,
): Promise<PolyglotResult> {
  const byLanguage = groupByLanguage(files);
  const diagnostics: Diagnostic[] = [];
  const edges: GraphEdge[] = [];

  for (const resolver of POLYGLOT_RESOLVERS) {
    const languageFiles = byLanguage.get(resolver.language) ?? [];
    if (languageFiles.length === 0) {
      continue;
    }
    const result = await resolver.resolve(languageFiles, contentByFile, diagnostics);
    edges.push(...result.edges);
    diagnostics.push(...result.diagnostics);
  }

  for (const [language, languageFiles] of byLanguage) {
    if (isResolvedPolyglotLanguage(language)) {
      continue;
    }
    for (const file of languageFiles) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'info',
        kind: 'unsupported',
        message: `${language} resolution is not implemented yet; no edges were derived from this file.`,
      });
    }
  }

  return { edges, diagnostics };
}

function groupByLanguage(files: readonly string[]): Map<PolyglotLanguage, string[]> {
  const grouped = new Map<PolyglotLanguage, string[]>();
  for (const file of files) {
    const language = languageOf(file);
    if (!language) {
      continue;
    }
    const list = grouped.get(language);
    if (list) {
      list.push(file);
    } else {
      grouped.set(language, [file]);
    }
  }
  return grouped;
}

export function isPolyglotSource(file: string): boolean {
  return polyglotLanguageOf(file) !== undefined;
}

export function languageOf(file: string): PolyglotLanguage | undefined {
  return polyglotLanguageOf(file);
}
