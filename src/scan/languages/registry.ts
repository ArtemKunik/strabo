import { extractCSharpSymbols } from './csharp.ts';
import { extractJavaSymbols } from './java.ts';
import { extractKotlinSymbols } from './kotlin.ts';
import { extractRustSymbols } from './rust.ts';
import { extractTypeScriptSymbols } from './typescript.ts';
import type { SymbolExtraction } from './symbols.ts';

export interface SymbolExtractor {
  language: string;
  extract: (file: string, content: string) => Promise<SymbolExtraction>;
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
};

export function symbolExtractorFor(file: string): SymbolExtractor | null {
  const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
  return SYMBOL_EXTRACTORS[extension] ?? null;
}
