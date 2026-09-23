import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { toPosix } from '../boundary/repository-root.ts';
import { excludedDirectory } from '../scan/exclusions.ts';
import type { Graph } from '../types.ts';
import { extractCallsFromContent, extractServiceEndpoints } from '../workspace/services.ts';
import { readWorkingFile } from './git-content.ts';

/**
 * Literal-only string edges: environment variables, HTTP routes declared versus called inside
 * one repository, and feature flags.
 *
 * A key is joined only when it is written as a string literal on both sides. A dynamic key is
 * never guessed at: it becomes a diagnostic, so an unresolvable read is visible without
 * fabricating an edge. Declarations come from a bounded walk of the repository's config files;
 * route declarations reuse the OpenAPI extractor the workspace analysis already uses.
 */

export type StringEdgeKind = 'env' | 'route' | 'flag';

/** One file and line where a key was read or declared. */
export interface StringEdgeSite {
  file: string;
  line: number;
}

/** One literal key with the places that read it and the places that declare it. */
export interface StringEdge {
  kind: StringEdgeKind;
  /** e.g. `DATABASE_URL`, `GET /users`, `new-checkout`. */
  key: string;
  /** Sorted by file then line. */
  readers: StringEdgeSite[];
  /** Sorted by file then line. */
  declarations: StringEdgeSite[];
  declared: boolean;
}

/** A dynamic or unresolved key: evidence, never an edge. */
export interface StringEdgeDiagnostic {
  file: string;
  line: number;
  message: string;
}

export interface StringEdgeReport {
  available: boolean;
  reason?: string;
  env: StringEdge[];
  routes: StringEdge[];
  flags: StringEdge[];
  diagnostics: StringEdgeDiagnostic[];
  totals: { env: number; routes: number; flags: number; unresolved: number };
}

/** Internal: a site still carrying the key it belongs to, before it is grouped. */
interface KeyedSite {
  file: string;
  line: number;
  key: string;
}

const MAX_WALK_DEPTH = 6;
const MAX_WALK_FILES = 2000;
const WALK_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', 'vendor']);

const ENV_NAME = '[A-Za-z_][A-Za-z0-9_]*';
const FLAG_NAME = '[A-Za-z_][A-Za-z0-9_.-]*';

/** Read patterns for environment variables. Group 1 is the literal key. */
const ENV_READ_SOURCES = [
  `\\bprocess\\.env\\.(${ENV_NAME})`,
  `\\bprocess\\.env\\s*\\[\\s*['"](${ENV_NAME})['"]\\s*\\]`,
  `\\bos\\.environ\\s*\\[\\s*['"](${ENV_NAME})['"]\\s*\\]`,
  `\\bos\\.environ\\.get\\s*\\(\\s*['"](${ENV_NAME})['"]`,
  `\\bos\\.getenv\\s*\\(\\s*['"](${ENV_NAME})['"]`,
  `\\bEnvironment\\.GetEnvironmentVariable\\s*\\(\\s*['"](${ENV_NAME})['"]`,
  `\\bstd::env::var\\s*\\(\\s*['"](${ENV_NAME})['"]`,
  `\\bSystem\\.getenv\\s*\\(\\s*['"](${ENV_NAME})['"]`,
  `\\bstd::getenv\\s*\\(\\s*['"](${ENV_NAME})['"]`,
  `\\bENV\\s*\\[\\s*['"](${ENV_NAME})['"]\\s*\\]`,
];

