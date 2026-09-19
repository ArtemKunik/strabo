import fs from 'node:fs';
import path from 'node:path';

import { toPosix } from '../boundary/repository-root.ts';
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
  bundler: BundlerAliasConfig[];
}

/** One `vite.config` / `webpack.config` alias table; nearest config wins. */
export interface BundlerAliasConfig {
  /** POSIX repo-relative directory of the config file. '' is the root. */
  configDir: string;
  /** Longest find-prefix first. Replacement is POSIX repo-relative ('' = root). */
  entries: Array<{ find: string; replacement: string }>;
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
  const tables: AliasTables = { tsconfigs: [], packages: [], bundler: [] };
  const rootPosix = toPosix(path.resolve(root));

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
        entry.name === 'package.json' ||
        isBundlerConfig(entry.name)
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

    if (isBundlerConfig(base)) {
      const entries = parseBundlerAliases(readText(root, file), configDir, rootPosix);
      if (entries.length > 0) {
        tables.bundler.push({ configDir, entries });
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
  tables.bundler.sort((a, b) => byDepth(a.configDir, b.configDir));
  return tables;
}

function isBundlerConfig(base: string): boolean {
  return /^(vite|webpack)\.config\.[A-Za-z0-9]+$/.test(base);
}

function readText(root: string, relative: string): string | null {
  try {
    const absolute = path.join(root, ...relative.split('/'));
    const stat = fs.statSync(absolute);
    if (stat.size > MAX_CONFIG_BYTES) {
      return null;
    }
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

/* --------------------------------------- vite/webpack alias extraction */

/**
 * Extract `alias` tables from bundler configs without executing them.
 *
 * Only string-literal finds and path-like replacements are honoured
 * (plain `'@': './src'`, `path.resolve(__dirname, 'src')`,
 * `fileURLToPath(new URL('./src', import.meta.url))`, and the
 * `[{ find, replacement }]` array form). Anything computed is skipped rather
 * than guessed, and every replacement is confined to the repository.
 */
function parseBundlerAliases(
  text: string | null,
  configDir: string,
  rootPosix: string,
): Array<{ find: string; replacement: string }> {
  if (!text) {
    return [];
  }
  const region = extractAliasRegion(text);
  if (!region) {
    return [];
  }
  const entries = new Map<string, string>();

  for (const match of region.matchAll(
    /\{\s*find\s*:\s*(['"])(.*?)\1\s*,\s*replacement\s*:\s*([^}\n]+)\}/g,
  )) {
    const find = match[2];
    const raw = match[3];
    if (!find || raw === undefined) {
      continue;
    }
    const replacement = interpretReplacement(raw, configDir, rootPosix);
    if (replacement !== null) {
      entries.set(find, replacement);
    }
  }
  for (const match of region.matchAll(/(['"])([@~#][^'"]*?)\1\s*:\s*([^,\n}]+)/g)) {
    const find = match[2];
    const raw = match[3];
    if (!find || raw === undefined) {
      continue;
    }
    const replacement = interpretReplacement(raw, configDir, rootPosix);
    if (replacement !== null && !entries.has(find)) {
      entries.set(find, replacement);
    }
  }

  return [...entries.entries()]
    .sort((a, b) => b[0].length - a[0].length)
    .slice(0, 50)
    .map(([find, replacement]) => ({ find, replacement }));
}

/** The bracket-balanced object/array following the first `alias` keyword. */
function extractAliasRegion(text: string): string | null {
  const keyword = /\balias\b/.exec(text);
  if (!keyword) {
    return null;
  }
  const open = /[{[]/.exec(text.slice(keyword.index + keyword[0].length));
  if (!open) {
    return null;
  }
  const start = keyword.index + keyword[0].length + open.index;
  const closeFor: Record<string, string> = { '{': '}', '[': ']' };
  const stack = [open[0]];
  let quote: string | null = null;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      const want = closeFor[stack.pop() as string];
      if (ch !== want || stack.length === 0) {
        return ch === want ? text.slice(start, i + 1) : null;
      }
    }
  }
  return null;
}

/** Split call arguments on top-level commas; null when unparseable. */
function splitArgs(text: string): string[] | null {
  const args: string[] = [];
  let current = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote && text[i - 1] !== '\\') {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      current += ch;
      continue;
    }
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  args.push(current.trim());
  const cleaned = args.filter((arg) => arg !== '');
  return cleaned.length > 0 ? cleaned : null;
}

function unquote(value: string): string | null {
  const match = /^(['"])([\s\S]*)\1$/.exec(value.trim());
  const inner = match?.[2];
  return inner === undefined ? null : inner;
}

function isFsAbsolute(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:\//.test(value.replace(/\\/g, '/'));
}

/** Confine an absolute filesystem path to the repository; null on escape. */
function insideRoot(absolute: string, rootPosix: string): string | null {
  const forward = absolute.replace(/\\/g, '/');
  const rootDrive = /^[A-Za-z]:/.exec(rootPosix)?.[0]?.toLowerCase() ?? '';
  const valueDrive = /^[A-Za-z]:/.exec(forward)?.[0]?.toLowerCase() ?? '';
  if (rootDrive !== valueDrive) {
    return null;
  }
  const relative = path.posix.relative(rootPosix, forward);
  if (relative === '' || relative.startsWith('..')) {
    return null;
  }
  return normalize('', relative);
}

/** Interpret one replacement expression as a repo-relative POSIX path. */
function interpretReplacement(expr: string, configDir: string, rootPosix: string): string | null {
  const value = expr.trim().replace(/[,;]\s*$/, '');

  const literal = unquote(value);
  if (literal !== null) {
    return interpretPath(literal, configDir, rootPosix);
  }

  const fileUrl = /fileURLToPath\s*\(\s*new\s+URL\s*\(\s*(['"])(.*?)\1/.exec(value);
  if (fileUrl?.[2] !== undefined) {
    return interpretPath(fileUrl[2], configDir, rootPosix);
  }

  const call = /^(?:path\s*\.\s*)?(resolve|join)\s*\(([\s\S]*)\)\s*$/.exec(value);
  if (call) {
    const args = splitArgs(call[2] ?? '');
    if (!args) {
      return null;
    }
    let absolute: string | null = null;
    const parts: string[] = [];
    for (const arg of args) {
      if (arg === '__dirname') {
        absolute = null;
        parts.length = 0;
        parts.push(configDir);
        continue;
      }
      const part = unquote(arg);
      if (part === null) {
        return null;
      }
      if (isFsAbsolute(part)) {
        absolute = part.replace(/\\/g, '/');
        parts.length = 0;
        continue;
      }
      parts.push(part);
    }
    if (absolute !== null) {
      return insideRoot(absolute, rootPosix);
    }
    return normalize(configDir, parts.join('/'));
  }

  return null;
}

/** A path literal: repo-root-relative, config-relative, or inside-root absolute. */
function interpretPath(literal: string, configDir: string, rootPosix: string): string | null {
  const forward = literal.replace(/\\/g, '/');
  if (forward === '') {
    return null;
  }
  // Bundler convention: a leading `/` is relative to the served/dev root,
  // which Strabo models as the repository root.
  if (forward.startsWith('/')) {
    return normalize('', forward);
  }
  if (isFsAbsolute(forward)) {
    return insideRoot(forward, rootPosix);
  }
  // Config-relative, including bare `'src'` (the common webpack form).
  return normalize(configDir, forward);
}

/** Remainder after a bundler `find` prefix, or null when it does not apply. */
function matchBundlerFind(find: string, specifier: string): string | null {
  if (specifier === find) {
    return '';
  }
  if (find.endsWith('/')) {
    return specifier.startsWith(find) ? specifier.slice(find.length) : null;
  }
  return specifier.startsWith(`${find}/`) ? specifier.slice(find.length + 1) : null;
}

/** True when `configDir` contains the importing file. */
function isUnder(configDir: string, from: string): boolean {
  if (configDir === '') {
    return true;
  }
  const dir = posixDirname(from);
  return dir === configDir || dir.startsWith(`${configDir}/`);
}

/** Nearest config whose directory contains `from` (configs are pre-sorted nearest-first). */
function nearest<T>(configs: T[], dirOf: (config: T) => string, from: string): T | null {
  for (const config of configs) {
    if (isUnder(dirOf(config), from)) {
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

  // 2. tsconfig/jsconfig `paths` (nearest config wins).
  const tsconfig = nearest(tables.tsconfigs, (config) => config.configDir, from);
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
  }

  // 2b. Bundler aliases (`vite.config` / `webpack.config`). A repository
  // routinely carries several (app + storybook + migration leftovers), so every
  // containing table is tried nearest-first; the first textual match wins.
  if (!specifier.startsWith('.') && !specifier.startsWith('#')) {
    for (const config of tables.bundler) {
      if (!isUnder(config.configDir, from)) {
        continue;
      }
      let matched = false;
      for (const entry of config.entries) {
        const rest = matchBundlerFind(entry.find, specifier);
        if (rest === null) {
          continue;
        }
        matched = true;
        const base = rest === '' ? entry.replacement : normalize(entry.replacement, rest);
        const resolved = tryCandidates(base, specifier, line, files, 'alias');
        if (resolved) {
          return { resolved, claimed: true };
        }
        break;
      }
      if (matched) {
        return { resolved: null, claimed: true };
      }
    }
  }

  // 2c. `baseUrl` fallback for otherwise-unmatched specifiers.
  if (tsconfig) {
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
    const pkg = nearest(tables.packages, (config) => config.packageDir, from);
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
