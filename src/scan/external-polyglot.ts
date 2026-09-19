import type { ExternalImport } from '../types.ts';

/** Rust prelude crates and path roots that never name an external dependency. */
const RUST_RESERVED = new Set(['crate', 'self', 'super', 'std', 'core', 'alloc', 'proc_macro']);

/** Java/Kotlin packages provided by the language or JDK, not by a Maven dependency. */
const JVM_RESERVED = /^(java|javax|jdk|sun|com\.sun)\./;

const RUST_USE = /^\s*(?:pub\s+)?use\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:::|;|as\b)/gm;
const RUST_EXTERN = /^\s*extern\s+crate\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm;
const JVM_IMPORT = /^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;?/gm;

/**
 * Record external package references from Rust, Java, and Kotlin sources.
 *
 * Only the package root is captured. A Rust `use serde::Deserialize` names the crate
 * `serde`; a JVM `import com.fasterxml.jackson.databind.ObjectMapper` names the package
 * `com.fasterxml.jackson.databind`. Mapping a JVM package to a Maven `groupId:artifactId`
 * is not 1:1, so that join is done conservatively by the risk report and never guessed here.
 */
export function collectPolyglotExternalImports(
  files: readonly string[],
  contentByFile: ReadonlyMap<string, string>,
): ExternalImport[] {
  const imports: ExternalImport[] = [];
  for (const file of files) {
    const content = contentByFile.get(file);
    if (content === undefined) {
      continue;
    }
    if (file.endsWith('.rs')) {
      imports.push(...matchRust(file, content, RUST_USE, 'use'));
      imports.push(...matchRust(file, content, RUST_EXTERN, 'extern-crate'));
      continue;
    }
    if (file.endsWith('.java') || file.endsWith('.kt') || file.endsWith('.kts')) {
      imports.push(...matchJvm(file, content));
    }
  }
  return dedupe(imports);
}

function matchRust(
  file: string,
  content: string,
  pattern: RegExp,
  kind: ExternalImport['kind'],
): ExternalImport[] {
  const imports: ExternalImport[] = [];
  for (const match of content.matchAll(pattern)) {
    const name = match[1] ?? '';
    if (name === '' || RUST_RESERVED.has(name)) {
      continue;
    }
    imports.push({
      file,
      line: lineOf(content, match.index ?? 0),
      specifier: name,
      // A crate import uses the module name, which normalises `-` to `_`.
      package: name.replace(/_/g, '-'),
      ecosystem: 'cargo',
      kind,
    });
  }
  return imports;
}

function matchJvm(file: string, content: string): ExternalImport[] {
  const imports: ExternalImport[] = [];
  for (const match of content.matchAll(JVM_IMPORT)) {
    const name = match[1] ?? '';
    if (name === '' || JVM_RESERVED.test(name)) {
      continue;
    }
    // Drop the imported type, keeping the package; `import a.b.C` -> `a.b`.
    const packageName = name.endsWith('.*') ? name.slice(0, -2) : name.slice(0, name.lastIndexOf('.'));
    if (packageName === '' || JVM_RESERVED.test(packageName)) {
      continue;
    }
    imports.push({
      file,
      line: lineOf(content, match.index ?? 0),
      specifier: name,
      package: packageName,
      ecosystem: 'maven',
      kind: 'import',
    });
  }
  return imports;
}

/** Map a JVM package to a Maven coordinate, conservatively. */
export function mavenCoordinateMatches(packageName: string, coordinate: string): boolean {
  const [groupId = ''] = coordinate.split(':');
  if (groupId === '') {
    return false;
  }
  return packageName === groupId || packageName.startsWith(`${groupId}.`);
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

function dedupe(imports: ExternalImport[]): ExternalImport[] {
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
