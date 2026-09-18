import fs from 'node:fs';
import path from 'node:path';

import { excludedDirectory } from '../scan/exclusions.ts';
import { normalize, tryCandidates, type ResolvedReference } from './index.ts';

/**
 * Non-relative specifier resolution for JS/TS: bundler root-relative paths,
 * `tsconfig.json`/`jsconfig.json` `paths` + `baseUrl`, and `package.json`
 * subpath `imports` (`#...`).
 *
 * Only recorded facts become edges. A specifier is "claimed" when it matches a
 * configured mechanism; claimed-but-missing targets are diagnostics, while pure
 * bare packages stay silent externals. Config discovery reads a bounded set of
 * small JSON files from inside the scanned tree only.
 */

const MAX_CONFIG_FILES = 25;
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_EXTENDS_DEPTH = 3;

interface TsPathsConfig {
  /** POSIX repo-relative directory of the config file. '' is the root. */
  configDir: string;
  /** POSIX repo-relative directory paths resolve against. */
  baseDir: string;
  patterns: PathPattern[];
  hasBaseUrl: boolean;
}

interface PackageImportsConfig {
  /** POSIX repo-relative directory of the package.json. '' is the root. */
  packageDir: string;
  imports: Record<string, unknown>;
}

export interface AliasTables {
  tsconfigs: TsPathsConfig[];
  packages: PackageImportsConfig[];
}

export interface AliasClaim {
  resolved: ResolvedReference | null;
  /** True when the specifier matched a configured mechanism and deserves a diagnostic on miss. */
  claimed: boolean;
}

function posixDirname(file: string): string {
  const index = file.lastIndexOf('/');
  return index === -1 ? '' : file.slice(0, index);
}