/** A bracket index whose first non-space character is not a quote: the key is dynamic. */
const ENV_DYNAMIC = /\b(?:process\.env|os\.environ)\s*\[\s*[^\s'"]/;

/** Read patterns for feature flags. Group 1 is the literal key. */
const FLAG_READ_SOURCES = [
  `\\b(?:isFeatureEnabled|getFeatureFlag|featureFlag|flags\\.get|FeatureFlag|isEnabled|flag)\\s*\\(\\s*['"](${FLAG_NAME})['"]`,
];

/**
 * Compute the literal string edges of one repository.
 *
 * The graph's nodes bound what is read as source; the config walk is depth- and count-bounded.
 * `available` is false only when the graph holds no nodes, so a caller can tell "nothing to
 * read" from "read and found nothing".
 */
export async function computeStringEdges(root: string, graph: Graph): Promise<StringEdgeReport> {
  if (graph.nodes.length === 0) {
    return {
      available: false,
      reason: 'the graph has no nodes to read',
      env: [],
      routes: [],
      flags: [],
      diagnostics: [],
      totals: { env: 0, routes: 0, flags: 0, unresolved: 0 },
    };
  }

  const envReads = new Map<string, KeyedSite[]>();
  const routeReads = new Map<string, KeyedSite[]>();
  const flagReads = new Map<string, KeyedSite[]>();
  const diagnostics: StringEdgeDiagnostic[] = [];

  for (const node of graph.nodes) {
    const content = readWorkingFile(root, node.id);
    if (content === null) {
      continue;
    }
    scanSource(node.id, content, envReads, routeReads, flagReads, diagnostics);
  }

  const envDeclarations = new Map<string, KeyedSite[]>();
  const flagDeclarations = new Map<string, KeyedSite[]>();
  for (const config of walkConfigFiles(root)) {
    if (isEnvCandidate(config.file)) {
      addAll(envDeclarations, extractEnvDeclarations(config.file, config.content));
    }
    if (/\.(json|ya?ml|properties)$/i.test(config.file)) {
      addAll(flagDeclarations, extractFlagDeclarations(config.file, config.content));
    }
  }

  const routeDeclarations = new Map<string, KeyedSite[]>();
  // Reuse the workspace OpenAPI extractor. It walks the repository itself and returns no line
  // number, so the declaration line is recovered by scanning the declaring file for the path.
  // A route is joined on the literal `METHOD /path` alone: the call's host is often relative
  // and the endpoint's host may be absent, so matching host as well would drop real edges.
  for (const endpoint of extractServiceEndpoints(root, path.basename(root))) {
    const content = readWorkingFile(root, endpoint.source);
    const line = content === null ? 1 : findPathLine(content, endpoint.path);
    const key = `${endpoint.method} ${endpoint.path}`;
    add(routeDeclarations, key, { file: endpoint.source, line, key });
  }

  const env = buildEdges('env', envReads, envDeclarations);
  const routes = buildEdges('route', routeReads, routeDeclarations);
  const flags = buildEdges('flag', flagReads, flagDeclarations);
  const sortedDiagnostics = sortDiagnostics(diagnostics);

  return {
    available: true,
    env,
    routes,
    flags,
    diagnostics: sortedDiagnostics,
    totals: {
      env: env.length,
      routes: routes.length,
      flags: flags.length,
      unresolved: sortedDiagnostics.length,
    },
  };
}

function scanSource(
  file: string,
  content: string,
  envReads: Map<string, KeyedSite[]>,
  routeReads: Map<string, KeyedSite[]>,
  flagReads: Map<string, KeyedSite[]>,
  diagnostics: StringEdgeDiagnostic[],
): void {
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const at = index + 1;
    for (const source of ENV_READ_SOURCES) {
      eachKey(line, source, (key) => add(envReads, key, { file, line: at, key }));
    }
    if (ENV_DYNAMIC.test(line)) {
      diagnostics.push({ file, line: at, message: 'not resolved: environment key is dynamic' });
    }
    for (const source of FLAG_READ_SOURCES) {
      eachKey(line, source, (key) => add(flagReads, key, { file, line: at, key }));
    }
  }

  for (const call of extractCallsFromContent(file, content)) {
    if (call.method === null || call.path === null) {
      continue;
    }
    const key = `${call.method} ${call.path}`;
    add(routeReads, key, { file, line: call.line, key });
  }
}

function eachKey(line: string, source: string, visit: (key: string) => void): void {
  for (const match of line.matchAll(new RegExp(source, 'g'))) {
    const key = match[1];
    if (key) {
      visit(key);
    }
  }
}

/** Config files are only read from the walk, which is depth- and count-bounded. */
interface ConfigFile {
  file: string;
  content: string;
}

function walkConfigFiles(root: string): ConfigFile[] {
  const found: ConfigFile[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH || found.length >= MAX_WALK_FILES) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= MAX_WALK_FILES) {
        return;
      }
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      const relative = toPosix(path.relative(root, absolute));
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRS.has(entry.name) || excludedDirectory(relative)) {
          continue;
        }
        walk(absolute, depth + 1);
        continue;
      }
      if (!isConfigCandidate(relative)) {
        continue;
      }
      const content = readWorkingFile(root, relative);
      if (content !== null) {
        found.push({ file: relative, content });
      }
    }
  };
  walk(root, 0);
  return found;
}

