import type { Diagnostic, GraphEdge } from '../types.ts';
import { loadAliasTables, type AliasTables } from '../resolve/aliases.ts';
import { withParser } from './languages/parser-runtime.ts';
import { grammarFor } from './languages/typescript.ts';
import { collectFacts, isJavaScriptLike, type FileFacts } from './calls-facts.ts';
import { resolveCalls, resolveInheritance } from './calls-edges.ts';
import { serializeParserWork } from './scan-polyglot.ts';

export interface CallGraphResult {
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

export interface CallGraphOptions {
  /** Repository root for alias discovery; omit to keep purely relative resolution. */
  root?: string;
}

/**
 * Record cross-file function-call edges for JS/TS.
 *
 * Only calls Strabo can prove are recorded. A bare `foo()` where `foo` is a named or default
 * import from `./x`, and `ns.foo()` where `ns` is a namespace import, resolve to `x` when `x`
 * declares and exports that function. A value receiver (`obj.method()`), a dynamic call, a
 * re-exported name, and any receiver whose type is not known are left unclaimed rather than
 * guessed — the same contract as the import edges. A call edge always sits beside an import
 * edge for the same pair, so it adds evidence without changing reachability.
 *
 * Runs one tree-sitter parse per file, serialised with polyglot resolution through the shared
 * parser queue. A missing grammar degrades to no call edges instead of failing the scan.
 */
export function scanJsTsCalls(
  files: readonly string[],
  contentByFile: ReadonlyMap<string, string>,
  options: CallGraphOptions = {},
): Promise<CallGraphResult> {
  return serializeParserWork(() => extractAndResolve(files, contentByFile, options));
}

async function extractAndResolve(
  files: readonly string[],
  contentByFile: ReadonlyMap<string, string>,
  options: CallGraphOptions,
): Promise<CallGraphResult> {
  const candidates = files.filter(isJavaScriptLike).sort();
  if (candidates.length === 0) {
    return { edges: [], diagnostics: [] };
  }
  const fileSet = new Set(files);
  const tables: AliasTables | null = options.root ? loadAliasTables(options.root) : null;

  const facts = new Map<string, FileFacts>();
  try {
    for (const file of candidates) {
      const content = contentByFile.get(file);
      if (content === undefined) {
        continue;
      }
      const parsed = await withParser(grammarFor(file), (parser) => {
        const tree = parser.parse(content);
        if (!tree) {
          return null;
        }
        try {
          return collectFacts(tree.rootNode);
        } finally {
          tree.delete();
        }
      });
      if (parsed) {
        facts.set(file, parsed);
      }
    }
  } catch {
    // Call edges are additive evidence; a parser or grammar fault must not fail the scan.
    return { edges: [], diagnostics: [] };
  }

  return {
    edges: [...resolveCalls(facts, fileSet, tables), ...resolveInheritance(facts, fileSet, tables)],
    diagnostics: [],
  };
}