function readJson(root: string, relative: string): unknown | null {
  try {
    const absolute = path.join(root, ...relative.split('/'));
    const stat = fs.statSync(absolute);
    if (stat.size > MAX_CONFIG_BYTES) {
      return null;
    }
    return JSON.parse(fs.readFileSync(absolute, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const result = value.filter((entry): entry is string => typeof entry === 'string');
  return result.length > 0 ? result : null;
}

/** Follow `extends` (repo-relative only, bounded depth). Returns base-first chain. */
function configChain(
  root: string,
  relative: string,
  depth = 0,
  seen: Set<string> = new Set(),
): Array<{ dir: string; options: Record<string, unknown> }> {
  if (depth > MAX_EXTENDS_DEPTH || seen.has(relative)) {
    return [];
  }
  seen.add(relative);
  const parsed = asRecord(readJson(root, relative));
  const own = asRecord(parsed?.['compilerOptions']) ?? {};
  const dir = posixDirname(relative);
  const parentRef = parsed?.['extends'];
  if (typeof parentRef !== 'string' || !parentRef.startsWith('.')) {
    return [{ dir, options: own }];
  }
  const parentRelative = normalize(dir, parentRef);
  const withExtension = parentRelative.endsWith('.json') ? parentRelative : `${parentRelative}.json`;
  return [...configChain(root, withExtension, depth + 1, seen), { dir, options: own }];
}

interface EffectivePaths {
  baseDir: string;
  patterns: PathPattern[];
  hasBaseUrl: boolean;
}

/**
 * Child-most `paths` wins wholesale (TypeScript `extends` semantics); `baseUrl`
 * is resolved against the config file that declares it.
 */
function effectivePaths(chain: Array<{ dir: string; options: Record<string, unknown> }>): EffectivePaths | null {
  let pathsDef: { dir: string; value: Record<string, unknown> } | null = null;
  let baseUrlDef: { dir: string; value: string } | null = null;
  for (const entry of chain) {
    const rawPaths = asRecord(entry.options['paths']);
    if (rawPaths) {
      pathsDef = { dir: entry.dir, value: rawPaths };
    }
    const rawBaseUrl = entry.options['baseUrl'];
    if (typeof rawBaseUrl === 'string') {
      baseUrlDef = { dir: entry.dir, value: rawBaseUrl };
    }
  }
  if (!pathsDef && !baseUrlDef) {
    return null;
  }
  const baseDir = baseUrlDef ? normalize(baseUrlDef.dir, baseUrlDef.value) : (pathsDef?.dir ?? '');
  const patterns: PathPattern[] = [];
  if (pathsDef) {
    // Longest pattern first so `@/deep/*` wins over `@/*`.
    const keys = Object.keys(pathsDef.value).sort((a, b) => b.length - a.length);
    for (const key of keys) {
      const split = splitPattern(key);
      const targets = stringArray(pathsDef.value[key]);
      if (!split || !targets) {
        continue;
      }
      patterns.push({ ...split, targets });
    }
  }
  return { baseDir, patterns, hasBaseUrl: baseUrlDef !== null };
}

interface PathPattern {
  prefix: string;
  suffix: string;
  /** False for exact (star-less) patterns, which only match the full specifier. */
  star: boolean;
  targets?: string[];
}

function splitPattern(pattern: string): PathPattern | null {
  const star = pattern.indexOf('*');
  if (star === -1) {
    return { prefix: pattern, suffix: '', star: false };
  }
  if (pattern.indexOf('*', star + 1) !== -1) {
    return null;
  }
  return { prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), star: true };
}

/**
 * Discover path-mapping configs once per scan with a bounded walk.
 *
 * Config files are not source files, so they never appear in the retained set;
 * they are found on disk instead. Generated directories (node_modules, dist,
 * .git, …) are pruned with the same rule as the scanner, and reads stay inside
 * `root` by construction.
 */
export function loadAliasTables(root: string): AliasTables {
  const tables: AliasTables = { tsconfigs: [], packages: [] };

  const configs: string[] = [];
  const queue: string[] = [''];
  let visited = 0;
  while (queue.length > 0 && configs.length < MAX_CONFIG_FILES && visited < 500) {
    const dir = queue.shift() as string;
    visited += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, ...dir.split('/').filter(Boolean)), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const relative = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!entry.isSymbolicLink() && !excludedDirectory(relative)) {
          queue.push(relative);
        }
        continue;
      }
      if (
        entry.name === 'tsconfig.json' ||
        entry.name === 'jsconfig.json' ||
        entry.name === 'package.json'
      ) {
        configs.push(relative);
      }
    }
  }

  for (const file of configs.sort()) {
    const configDir = posixDirname(file);
    const base = file.slice(file.lastIndexOf('/') + 1);

    if (base === 'package.json') {
      const parsed = asRecord(readJson(root, file));
      const imports = asRecord(parsed?.['imports']);
      if (imports && Object.keys(imports).length > 0) {
        tables.packages.push({ packageDir: configDir, imports });
      }
      continue;
    }

    const effective = effectivePaths(configChain(root, file));
    // A baseUrl alone still resolves bare-ish specifiers, so keep the config.
    if (!effective) {
      continue;
    }
    tables.tsconfigs.push({
      configDir,
      baseDir: effective.baseDir,
      patterns: effective.patterns,
      hasBaseUrl: effective.hasBaseUrl,
    });
  }

  // Nearest config first: longest directory prefix wins per importing file.
  const byDepth = (a: string, b: string) => b.length - a.length;
  tables.tsconfigs.sort((a, b) => byDepth(a.configDir, b.configDir));
  tables.packages.sort((a, b) => byDepth(a.packageDir, b.packageDir));
  return tables;
}

/** Nearest config whose directory contains `from` (config at the file's own dir wins). */
function nearest<T extends { [K in Key]: string }, Key extends string>(
  configs: T[],
  key: Key,
  from: string,
): T | null {
  const dir = posixDirname(from);
  for (const config of configs) {
    const at = config[key];
    if (at === '' || dir === at || dir.startsWith(`${at}/`)) {
      return config;
    }
  }
  return null;
}

