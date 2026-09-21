import { extractCppSymbols } from './cpp.ts';
import { extractCSharpSymbols } from './csharp.ts';
import { extractJavaSymbols } from './java.ts';
import { extractKotlinSymbols } from './kotlin.ts';
import { extractPythonSymbols } from './python.ts';
import { extractRustSymbols } from './rust.ts';
import { extractSqlSymbols } from './sql.ts';
import { extractTypeScriptSymbols } from './typescript.ts';
import type { SymbolExtraction } from './symbols.ts';

/**
 * Sources the file being extracted provably depends on, keyed by repository-relative path.
 *
 * Only a language that splits one type across files needs this: C++ declares a class's
 * fields in a header and defines its methods in the implementation, so the implementation
 * alone cannot say what its own methods touch. The caller supplies the sources — taken from
 * the edges the scan already recorded — so the extractor never reads the filesystem, never
 * guesses a path, and never reaches outside the scan ceiling.
 */
export interface SymbolContext {
  related: ReadonlyMap<string, string>;
}

export interface SymbolExtractor {
  language: string;
  extract: (
    file: string,
    content: string,
    context?: SymbolContext,
  ) => Promise<SymbolExtraction>;
  /**
   * True when the language splits a type across files, so gathering `context.related` is
   * worth the reads. Languages that declare a type in one file leave it unset.
   */
  usesRelatedSources?: boolean;
  /**
   * `false` when the language has members but no methods that read or write them (SQL
   * columns), so there is no wiring to measure. Cohesion is then reported unavailable
   * instead of scoring every unconnected member as its own cluster.
   */
  tracksAccess?: boolean;
}

/**
 * Languages with a symbol extractor, keyed by extension.
 *
 * Extraction is on demand (per file) rather than part of every scan, because edges do not
 * need members. Callers use `symbolExtractorFor` and treat a null result as
 * `not-implemented`, never as "the file has no members".
 */
export const SYMBOL_EXTRACTORS: Record<string, SymbolExtractor> = {
  '.java': { language: 'java', extract: extractJavaSymbols },
  '.rs': { language: 'rust', extract: extractRustSymbols },
  '.cs': { language: 'csharp', extract: extractCSharpSymbols },
  '.kt': { language: 'kotlin', extract: extractKotlinSymbols },
  '.kts': { language: 'kotlin', extract: extractKotlinSymbols },
  '.ts': { language: 'typescript', extract: extractTypeScriptSymbols },
  '.tsx': { language: 'typescript', extract: extractTypeScriptSymbols },
  '.mts': { language: 'typescript', extract: extractTypeScriptSymbols },
  '.cts': { language: 'typescript', extract: extractTypeScriptSymbols },
  // JavaScript reuses the TypeScript extractor: the grammar is a superset, so the same
  // walk finds classes, functions, and top-level declarations. Only the reported language
  // differs, so a `.js` file is not described as TypeScript.
  '.js': { language: 'javascript', extract: extractTypeScriptSymbols },
  '.jsx': { language: 'javascript', extract: extractTypeScriptSymbols },
  '.mjs': { language: 'javascript', extract: extractTypeScriptSymbols },
  '.cjs': { language: 'javascript', extract: extractTypeScriptSymbols },
  '.py': { language: 'python', extract: extractPythonSymbols },
  // A `.h` may hold C or C++; the C++ grammar reads both, so it is the safe reading.
  '.cpp': { language: 'cpp', extract: extractCppSymbols, usesRelatedSources: true },
  '.cc': { language: 'cpp', extract: extractCppSymbols, usesRelatedSources: true },
  '.cxx': { language: 'cpp', extract: extractCppSymbols, usesRelatedSources: true },
  '.hpp': { language: 'cpp', extract: extractCppSymbols, usesRelatedSources: true },
  '.hh': { language: 'cpp', extract: extractCppSymbols, usesRelatedSources: true },
  '.hxx': { language: 'cpp', extract: extractCppSymbols, usesRelatedSources: true },
  '.h': { language: 'cpp', extract: extractCppSymbols, usesRelatedSources: true },
  '.sql': { language: 'sql', extract: extractSqlSymbols, tracksAccess: false },
};

export function symbolExtractorFor(file: string): SymbolExtractor | null {
  const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
  return SYMBOL_EXTRACTORS[extension] ?? null;
}