function isConfigCandidate(relative: string): boolean {
  if (isEnvCandidate(relative)) {
    return true;
  }
  const base = path.basename(relative).toLowerCase();
  return /\.(json|ya?ml|properties)$/.test(base) && /flags?|features/.test(base);
}

function isEnvCandidate(relative: string): boolean {
  const base = path.basename(relative).toLowerCase();
  if (base === '.env' || base.startsWith('.env.')) {
    return true;
  }
  if (base.endsWith('.properties')) {
    return true;
  }
  if (/^docker-compose.*\.ya?ml$/.test(base)) {
    return true;
  }
  return (
    /\.ya?ml$/.test(base) &&
    /(^|\/)(\.github|k8s|kube|deploy|charts|manifests)\//.test(relative.toLowerCase())
  );
}

/**
 * Environment keys declared by one config file.
 *
 * `.env`/properties files are flat key-value lists. A YAML file is only read inside an
 * `environment:` block, so a compose file's `version:` or `image:` is not mistaken for a key.
 */
function extractEnvDeclarations(file: string, content: string): KeyedSite[] {
  const base = path.basename(file).toLowerCase();
  const isYaml = base.endsWith('.yml') || base.endsWith('.yaml');
  const lines = content.split(/\r?\n/);
  const sites: KeyedSite[] = [];
  if (!isYaml) {
    for (let index = 0; index < lines.length; index += 1) {
      const trimmed = (lines[index] ?? '').trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        continue;
      }
      const match = /^(?:-\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*/.exec(trimmed);
      if (match?.[1]) {
        sites.push({ file, line: index + 1, key: match[1] });
      }
    }
    return sites;
  }

  let envIndent: number | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    if (envIndent !== null && indent <= envIndent) {
      envIndent = null;
    }
    if (/^environment:\s*$/.test(trimmed)) {
      envIndent = indent;
      continue;
    }
    if (envIndent === null) {
      continue;
    }
    const named = /^-\s*name:\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*$/.exec(trimmed);
    if (named?.[1]) {
      sites.push({ file, line: index + 1, key: named[1] });
      continue;
    }
    const pair = /^(?:-\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*/.exec(trimmed);
    // `name`/`value` are the structural keys of a compose list item, not variable names.
    if (pair?.[1] && !/^(name|value)$/.test(pair[1])) {
      sites.push({ file, line: index + 1, key: pair[1] });
    }
  }
  return sites;
}

/**
 * Feature-flag keys declared by one structured config file.
 *
 * Conservative: a key counts only when it contains `flag`, when it sits under a `flags:` /
 * `features:` mapping, or when the file itself is named for flags/features. The line number is
 * recovered by scanning the source lines for the key.
 */
