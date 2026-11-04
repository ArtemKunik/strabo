import fs from 'node:fs';
import path from 'node:path';

/** One Cargo package in the repository, as far as path resolution needs it. */
export interface RustCrate {
  /** Repository-relative directory of the `Cargo.toml`, '' at the root. */
  dir: string;
  /** The `[package] name`, spelled as in the manifest. */
  packageName: string;
  /** The name code uses for this crate's library: `[lib] name`, or the package name with `_`. */
  libName: string;
  /** Repository-relative library root; absent for a binary-only package. */
  libFile?: string;
  /** What this package depends on: the name in its table, and `package = "..."` when renamed. */
  dependencies: Array<{ name: string; package?: string }>;
}

const SECTION = /^\s*\[([^\][]+)\]\s*(?:#.*)?$/;
const KEY_VALUE = /^\s*(?:"([^"]+)"|([A-Za-z0-9_.-]+))\s*=\s*(.*)$/;

/**
 * Read the Cargo packages that own the given Rust files.
 *
 * Each file looks upward for its nearest `Cargo.toml`, so a manifest is read only when a scanned
 * file sits under it. A revision scan reads the working tree's manifests here, as entry-point
 * detection does, so both sides of a comparison resolve crates alike.
 */
export function readRustCrates(root: string, files: readonly string[]): RustCrate[] {
  const manifests = new Map<string, RustCrate | null>();
  const scanned = new Set(files);

  const read = (dir: string): RustCrate | null => {
    const known = manifests.get(dir);
    if (known !== undefined) {
      return known;
    }
    let content: string | null = null;
    try {
      content = fs.readFileSync(path.join(root, dir, 'Cargo.toml'), 'utf8');
    } catch {
      content = null;
    }
    const crate = content === null ? null : parseCargoManifest(dir, content, scanned);
    manifests.set(dir, crate);
    return crate;
  };

  for (const file of files) {
    let dir: string | null = parentOf(file);
    while (dir !== null) {
      if (read(dir)) {
        break;
      }
      dir = dir === '' ? null : parentOf(dir);
    }
  }
  return [...manifests.values()].filter((crate): crate is RustCrate => crate !== null);
}

/**
 * Parse the parts of a `Cargo.toml` that name crates. Null for a manifest with no `[package]`,
 * such as a virtual workspace root.
 */
export function parseCargoManifest(
  dir: string,
  content: string,
  scanned: ReadonlySet<string>,
): RustCrate | null {
  let packageName: string | undefined;
  let libName: string | undefined;
  let libPath: string | undefined;
  const dependencies = new Map<string, { name: string; package?: string }>();
  let section = '';

  for (const line of content.split(/\r?\n/)) {
    const header = SECTION.exec(line);
    if (header) {
      section = (header[1] as string).trim();
      const table = dependencyTable(section);
      if (table) {
        dependencies.set(table, dependencies.get(table) ?? { name: table });
      }
      continue;
    }
    const pair = KEY_VALUE.exec(line);
    if (!pair) {
      continue;
    }
    const key = (pair[1] ?? pair[2]) as string;
    const value = pair[3] as string;
    if (section === 'package' && key === 'name') {
      packageName = tomlString(value);
    } else if (section === 'lib' && key === 'name') {
      libName = tomlString(value);
    } else if (section === 'lib' && key === 'path') {
      libPath = tomlString(value);
    } else if (isDependencySection(section)) {
      const name = key.split('.')[0] as string;
      const renamed = /\bpackage\s*=\s*"([^"]+)"/.exec(value)?.[1];
      dependencies.set(name, { name, ...(renamed ? { package: renamed } : {}) });
    } else {
      const table = dependencyTable(section);
      if (table && key === 'package') {
        const renamed = tomlString(value);
        dependencies.set(table, { name: table, ...(renamed ? { package: renamed } : {}) });
      }
    }
  }

  if (!packageName) {
    return null;
  }
  const lib = path.posix.join(dir, libPath ?? 'src/lib.rs');
  return {
    dir,
    packageName,
    libName: externName(libName ?? packageName),
    ...(scanned.has(lib) ? { libFile: lib } : {}),
    dependencies: [...dependencies.values()],
  };
}

/** Cargo turns `-` into `_` for the name a crate is used by in code. */
export function externName(name: string): string {
  return name.replace(/-/g, '_');
}

/** True for `[dependencies]`, `[dev-dependencies]`, and `[target.'...'.dependencies]`. */
function isDependencySection(section: string): boolean {
  return /(?:^|\.)(?:dev-|build-)?dependencies$/.test(section) && !section.startsWith('workspace.');
}

/** The crate of a `[dependencies.name]` table header, if this section is one. */
function dependencyTable(section: string): string | null {
  if (section.startsWith('workspace.')) {
    return null;
  }
  return /(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(section)?.[1] ?? null;
}

function tomlString(value: string): string | undefined {
  return /^"([^"]*)"/.exec(value.trim())?.[1];
}

function parentOf(file: string): string {
  const index = file.lastIndexOf('/');
  return index === -1 ? '' : file.slice(0, index);
}
