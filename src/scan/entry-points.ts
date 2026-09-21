import fs from 'node:fs';
import path from 'node:path';

import { toPosix } from '../boundary/repository-root.ts';

/**
 * A file a manifest names as a starting point for the program.
 *
 * Entry points are read from `package.json` (`main`, `bin`, `exports`), `Cargo.toml`
 * (`[[bin]]`, `[lib]`, and the `src/main.rs` convention), and `pom.xml` (`<mainClass>`).
 * A declared target only becomes an entry point when it resolves to a scanned source file,
 * so a `dist/` bundle absent from the graph is not invented as one.
 */
export interface EntryPoint {
  /** Repository-relative, POSIX-normalised source file. */
  file: string;
  /** Why the file is an entry point, for evidence. */
  reason: string;
  /** Manifest that declared it, repository-relative. */
  source: string;
}

/** Extensions tried when a manifest names an extensionless module path. */
const EXTENSION_FALLBACKS = [
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.kt', '.kts', '.rs', '.cs',
  '.cpp', '.cc', '.cxx',
];

/**
 * Detect entry points declared by manifests anywhere above a scanned source file.
 *
 * Only directories that already contain (or are an ancestor of) a scanned file are
 * inspected, so this never walks generated trees and never names a file outside the graph.
 */
export function detectEntryPoints(root: string, files: readonly string[]): EntryPoint[] {
  const sourceSet = new Set(files);
  const directories = manifestDirectories(files);
  const found = new Map<string, EntryPoint>();

  const add = (file: string | null, reason: string, source: string): void => {
    if (!file || found.has(file)) {
      return;
    }
    found.set(file, { file, reason, source });
  };

  for (const directory of directories) {
    const read = (name: string): string | null => {
      try {
        return fs.readFileSync(path.join(root, directory, name), 'utf8');
      } catch {
        return null;
      }
    };
    const source = (name: string) => (directory === '.' ? name : `${directory}/${name}`);

    const pkg = read('package.json');
    if (pkg !== null) {
      for (const entry of packageEntries(pkg, directory, sourceSet)) {
        add(entry.file, entry.reason, source('package.json'));
      }
    }

    const cargo = read('Cargo.toml');
    if (cargo !== null) {
      for (const entry of cargoEntries(cargo, directory, sourceSet)) {
        add(entry.file, entry.reason, source('Cargo.toml'));
      }
    }

    const pom = read('pom.xml');
    if (pom !== null) {
      for (const file of mavenEntries(pom, sourceSet)) {
        add(file, 'pom.xml mainClass', source('pom.xml'));
      }
    }
  }

  return [...found.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/** Every directory containing a scanned file, plus every ancestor up to the root. */
function manifestDirectories(files: readonly string[]): string[] {
  const directories = new Set<string>(['.']);
  for (const file of files) {
    const slash = file.lastIndexOf('/');
    let directory = slash === -1 ? '.' : file.slice(0, slash);
    while (directory !== '.' && !directories.has(directory)) {
      directories.add(directory);
      const parent = directory.lastIndexOf('/');
      directory = parent === -1 ? '.' : directory.slice(0, parent);
    }
  }
  return [...directories].sort();
}

interface DeclaredEntry {
  file: string | null;
  reason: string;
}

function packageEntries(
  content: string,
  directory: string,
  sourceSet: Set<string>,
): DeclaredEntry[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return [];
  }
  const entries: DeclaredEntry[] = [];
  const resolve = (target: unknown) =>
    typeof target === 'string' ? matchSource(sourceSet, directory, target) : null;

  entries.push({ file: resolve(parsed.main), reason: 'package.json main' });

  if (typeof parsed.bin === 'string') {
    entries.push({ file: resolve(parsed.bin), reason: 'package.json bin' });
  } else if (parsed.bin && typeof parsed.bin === 'object') {
    for (const target of Object.values(parsed.bin as Record<string, unknown>)) {
      entries.push({ file: resolve(target), reason: 'package.json bin' });
    }
  }

  for (const target of collectExports(parsed.exports)) {
    entries.push({ file: resolve(target), reason: 'package.json exports' });
  }

  return entries;
}

/** Collect every string leaf of an `exports` value, whatever its nesting. */
function collectExports(value: unknown, depth = 0): string[] {
  if (depth > 6 || value === null || value === undefined) {
    return [];
  }
  if (typeof value === 'string') {
    return [value];
  }
  if (typeof value !== 'object') {
    return [];
  }
  const leaves: string[] = [];
  for (const nested of Object.values(value as Record<string, unknown>)) {
    leaves.push(...collectExports(nested, depth + 1));
  }
  return leaves;
}

function cargoEntries(
  content: string,
  directory: string,
  sourceSet: Set<string>,
): DeclaredEntry[] {
  const entries: DeclaredEntry[] = [];
  const tryPath = (target: string | null, reason: string) => {
    entries.push({
      file: target ? matchSource(sourceSet, directory, target) : null,
      reason,
    });
  };

  for (const block of content.split(/^\[\[bin\]\]\s*$/m).slice(1)) {
    const declaredPath = matchTomlString(block, 'path');
    if (declaredPath) {
      tryPath(declaredPath, 'Cargo.toml [[bin]]');
      continue;
    }
    const name = matchTomlString(block, 'name');
    if (name) {
      const candidate = matchSource(sourceSet, directory, `src/bin/${name}.rs`)
        ?? matchSource(sourceSet, directory, `src/main.rs`);
      entries.push({ file: candidate, reason: 'Cargo.toml [[bin]]' });
      continue;
    }
    tryPath('src/main.rs', 'Cargo.toml [[bin]]');
  }

  const libBlock = /^\[lib\]\s*$/m.test(content)
    ? content.split(/^\[lib\]\s*$/m)[1] ?? ''
    : '';
  if (libBlock) {
    const declaredPath = matchTomlString(libBlock, 'path');
    tryPath(declaredPath ?? 'src/lib.rs', 'Cargo.toml [lib]');
  }

  // The conventional binary target when a Cargo.toml is present without a [[bin]] table.
  if (!entries.some((entry) => entry.reason === 'Cargo.toml [[bin]]')) {
    tryPath('src/main.rs', 'Cargo.toml bin');
  }

  return entries;
}

function mavenEntries(content: string, sourceSet: Set<string>): string[] {
  const files: string[] = [];
  for (const match of content.matchAll(/<mainClass>\s*([^<]+?)\s*<\/mainClass>/g)) {
    const className = (match[1] ?? '').trim();
    if (!className) {
      continue;
    }
    const relative = className.replace(/\./g, '/');
    const hit = [...sourceSet]
      .filter((file) => file.endsWith(`${relative}.java`) || file.endsWith(`${relative}.kt`))
      .sort()[0];
    if (hit) {
      files.push(hit);
    }
  }
  return files;
}

function matchTomlString(block: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm').exec(block);
  return match?.[1] ?? null;
}

/**
 * Resolve a manifest-declared path to a scanned source file.
 *
 * Absolute paths and package-internal specifiers (`#...`) are refused. Extensionless
 * targets are tried with common source extensions and an `index.*` fallback, so a
 * bundler-style `main: "./src/index"` still resolves to `src/index.ts`.
 */
function matchSource(sourceSet: Set<string>, directory: string, target: string): string | null {
  const cleaned = target.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!cleaned || cleaned.startsWith('#') || cleaned.startsWith('data:') || /^[a-z]+:\/\//i.test(cleaned)) {
    return null;
  }
  const base = directory === '.' ? '' : `${directory}/`;
  const joined = toPosix(path.posix.normalize(`${base}${cleaned}`)).replace(/^\.\//, '');
  if (sourceSet.has(joined)) {
    return joined;
  }
  if (!/\.[A-Za-z0-9]+$/.test(joined)) {
    for (const extension of EXTENSION_FALLBACKS) {
      if (sourceSet.has(`${joined}${extension}`)) {
        return `${joined}${extension}`;
      }
    }
  }
  for (const extension of EXTENSION_FALLBACKS) {
    if (sourceSet.has(`${joined}/index${extension}`)) {
      return `${joined}/index${extension}`;
    }
  }
  return null;
}