function matchPattern(pattern: PathPattern, specifier: string): string | null {
  if (!specifier.startsWith(pattern.prefix)) {
    return null;
  }
  if (!pattern.star) {
    return specifier === pattern.prefix ? '' : null;
  }
  // `*` matches across separators, so `@/a/b` maps under `src/*` to `src/a/b`.
  if (pattern.suffix !== '') {
    if (!specifier.endsWith(pattern.suffix)) {
      return null;
    }
    return specifier.slice(pattern.prefix.length, specifier.length - pattern.suffix.length);
  }
  return specifier.slice(pattern.prefix.length);
}

function substitute(target: string, star: string): string | null {
  if (!target.includes('*')) {
    return star === '' ? target : null;
  }
  return target.split('*').join(star);
}

/** Collect string leaves of an `imports` entry (conditional objects included). */
function importsTargets(entry: unknown): string[] {
  if (typeof entry === 'string') {
    return [entry];
  }
  if (Array.isArray(entry)) {
    return entry.filter((item): item is string => typeof item === 'string');
  }
  const record = asRecord(entry);
  if (!record) {
    return [];
  }
  return Object.values(record).flatMap(importsTargets);
}

/**
 * Resolve one non-relative specifier. Returns whether the specifier was
 * claimed by a configured mechanism alongside any resolved reference.
 */
export function resolveAliased(
  specifier: string,
  line: number,
  from: string,
  files: ReadonlySet<string>,
  tables: AliasTables,
): AliasClaim {
  // 1. Bundler root-relative (`/src/...` in Vite/webpack React apps).
  if (specifier.startsWith('/')) {
    const base = normalize('', specifier);
    const resolved = tryCandidates(base, specifier, line, files, 'root');
    return { resolved, claimed: true };
  }

  // 2. tsconfig/jsconfig `paths` (nearest config wins), then `baseUrl`.
  const tsconfig = nearest(tables.tsconfigs, 'configDir', from);
  if (tsconfig) {
    for (const pattern of tsconfig.patterns) {
      const captured = matchPattern(pattern, specifier);
      if (captured === null) {
        continue;
      }
      for (const template of pattern.targets ?? []) {
        const substituted = substitute(template, captured);
        if (substituted === null) {
          continue;
        }
        const resolved = tryCandidates(
          normalize(tsconfig.baseDir, substituted),
          specifier,
          line,
          files,
          'alias',
        );
        if (resolved) {
          return { resolved, claimed: true };
        }
      }
      return { resolved: null, claimed: true };
    }
    if (!specifier.startsWith('.') && !specifier.startsWith('#')) {
      const resolved = tryCandidates(
        normalize(tsconfig.baseDir, specifier),
        specifier,
        line,
        files,
        'alias',
      );
      if (resolved) {
        return { resolved, claimed: tsconfig.hasBaseUrl };
      }
      // baseUrl misses on bare packages stay silent: they are externals first.
      if (tsconfig.hasBaseUrl && specifier.includes('/')) {
        return { resolved: null, claimed: true };
      }
    }
  }

  // 3. package.json subpath `imports` (`#...`), nearest package wins.
  if (specifier.startsWith('#')) {
    const pkg = nearest(tables.packages, 'packageDir', from);
    if (pkg) {
      for (const [key, entry] of Object.entries(pkg.imports)) {
        if (!key.startsWith('#')) {
          continue;
        }
        const split = splitPattern(key);
        if (!split) {
          continue;
        }
        const captured = matchPattern(split, specifier);
        if (captured === null) {
          continue;
        }
        for (const target of importsTargets(entry)) {
          if (!target.startsWith('./')) {
            continue;
          }
          const substituted = substitute(target.slice(2), captured);
          if (substituted === null) {
            continue;
          }
          const resolved = tryCandidates(
            normalize(pkg.packageDir, substituted),
            specifier,
            line,
            files,
            'subpath-import',
          );
          if (resolved) {
            return { resolved, claimed: true };
          }
        }
        return { resolved: null, claimed: true };
      }
    }
    return { resolved: null, claimed: true };
  }

  return { resolved: null, claimed: false };
}
