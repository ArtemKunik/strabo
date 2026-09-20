import fs from 'node:fs';

import type { Diagnostic, GraphEdge } from '../../types.ts';
import { type CppFileFacts, extractCppFacts, resolveCpp } from './cpp.ts';
import { type CSharpFileFacts, extractCSharpFacts, resolveCSharp } from './csharp.ts';
import { type JavaFileFacts, extractJavaFacts, resolveJava } from './java.ts';
import { type KotlinFileFacts, extractKotlinFacts, resolveKotlin } from './kotlin.ts';
import { GrammarUnavailableError } from './parser-runtime.ts';
import { type PythonFileFacts, extractPythonFacts, resolvePython } from './python.ts';
import { type RustFileFacts, extractRustFacts, resolveRust } from './rust.ts';
import { type SqlFileFacts, extractSqlFacts, resolveSql } from './sql.ts';

/**
 * Languages named by the product concept that Strabo recognises today. Languages whose
 * extensions are ambiguous (`.cls` is usually Apex, `.i` is SWIG/C) are treated as
 * non-source rather than mislabelled.
 */
export type PolyglotLanguage =
  | 'java'
  | 'rust'
  | 'csharp'
  | 'kotlin'
  | 'python'
  | 'cpp'
  | 'sql';

export interface PolyglotResolution {
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

/**
 * One implemented language: which extensions it owns, and the whole extract-then-resolve
 * pipeline over a batch of files.
 *
 * Adding a language is a single entry in `POLYGLOT_RESOLVERS` plus its own module; the
 * scan orchestration, extension table, and unsupported-language reporting all derive from
 * this list rather than repeating a per-language block.
 */
export interface PolyglotLanguageResolver {
  language: PolyglotLanguage;
  extensions: readonly string[];
  resolve(
    files: readonly string[],
    contentByFile: ReadonlyMap<string, string> | undefined,
    diagnostics: Diagnostic[],
  ): Promise<PolyglotResolution>;
}

/** Languages that are recognised by extension but have no resolver yet. */
export const UNRESOLVED_POLYGLOT_LANGUAGES: ReadonlyArray<{
  language: PolyglotLanguage;
  extensions: readonly string[];
}> = [];

/**
 * Build a resolver from a language's extract and resolve functions.
 *
 * Extraction is wrapped here so read and parse failures become diagnostics for one file
 * rather than failing the whole scan, which every language previously repeated.
 */
function createResolver<TFacts, TResolution extends PolyglotResolution>(
  language: PolyglotLanguage,
  extensions: readonly string[],
  extract: (file: string, content: string) => Promise<{ facts: TFacts; diagnostics: Diagnostic[] }>,
  resolve: (facts: TFacts[]) => TResolution,
): PolyglotLanguageResolver {
  return {
    language,
    extensions,
    async resolve(files, contentByFile, diagnostics) {
      const facts: TFacts[] = [];
      for (const file of files) {
        const content = readContent(file, contentByFile);
        if (content === null) {
          diagnostics.push({
            file,
            line: 1,
            severity: 'warning',
            kind: 'parse-failure',
            message: 'Source could not be read; no edges were derived from this file.',
          });
          continue;
        }
        try {
          const extraction = await extract(file, content);
          facts.push(extraction.facts);
          diagnostics.push(...extraction.diagnostics);
        } catch (error) {
          diagnostics.push(toDiagnostic(file, error));
        }
      }
      const resolution = resolve(facts);
      return { edges: resolution.edges, diagnostics: resolution.diagnostics };
    },
  };
}

export const POLYGLOT_RESOLVERS: readonly PolyglotLanguageResolver[] = [
  createResolver<JavaFileFacts, PolyglotResolution>('java', ['.java'], extractJavaFacts, resolveJava),
  createResolver<RustFileFacts, PolyglotResolution>('rust', ['.rs'], extractRustFacts, resolveRust),
  createResolver<CSharpFileFacts, PolyglotResolution>('csharp', ['.cs'], extractCSharpFacts, resolveCSharp),
  createResolver<KotlinFileFacts, PolyglotResolution>('kotlin', ['.kt', '.kts'], extractKotlinFacts, resolveKotlin),
  createResolver<PythonFileFacts, PolyglotResolution>('python', ['.py'], extractPythonFacts, resolvePython),
  createResolver<CppFileFacts, PolyglotResolution>(
    'cpp',
    ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h'],
    extractCppFacts,
    resolveCpp,
  ),
  createResolver<SqlFileFacts, PolyglotResolution>('sql', ['.sql'], extractSqlFacts, resolveSql),
];

const RESOLVED_LANGUAGES: ReadonlySet<PolyglotLanguage> = new Set(
  POLYGLOT_RESOLVERS.map((resolver) => resolver.language),
);

export function isResolvedPolyglotLanguage(language: PolyglotLanguage): boolean {
  return RESOLVED_LANGUAGES.has(language);
}

/** The language that owns a file's extension, whether or not a resolver exists for it. */
export function polyglotLanguageOf(file: string): PolyglotLanguage | undefined {
  const extension = file.slice(file.lastIndexOf('.'));
  for (const resolver of POLYGLOT_RESOLVERS) {
    if (resolver.extensions.includes(extension)) {
      return resolver.language;
    }
  }
  for (const entry of UNRESOLVED_POLYGLOT_LANGUAGES) {
    if (entry.extensions.includes(extension)) {
      return entry.language;
    }
  }
  return undefined;
}

function readContent(
  file: string,
  contentByFile: ReadonlyMap<string, string> | undefined,
): string | null {
  const cached = contentByFile?.get(file);
  if (typeof cached === 'string') {
    return cached;
  }
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function toDiagnostic(file: string, error: unknown): Diagnostic {
  if (error instanceof GrammarUnavailableError) {
    return {
      file,
      line: 1,
      severity: 'info',
      kind: 'unsupported',
      message: `No parser grammar available for ${error.language}; file skipped.`,
    };
  }
  return {
    file,
    line: 1,
    severity: 'error',
    kind: 'parse-failure',
    message: `Failed to parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
  };
}
