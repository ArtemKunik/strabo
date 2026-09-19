import fs from 'node:fs';
import path from 'node:path';

import { excludedDirectory } from '../scan/exclusions.ts';
import type { Dependency } from '../types.ts';

/**
 * Read dependency manifests and lockfiles from a repository.
 *
 * A resolved lockfile is preferred over a manifest because only a lockfile names an exact
 * version, and OSV/deps.dev answer for exact versions. A manifest-only dependency keeps
 * `version: null` rather than being guessed from a range.
 */
export function readDependencies(root: string, files: readonly string[]): {
  dependencies: Dependency[];
  caveats: string[];
} {
  const dependencies: Dependency[] = [];
  const caveats: string[] = [];
  const present = new Set(files);

  const read = (relative: string): string | null => {
    try {
      return fs.readFileSync(path.join(root, relative), 'utf8');
    } catch {
      return null;
    }
  };

  for (const file of files) {
    if (file.endsWith('package-lock.json') || file.endsWith('npm-shrinkwrap.json')) {
      const content = read(file);
      if (content === null) {
        continue;
      }
      try {
        dependencies.push(...parseNpmLock(content, file));
      } catch {
        caveats.push(`Could not parse ${file}.`);
      }
      continue;
    }
  }

  // A package.json is only used when no lockfile already covers it.
  const lockfiles = new Set(
    dependencies.filter((entry) => entry.ecosystem === 'npm').map((entry) => path.dirname(entry.source)),
  );
  for (const file of files) {
    if (!file.endsWith('package.json') || file.endsWith('package-lock.json')) {
      continue;
    }
    if (lockfiles.has(path.dirname(file))) {
      continue;
    }
    const content = read(file);
    if (content === null) {
      continue;
    }
    try {
      dependencies.push(...parseNpmManifest(content, file));
    } catch {
      caveats.push(`Could not parse ${file}.`);
    }
  }

  for (const file of files) {
    if (!file.endsWith('Cargo.lock')) {
      continue;
    }
    const content = read(file);
    if (content === null) {
      continue;
    }
    const manifest = read(path.join(path.dirname(file), 'Cargo.toml').split(path.sep).join('/'));
    try {
      dependencies.push(...parseCargoLock(content, file, manifest));
    } catch {
      caveats.push(`Could not parse ${file}.`);
    }
  }

  for (const file of files) {
    if (!file.endsWith('pom.xml')) {
      continue;
    }
    const content = read(file);
    if (content === null) {
      continue;
    }
    try {
      const parsed = parseMavenPom(content, file);
      dependencies.push(...parsed.dependencies);
      caveats.push(...parsed.caveats);
    } catch {
      caveats.push(`Could not parse ${file}.`);
    }
  }

  return { dependencies: dedupe(dependencies), caveats };
}

interface ParsedNpmLockEntry {
  version?: string;
  dev?: boolean;
  dependencies?: Record<string, ParsedNpmLockEntry>;
  devDependencies?: Record<string, ParsedNpmLockEntry>;
}

/**
 * Parse `package-lock.json`.
 *
 * v2/v3 keep a flat `packages` map keyed by install path; v1 nests `dependencies`. Both are
 * handled because a repository may carry either.
 */
