import type { Diagnostic, ExternalImport, GraphEdge } from '../types.ts';
import { loadAliasTables, resolveAliased, type AliasTables } from '../resolve/aliases.ts';
import { resolveRelative, resolveTargetPath } from '../resolve/index.ts';
import { isGeneratedPath } from './exclusions.ts';

export interface JsTsScanResult {
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
  externalImports: ExternalImport[];
}

export interface JsTsScanOptions {
  /**
   * Repository root for `tsconfig.json`/`jsconfig.json`/`package.json` alias
   * discovery. Omit to keep purely relative resolution (e.g. in unit tests).
   */
  root?: string;
}

const IMPORT_FROM =
  /(?:^|\n)[ \t]*import\s+(?:type\s+)?(?:[^'"]*?\bfrom\s*)?['"]([^'"]+)['"]/g;
const EXPORT_FROM = /(?:^|\n)[ \t]*export\s+(?:type\s+)?[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_CALL = /(?<![.\w])require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Extract static imports, re-exports, `require`, and dynamic imports from JS/TS.
 *
 * Relative specifiers resolve against the importer; root-relative (`/src/...`),
 * `tsconfig`/`jsconfig` path aliases, and package subpath imports (`#...`)
 * resolve through the repository's own config files. Bare packages are external
 * and must not create internal graph edges. A claimed specifier that cannot be
 * resolved becomes a diagnostic rather than a speculative edge.
 */
export function scanJsTsEdges(
  files: readonly string[],
  contentByFile: ReadonlyMap<string, string>,
  options: JsTsScanOptions = {},
): JsTsScanResult {
  const fileSet = new Set(files);
  const edges: GraphEdge[] = [];
  const diagnostics: Diagnostic[] = [];
  const externalImports: ExternalImport[] = [];
  const tables: AliasTables | null = options.root ? loadAliasTables(options.root) : null;

  for (const file of files) {
    if (!isJavaScriptLike(file)) {
      continue;
    }
    const content = contentByFile.get(file);
    if (!content) {
      continue;
    }

    for (const match of collectReferences(content)) {
      // A barrel re-export (`index.ts`) only forwards names; it declares the module graph
      // rather than depending on the target's contents, so it is drawn but not counted.
      const role: GraphEdge['role'] =
        match.kind === 're-export' && isBarrelFile(file) ? 'declare' : 'use';
      const relationship: GraphEdge['relationship'] =
        match.kind === 're-export' ? 're-export' : 'import';
      // `./` and `../` resolve against the importer; `/`-rooted specifiers are
      // bundler root-relative and belong to the alias layer below.
      if (isDotRelative(match.specifier)) {
        const resolved = resolveRelative(match.specifier, match.line, { from: file, files: fileSet });
        if (resolved) {
          edges.push({
            source: file,
            target: resolved.target,
            kind: match.kind,
            evidence: resolved.evidence,
            role,
            relationship,
          });
          continue;
        }
      } else if (tables) {
        const claim = resolveAliased(match.specifier, match.line, file, fileSet, tables);
        if (claim.resolved) {
          edges.push({
            source: file,
            target: claim.resolved.target,
            kind: match.kind,
            evidence: claim.resolved.evidence,
            role,
            relationship,
          });
          continue;
        }
        if (claim.claimed) {
          // An alias matched but its target is missing; fall through to a diagnostic.
          if (isAssetSpecifier(match.specifier)) {
            continue;
          }
        } else {
          if (!isAssetSpecifier(match.specifier)) {
            recordExternal(file, match);
          }
          continue;
        }
      } else if (!isRootRelative(match.specifier)) {
        if (!isAssetSpecifier(match.specifier)) {
          recordExternal(file, match);
        }
        continue;
      }
      if (isAssetSpecifier(match.specifier)) {
        continue;
      }
      // A dot-relative specifier that names build output (a package launcher importing
      // `../dist/cli.js`) targets a directory the scan excludes by design, not a missing
      // authored file; treat it as out of scope like an asset rather than report it.
      if (isDotRelative(match.specifier) && isGeneratedPath(resolveTargetPath(file, match.specifier))) {
        continue;
      }
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

  /** A bare specifier names a package outside the repository; record it, never draw an edge. */
  function recordExternal(file: string, match: Reference): void {
    const name = npmPackageOf(match.specifier);
    if (!name) {
      return;
    }
    externalImports.push({
      file,
      line: match.line,
      specifier: match.specifier,
      package: name,
      ecosystem: 'npm',
      kind: match.kind,
    });
  }

  return {
    edges: dedupeEdges(edges),
    diagnostics: dedupeDiagnostics(diagnostics),
    externalImports: dedupeExternalImports(externalImports),
  };
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
        // `^|\n`-anchored patterns consume the preceding newline, so the match
        // starts one char before the import. Step over it for a true 1-based line.
        const start = match.index ?? 0;
        const line = lineOf(content, start + (content[start] === '\n' ? 1 : 0));
        references.push({ specifier, line, kind });
      }
    }
  };

  add(IMPORT_FROM, 'import');
  add(EXPORT_FROM, 're-export');
  add(DYNAMIC_IMPORT, 'dynamic-import');
  add(REQUIRE_CALL, 'require');

  return references;
}

function isDotRelative(specifier: string): boolean {
  return specifier.startsWith('.');
}

/** A barrel file (`index.ts`, `index.js`, …) whose re-exports only forward names. */
function isBarrelFile(file: string): boolean {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot === -1 ? base : base.slice(0, dot);
  return stem === 'index';
}

function isRootRelative(specifier: string): boolean {
  return specifier.startsWith('/');
}

/**
 * The npm package a bare specifier belongs to.
 *
 * `lodash/fp` and `@scope/pkg/sub` name `lodash` and `@scope/pkg`. Node builtins
 * (`node:fs`), protocol URLs, and subpath imports (`#internal`) are not packages.
 */
export function npmPackageOf(specifier: string): string | null {
  if (specifier === '' || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
    return null;
  }
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) {
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
  }
  return segments[0] || null;
}

function dedupeExternalImports(imports: ExternalImport[]): ExternalImport[] {
  const seen = new Set<string>();
  return imports.filter((entry) => {
    const key = `${entry.file}\u0000${entry.line}\u0000${entry.package}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** Module extensions Strabo models. Anything else (`.css`, `.json`, images) is an asset. */
const MODULE_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

/**
 * Asset imports (stylesheets, JSON, images) point at files the scanner deliberately does
 * not model. Reporting them as unresolved would be noise, so they are skipped.
 */
function isAssetSpecifier(specifier: string): boolean {
  const specifierWithoutQuery = specifier.includes('?') ? specifier.slice(0, specifier.indexOf('?')) : specifier;
  const base = specifierWithoutQuery.slice(specifierWithoutQuery.lastIndexOf('/') + 1);
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
