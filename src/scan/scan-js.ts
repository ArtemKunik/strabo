import type { Diagnostic, GraphEdge } from '../types.ts';
import { resolveRelative } from '../resolve/index.ts';

export interface JsTsScanResult {
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

const IMPORT_FROM =
  /(?:^|\n)[ \t]*import\s+(?:type\s+)?(?:[^'"]*?\bfrom\s*)?['"]([^'"]+)['"]/g;
const EXPORT_FROM = /(?:^|\n)[ \t]*export\s+(?:type\s+)?[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_CALL = /(?<![.\w])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Extract static imports, re-exports, `require`, and dynamic imports from JS/TS.
 *
 * Only relative specifiers are considered. Bare package specifiers are external and
 * must not create internal graph edges. A relative specifier that cannot be resolved
 * becomes a diagnostic rather than a speculative edge.
 */
export function scanJsTsEdges(
  files: readonly string[],
  contentByFile: ReadonlyMap<string, string>,
): JsTsScanResult {
  const fileSet = new Set(files);
  const edges: GraphEdge[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const file of files) {
    if (!isJavaScriptLike(file)) {
      continue;
    }
    const content = contentByFile.get(file);
    if (!content) {
      continue;
    }

    for (const match of collectReferences(content)) {
      const resolved = resolveRelative(match.specifier, match.line, { from: file, files: fileSet });
      if (resolved) {
        edges.push({
          source: file,
          target: resolved.target,
          kind: match.kind,
          evidence: resolved.evidence,
        });
        continue;
      }
      if (isRelative(match.specifier) && !isAssetSpecifier(match.specifier)) {
        diagnostics.push({
          file,
          line: match.line,
          severity: 'warning',
          kind: 'unresolved',
          specifier: match.specifier,
          message: `Reference "${match.specifier}" does not resolve to a file inside the repository.`,
        });
      }
    }
  }

  return { edges: dedupeEdges(edges), diagnostics: dedupeDiagnostics(diagnostics) };
}

interface Reference {
  specifier: string;
  line: number;
  kind: GraphEdge['kind'];
}

function collectReferences(content: string): Reference[] {
  const references: Reference[] = [];

  const add = (
    pattern: RegExp,
    kind: GraphEdge['kind'],
    group = 1,
  ): void => {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[group];
      if (specifier) {
        references.push({ specifier, line: lineOf(content, match.index ?? 0), kind });
      }
    }
  };

  add(IMPORT_FROM, 'import');
  add(EXPORT_FROM, 're-export');
  add(DYNAMIC_IMPORT, 'dynamic-import');
  add(REQUIRE_CALL, 'require');

  return references;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('.') || specifier.startsWith('/');
}

/** Module extensions Strabo models. Anything else (`.css`, `.json`, images) is an asset. */
const MODULE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

/**
 * Asset imports (stylesheets, JSON, images) point at files the scanner deliberately does
 * not model. Reporting them as unresolved would be noise, so they are skipped.
 */
function isAssetSpecifier(specifier: string): boolean {
  const base = specifier.slice(specifier.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) {
    return false;
  }
  return !MODULE_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

function isJavaScriptLike(file: string): boolean {
  return /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(file);
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function dedupeEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.source}\u0000${edge.target}\u0000${edge.kind}\u0000${edge.evidence.line}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.file}\u0000${diagnostic.line}\u0000${diagnostic.specifier}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