export function parseNpmLock(content: string, source: string): Dependency[] {
  const parsed = JSON.parse(content) as {
    lockfileVersion?: number;
    packages?: Record<string, ParsedNpmLockEntry>;
    dependencies?: Record<string, ParsedNpmLockEntry>;
  };
  const dependencies: Dependency[] = [];

  if (parsed.packages) {
    const rootEntry = parsed.packages[''] ?? {};
    const direct = new Set([
      ...Object.keys(rootEntry.dependencies ?? {}),
      ...Object.keys(rootEntry.devDependencies ?? {}),
    ]);
    const devNames = new Set(Object.keys(rootEntry.devDependencies ?? {}));
    for (const [installPath, entry] of Object.entries(parsed.packages)) {
      if (installPath === '') {
        continue;
      }
      const name = packageNameFromInstallPath(installPath);
      if (!name) {
        continue;
      }
      dependencies.push({
        ecosystem: 'npm',
        name,
        version: typeof entry.version === 'string' ? entry.version : null,
        source,
        direct: direct.has(name),
        ...(entry.dev === true || devNames.has(name) ? { dev: true } : {}),
      });
    }
    return dependencies;
  }

  if (parsed.dependencies) {
    for (const [name, entry] of walkNpmV1(parsed.dependencies)) {
      dependencies.push({
        ecosystem: 'npm',
        name,
        version: typeof entry.version === 'string' ? entry.version : null,
        source,
        direct: true,
        ...(entry.dev === true ? { dev: true } : {}),
      });
    }
  }
  return dependencies;
}

/** Recursively flatten a lockfile v1 dependency tree; nested names shadow their parent. */
function* walkNpmV1(
  tree: Record<string, ParsedNpmLockEntry>,
): Generator<[string, ParsedNpmLockEntry]> {
  for (const [name, entry] of Object.entries(tree)) {
    yield [name, entry];
    if (entry.dependencies) {
      yield* walkNpmV1(entry.dependencies);
    }
  }
}

/** `node_modules/a/node_modules/@scope/b` names the innermost package. */
function packageNameFromInstallPath(installPath: string): string | null {
  const marker = 'node_modules/';
  const index = installPath.lastIndexOf(marker);
  if (index === -1) {
    return null;
  }
  const name = installPath.slice(index + marker.length);
  return name === '' ? null : name;
}

/** Parse a `package.json` manifest. Versions are ranges, so they are left unresolved. */
export function parseNpmManifest(content: string, source: string): Dependency[] {
  const parsed = JSON.parse(content) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  const dependencies: Dependency[] = [];
  const add = (record: Record<string, string> | undefined, dev: boolean): void => {
    for (const name of Object.keys(record ?? {})) {
      dependencies.push({
        ecosystem: 'npm',
        name,
        version: null,
        source,
        direct: true,
        ...(dev ? { dev: true } : {}),
      });
    }
  };
  add(parsed.dependencies, false);
  add(parsed.optionalDependencies, false);
  add(parsed.peerDependencies, false);
  add(parsed.devDependencies, true);
  return dependencies;
}

interface CargoPackage {
  name: string;
  version: string;
}

/**
 * Parse `Cargo.lock` `[[package]]` blocks.
 *
 * A package with no `source` is a path/workspace member of this repository and is skipped:
 * it is local code, not an external dependency. Direct dependencies come from `Cargo.toml`
 * when it is available; without it every locked package is reported as transitive.
 */
export function parseCargoLock(
  content: string,
  source: string,
  manifest?: string | null,
): Dependency[] {
  const direct = manifest ? directCargoNames(manifest) : new Set<string>();
  const hasManifest = typeof manifest === 'string';
  const dependencies: Dependency[] = [];

  for (const block of content.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = matchTomlString(block, 'name');
    const version = matchTomlString(block, 'version');
    const hasSource = /^source\s*=/m.test(block);
    if (!name || !hasSource) {
      continue;
    }
    dependencies.push({
      ecosystem: 'cargo',
      name,
      version,
      source,
      direct: hasManifest ? direct.has(name) : false,
    });
  }

  return dependencies;
}

/** Names declared in `[dependencies]`, `[dev-dependencies]`, and `[build-dependencies]`. */
function directCargoNames(manifest: string): Set<string> {
  const names = new Set<string>();
  let inDependencySection = false;
  for (const rawLine of manifest.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[')) {
      inDependencySection = /^\[(?:dev-|build-)?dependencies\]/.test(line);
      continue;
    }
    if (!inDependencySection || line === '' || line.startsWith('#')) {
      continue;
    }
    const match = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (match) {
      names.add(match[1] ?? '');
    }
  }
  return names;
}

