import type { Diagnostic, ExternalImport } from '../types.ts';

/** Rust prelude crates and path roots that never name an external dependency. */
const RUST_RESERVED = new Set(['crate', 'self', 'super', 'std', 'core', 'alloc', 'proc_macro']);

/**
 * Java/Kotlin packages provided by the language, the JDK, or the Android platform, not by a
 * Maven dependency. `kotlinx.*` is deliberately absent: those are ordinary libraries.
 */
const JVM_RESERVED = /^(java|javax|jdk|sun|com\.sun|kotlin|android|dalvik)(\.|$)/;

const RUST_USE = /^\s*(?:pub\s+)?use\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:::|;|as\b)/gm;
const RUST_EXTERN = /^\s*extern\s+crate\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gm;
const JVM_IMPORT = /^\s*import\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;?/gm;
const JVM_PACKAGE = /^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;?/m;
const RUST_MOD = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*[;{]/gm;
const RUST_LOCAL_USE = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+(?:crate|self|super)::(?:[A-Za-z_][A-Za-z0-9_]*::)*([A-Za-z_][A-Za-z0-9_]*)\s*(?:;|as\b)/gm;

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
  diagnostics: Diagnostic[],
): ExternalImport[] {
  const imports: ExternalImport[] = [];
  const localJvmPackages = collectJvmPackages(files, contentByFile);
  const localRustModules = collectRustModules(files, contentByFile);
  for (const file of files) {
    const content = contentByFile.get(file);
    if (content === undefined) {
      diagnostics.push({
        file,
        line: 1,
        message: `Source content was not available for external import scanning.`,
        severity: 'warning',
        kind: 'read-failure',
      });
      continue;
    }
    if (file.endsWith('.rs')) {
      const local = localRustModules.get(rustCrateRoot(file)) ?? new Set<string>();
      imports.push(...matchRust(file, content, RUST_USE, 'use').filter((entry) => !local.has(entry.specifier)));
      imports.push(...matchRust(file, content, RUST_EXTERN, 'extern-crate'));
      continue;
    }
    if (isJvmSource(file)) {
      imports.push(...matchJvm(file, content).filter((entry) => !isLocalJvmPackage(entry.package, localJvmPackages)));
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
    const packageName = jvmPackageOf(name);
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

/**
 * The package an import names: `a.b.C` -> `a.b`, `a.b.*` -> `a.b`, and a nested or member
 * import such as `okhttp3.MediaType.Companion` stops at the first type segment -> `okhttp3`.
 * A segment starting with an upper-case letter is a type by JVM naming convention.
 */
function jvmPackageOf(name: string): string {
  const segments = (name.endsWith('.*') ? name.slice(0, -2) : name).split('.');
  const firstType = segments.findIndex((segment) => /^[A-Z]/.test(segment));
  if (firstType !== -1) {
    return segments.slice(0, firstType).join('.');
  }
  return name.endsWith('.*') ? segments.join('.') : segments.slice(0, -1).join('.');
}

function isJvmSource(file: string): boolean {
  return file.endsWith('.java') || file.endsWith('.kt') || file.endsWith('.kts');
}

/** Packages this repository declares; importing them is local code, not a dependency. */
function collectJvmPackages(files: readonly string[], contentByFile: ReadonlyMap<string, string>): Set<string> {
  const packages = new Set<string>();
  for (const file of files) {
    const content = isJvmSource(file) ? contentByFile.get(file) : undefined;
    const declared = content === undefined ? undefined : JVM_PACKAGE.exec(content)?.[1];
    if (declared) {
      packages.add(declared);
    }
  }
  return packages;
}

function isLocalJvmPackage(packageName: string, local: ReadonlySet<string>): boolean {
  for (const declared of local) {
    if (packageName === declared || packageName.startsWith(`${declared}.`)) {
      return true;
    }
  }
  return false;
}

/**
 * The crate a Rust file belongs to: the path before its `src/`, `tests/`, `examples/`, or
 * `benches/` directory. Files outside those layouts group by their own directory.
 */
function rustCrateRoot(file: string): string {
  const match = /^(.*?)(?:^|\/)(?:src|tests|examples|benches)\//.exec(file);
  if (match) {
    return match[1] ?? '';
  }
  const slash = file.lastIndexOf('/');
  return slash === -1 ? '' : file.slice(0, slash);
}

/**
 * Names that resolve inside each crate rather than to an external crate.
 *
 * Since Rust 2018 a `use` path may start at a module in scope, so `use alerts::Rule` after
 * `mod alerts;` is local. A crate's module names are its `mod` declarations, its source file
 * stems (`alerts.rs`, `alerts/mod.rs`), and names brought in by `use crate::`/`self::`/`super::`.
 */
function collectRustModules(
  files: readonly string[],
  contentByFile: ReadonlyMap<string, string>,
): Map<string, Set<string>> {
  const byCrate = new Map<string, Set<string>>();
  for (const file of files) {
    if (!file.endsWith('.rs')) {
      continue;
    }
    const crate = rustCrateRoot(file);
    const names = byCrate.get(crate) ?? new Set<string>();
    byCrate.set(crate, names);
    const segments = file.split('/');
    const stem = (segments.at(-1) ?? '').replace(/\.rs$/, '');
    names.add(stem === 'mod' ? segments.at(-2) ?? '' : stem);
    const content = contentByFile.get(file) ?? '';
    for (const match of content.matchAll(RUST_MOD)) {
      names.add(match[1] ?? '');
    }
    for (const match of content.matchAll(RUST_LOCAL_USE)) {
      names.add(match[1] ?? '');
    }
  }
  return byCrate;
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
