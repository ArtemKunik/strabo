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

let queue: Promise<unknown> = Promise.resolve();

/**
 * Serialise tree-sitter work so the process-global parser state is never mutated concurrently.
 *
 * Every scan that parses (polyglot resolution, the JS/TS call graph) chains onto this one
 * queue, so two scans of different repositories cannot interleave parser calls. A rejected
 * task does not poison the queue: the next work item starts from a resolved promise.
 */
export function serializeParserWork<T>(work: () => Promise<T>): Promise<T> {
  const task = queue.then(work);
  queue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

/**
 * Serialise polyglot scans so shared parser state is never mutated concurrently.
 *
 * Errors are re-thrown to the caller while the shared queue stays usable for later work.
 */
export function scanPolyglotEdges(
  files: readonly string[],
  contentByFile?: ReadonlyMap<string, string>,
): Promise<PolyglotResult> {
  return serializeParserWork(() => extractAndResolve(files, contentByFile));
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