function matchTomlString(block: string, key: string): string | null {
  const match = new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm').exec(block);
  return match?.[1] ?? null;
}

interface MavenParse {
  dependencies: Dependency[];
  caveats: string[];
}

/**
 * Parse a Maven `pom.xml`.
 *
 * Only `<dependencies>` entries are read, with `${property}` substitution from the same
 * file. Maven resolves the full dependency tree from remote repositories, which Strabo
 * does not do, so these are *declared* versions — transitive dependencies are absent and
 * said so in the caveats.
 */
export function parseMavenPom(content: string, source: string): MavenParse {
  const properties = parseMavenProperties(content);
  const dependencies: Dependency[] = [];
  const caveats: string[] = [];

  const dependencyBlocks = [...content.matchAll(/<dependency\b[^>]*>([\s\S]*?)<\/dependency>/g)];
  for (const block of dependencyBlocks) {
    const body = block[1] ?? '';
    const groupId = resolveProperty(tag(body, 'groupId'), properties);
    const artifactId = resolveProperty(tag(body, 'artifactId'), properties);
    if (!groupId || !artifactId) {
      continue;
    }
    const scope = tag(body, 'scope');
    const optional = tag(body, 'optional') === 'true';
    if (scope === 'system' || optional) {
      continue;
    }
    dependencies.push({
      ecosystem: 'maven',
      name: `${groupId}:${artifactId}`,
      version: resolveProperty(tag(body, 'version'), properties),
      source,
      direct: true,
      ...(scope === 'test' ? { dev: true } : {}),
    });
  }

  if (dependencies.some((entry) => entry.version === null)) {
    caveats.push(
      `${source}: some declared versions use unresolved properties; those dependencies are listed without a version.`,
    );
  }

  return { dependencies, caveats };
}

function parseMavenProperties(content: string): Map<string, string> {
  const properties = new Map<string, string>();
  const block = /<properties>([\s\S]*?)<\/properties>/.exec(content);
  if (!block) {
    return properties;
  }
  for (const match of (block[1] ?? '').matchAll(/<([A-Za-z0-9_.-]+)>([^<]*)<\/\1>/g)) {
    properties.set(match[1] ?? '', (match[2] ?? '').trim());
  }
  return properties;
}

function resolveProperty(value: string | null, properties: Map<string, string>): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  const match = /^\$\{([^}]+)\}$/.exec(trimmed);
  if (!match) {
    return trimmed === '' ? null : trimmed;
  }
  return properties.get(match[1] ?? '') ?? null;
}

function tag(body: string, name: string): string | null {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(body);
  return match?.[1]?.trim() ?? null;
}

const MANIFEST_NAMES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'package.json',
  'Cargo.lock',
  'Cargo.toml',
  'pom.xml',
];

/**
 * Find dependency manifests under the repository root.
 *
 * Generated directories are pruned with the scanner's own rules, so a manifest inside
 * `node_modules` or `target` is never mistaken for the project's own dependency list.
 */
export function findManifestFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      const relative = toPosix(path.relative(root, absolute));
      if (entry.isDirectory()) {
        if (excludedDirectory(relative)) {
          continue;
        }
        walk(absolute);
        continue;
      }
      if (MANIFEST_NAMES.includes(entry.name)) {
        found.push(relative);
      }
    }
  };
  walk(root);
  return found.sort();
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

/** One package may appear in several manifests; keep the first resolved record per key. */
function dedupe(dependencies: Dependency[]): Dependency[] {
  const byKey = new Map<string, Dependency>();
  for (const dependency of dependencies) {
    const key = `${dependency.ecosystem}\u0000${dependency.name}`;
    const existing = byKey.get(key);
    if (!existing || (existing.version === null && dependency.version !== null)) {
      byKey.set(key, dependency);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name),
  );
}
