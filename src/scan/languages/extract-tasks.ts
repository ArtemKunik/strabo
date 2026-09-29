import type { Diagnostic } from '../../types.ts';
import type { PolyglotLanguage } from './resolvers.ts';
import { extractCppFacts } from './cpp.ts';
import { extractCSharpFacts } from './csharp.ts';
import { extractJavaFacts } from './java.ts';
import { extractKotlinFacts } from './kotlin.ts';
import { extractPythonFacts } from './python.ts';
import { extractRustFacts } from './rust.ts';
import { extractSqlFacts } from './sql.ts';

/**
 * The wire shape one parse/extract task uses, and the extractor table the worker reads.
 *
 * Both the pool (main thread) and the worker import this, so the message shape is defined
 * once. The facts are `unknown` on the wire: the worker sends the language's own facts object
 * and the main thread only re-assembles them in order before the resolver reads them, never
 * touching a language-specific field itself.
 */

export interface ExtractRequest {
  id: number;
  language: PolyglotLanguage;
  file: string;
  content: string;
}

export interface ExtractResponse {
  id: number;
  ok: boolean;
  facts?: unknown;
  diagnostics?: Diagnostic[];
  error?: string;
}

/** The per-file extractor for each language, matching the resolvers' own extractors. */
export const EXTRACTORS: Record<
  PolyglotLanguage,
  (file: string, content: string) => Promise<{ facts: unknown; diagnostics: Diagnostic[] }>
> = {
  java: extractJavaFacts,
  rust: extractRustFacts,
  csharp: extractCSharpFacts,
  kotlin: extractKotlinFacts,
  python: extractPythonFacts,
  cpp: extractCppFacts,
  sql: extractSqlFacts,
};