function extractFlagDeclarations(file: string, content: string): KeyedSite[] {
  const base = path.basename(file).toLowerCase();
  const byName = /flags?|features/.test(base);
  const extension = path.extname(base);
  const lines = content.split(/\r?\n/);
  const keys = new Set<string>();

  if (extension === '.json') {
    try {
      collectFlagKeys(JSON.parse(content), false, byName, keys);
    } catch {
      // A document that does not parse declares nothing; the line scan below still runs.
    }
  } else if (extension === '.yaml' || extension === '.yml') {
    try {
      collectFlagKeys(parseYaml(content), false, byName, keys);
    } catch {
      // Same: an unparsable document is skipped, never guessed at.
    }
  } else if (extension === '.properties') {
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        continue;
      }
      const key = /^([A-Za-z0-9_.-]+)\s*[=:]/.exec(trimmed)?.[1];
      if (key && (byName || /flag/i.test(key))) {
        keys.add(key);
      }
    }
  }

  if (keys.size === 0) {
    return [];
  }

  const sites: KeyedSite[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? '').trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    for (const key of candidateKeys(trimmed)) {
      if (keys.has(key)) {
        sites.push({ file, line: index + 1, key });
      }
    }
  }
  return sites;
}

/** Every `key:`/`key=` token on one line, quoted or bare, so a compact JSON line is read too. */
function candidateKeys(line: string): string[] {
  const found = new Set<string>();
  for (const match of line.matchAll(/["']([A-Za-z0-9_.-]+)["']\s*:/g)) {
    if (match[1]) {
      found.add(match[1]);
    }
  }
  const bare = /^['"]?([A-Za-z0-9_.-]+)['"]?\s*[:=]/.exec(line);
  if (bare?.[1]) {
    found.add(bare[1]);
  }
  return [...found];
}

function collectFlagKeys(
  value: unknown,
  underFlagSection: boolean,
  all: boolean,
  out: Set<string>,
): void {
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const isSection = /^(flags?|features)$/i.test(key);
    if (!isSection && (all || underFlagSection || /flag/i.test(key))) {
      out.add(key);
    }
    collectFlagKeys(child, underFlagSection || isSection, all, out);
  }
}

/** The first line that names the endpoint path, or the longest suffix of it. */
function findPathLine(content: string, endpointPath: string): number {
  const lines = content.split(/\r?\n/);
  const candidates = [endpointPath, ...pathSuffixes(endpointPath)];
  for (const candidate of candidates) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`['"]?${escaped}['"]?\\s*:`);
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.test(lines[index] ?? '')) {
        return index + 1;
      }
    }
  }
  return 1;
}

/** Suffixes of a path, longest first, so a server prefix can be dropped to find the key. */
function pathSuffixes(endpointPath: string): string[] {
  const segments = endpointPath.split('/').filter(Boolean);
  const suffixes: string[] = [];
  for (let start = 1; start < segments.length; start += 1) {
    suffixes.push(`/${segments.slice(start).join('/')}`);
  }
  return suffixes;
}

function buildEdges(
  kind: StringEdgeKind,
  readers: Map<string, KeyedSite[]>,
  declarations: Map<string, KeyedSite[]>,
): StringEdge[] {
  const keys = new Set([...readers.keys(), ...declarations.keys()]);
  return [...keys]
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const reads = sortSites(readers.get(key) ?? []);
      const decls = sortSites(declarations.get(key) ?? []);
      return { kind, key, readers: reads, declarations: decls, declared: decls.length > 0 };
    });
}

function add(map: Map<string, KeyedSite[]>, key: string, site: KeyedSite): void {
  const list = map.get(key) ?? [];
  list.push(site);
  map.set(key, list);
}

function addAll(map: Map<string, KeyedSite[]>, sites: KeyedSite[]): void {
  for (const site of sites) {
    add(map, site.key, site);
  }
}

function sortSites(sites: KeyedSite[]): StringEdgeSite[] {
  const seen = new Set<string>();
  return sites
    .filter((site) => {
      const key = `${site.file}\u0000${site.line}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
    .map((site) => ({ file: site.file, line: site.line }));
}

function sortDiagnostics(diagnostics: StringEdgeDiagnostic[]): StringEdgeDiagnostic[] {
  const seen = new Set<string>();
  return diagnostics
    .filter((entry) => {
      const key = `${entry.file}\u0000${entry.line}\u0000${entry.message}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
