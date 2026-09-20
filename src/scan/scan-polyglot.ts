import fs from 'node:fs';

import type { Diagnostic, GraphEdge } from '../types.ts';
import { type CSharpFileFacts, extractCSharpFacts, resolveCSharp } from './languages/csharp.ts';
import { type JavaFileFacts, extractJavaFacts, resolveJava } from './languages/java.ts';
import { type KotlinFileFacts, extractKotlinFacts, resolveKotlin } from './languages/kotlin.ts';
import { GrammarUnavailableError } from './languages/parser-runtime.ts';
import { type RustFileFacts, extractRustFacts, resolveRust } from './languages/rust.ts';
import { type SqlFileFacts, extractSqlFacts, resolveSql } from './languages/sql.ts';

/**
 * Languages named by the product concept that Strabo recognises today. COBOL and ABL are
 * out of scope for now; their extensions are ambiguous (`.cls` is usually Apex, `.i` is
 * SWIG/C), so they are treated as non-source rather than mislabelled.
 */
export type PolyglotLanguage = 'java' | 'rust' | 'csharp' | 'kotlin' | 'cpp' | 'sql';

export interface PolyglotResult {
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

/** Languages with an implemented resolver. Others are reported as unsupported. */
const RESOLVED_LANGUAGES: ReadonlySet<PolyglotLanguage> = new Set([
  'java',
  'rust',
  'csharp',
  'kotlin',
  'sql',
]);

let queue: Promise<unknown> = Promise.resolve();

/**
 * Serialise polyglot scans so shared parser state is never mutated concurrently.
 *
 * Parser runtime state is process-global, so scans run one at a time through this queue.
 */
export function scanPolyglotEdges(
  files: readonly string[],
  contentByFile?: ReadonlyMap<string, string>,
): Promise<PolyglotResult> {
  const task = queue.then(() => extractAndResolve(files, contentByFile));
  queue = task.catch(() => undefined);
  return task;
}

async function extractAndResolve(
  files: readonly string[],
  contentByFile?: ReadonlyMap<string, string>,
): Promise<PolyglotResult> {
  const byLanguage = groupByLanguage(files);
  const diagnostics: Diagnostic[] = [];
  const edges: GraphEdge[] = [];

  const java = await extractFacts(byLanguage.get('java') ?? [], contentByFile, diagnostics, extractJavaFacts);
  const javaResolution = resolveJava(java);
  edges.push(...javaResolution.edges);
  diagnostics.push(...javaResolution.diagnostics);

  const rust = await extractFacts(byLanguage.get('rust') ?? [], contentByFile, diagnostics, extractRustFacts);
  const rustResolution = resolveRust(rust);
  edges.push(...rustResolution.edges);
  diagnostics.push(...rustResolution.diagnostics);

  const csharp = await extractFacts(
    byLanguage.get('csharp') ?? [],
    contentByFile,
    diagnostics,
    extractCSharpFacts,
  );
  const csharpResolution = resolveCSharp(csharp);
  edges.push(...csharpResolution.edges);
  diagnostics.push(...csharpResolution.diagnostics);

  const kotlin = await extractFacts(
    byLanguage.get('kotlin') ?? [],
    contentByFile,
    diagnostics,
    extractKotlinFacts,
  );
  const kotlinResolution = resolveKotlin(kotlin);
  edges.push(...kotlinResolution.edges);
  diagnostics.push(...kotlinResolution.diagnostics);

  const sql = await extractFacts(byLanguage.get('sql') ?? [], contentByFile, diagnostics, extractSqlFacts);
  const sqlResolution = resolveSql(sql);
  edges.push(...sqlResolution.edges);
  diagnostics.push(...sqlResolution.diagnostics);

  for (const [language, languageFiles] of byLanguage) {
    if (RESOLVED_LANGUAGES.has(language)) {
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

/**
 * Extract facts per file, converting read and parse failures into diagnostics so one bad
 * file never fails a scan.
 */
type Extractor<T> = (
  file: string,
  content: string,
) => Promise<{ facts: T; diagnostics: Diagnostic[] }>;

async function extractFacts<T>(
  files: readonly string[],
  contentByFile: ReadonlyMap<string, string> | undefined,
  diagnostics: Diagnostic[],
  extract: Extractor<T>,
): Promise<T[]> {
  const facts: T[] = [];
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
  return facts;
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

const POLYGLOT_EXTENSIONS = [
  '.java',
  '.rs',
  '.cs',
  '.kt',
  '.kts',
  '.cpp',
  '.cc',
  '.cxx',
  '.hpp',
  '.h',
  '.sql',
];

export function isPolyglotSource(file: string): boolean {
  return POLYGLOT_EXTENSIONS.some((extension) => file.endsWith(extension));
}

export function languageOf(file: string): PolyglotLanguage | undefined {
  const extension = file.slice(file.lastIndexOf('.'));
  switch (extension) {
    case '.java':
      return 'java';
    case '.rs':
      return 'rust';
    case '.cs':
      return 'csharp';
    case '.kt':
    case '.kts':
      return 'kotlin';
    case '.cpp':
    case '.cc':
    case '.cxx':
    case '.hpp':
    case '.h':
      return 'cpp';
    case '.sql':
      return 'sql';
    default:
      return undefined;
  }
}
