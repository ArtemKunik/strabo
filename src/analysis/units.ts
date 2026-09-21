import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { toPosix } from '../boundary/repository-root.ts';
import { compressDirectoryChains, directoriesOf, parentDirectory as directoryParent } from './directory.ts';

/**
 * The build system that names a unit, strongest evidence first.
 *
 * A unit is a crate, package, module, or project, named by its own manifest rather than by
 * its path. The ecosystem is the manifest's, so a group's "why" can say where the name came
 * from. `root` is the repository-level fallback for files no manifest claims.
 */
export type SystemUnitEcosystem =
  | 'npm'
  | 'cargo'
  | 'maven'
  | 'gradle'
  | 'dotnet'
  | 'python'
  | 'go'
  | 'root'
  | 'declared';

/** One build unit: a manifest's directory, and the name it declares. */
export interface SystemUnit {
  /** Repository-relative directory that roots the unit; `.` is the repository root. */
  id: string;
  /** The crate/package/module name the manifest declares. */
  name: string;
  ecosystem: SystemUnitEcosystem;
  /** Manifest that named it, repository-relative; null for the root fallback. */
  manifest: string | null;
  /** The enclosing unit id when this unit nests inside another, else null. */
  parent: string | null;
  /** A one-line reason the unit exists, for the "why grouped" caption. */
  why: string;
  /** True when `strabo.groups.yml` declared the group rather than a manifest. */
  declared?: boolean;
  /** Derived units whose files this declared group took over. */
  overrides?: string[];
}

/** A group the operator declared in `strabo.groups.yml`. */
export interface DeclaredGroup {
  name: string;
  globs: string[];
}

/** The file name the operator uses to declare groups at the repository root. */
export const DECLARED_GROUPS_FILE = 'strabo.groups.yml';

/** A file the scan kept that is support rather than a system component. */
export interface Periphery {
  file: string;
  category: 'test' | 'script' | 'generated' | 'fixture';
  /** The rule that classified it, so the fold is explainable. */
  rule: string;
}

const MANIFEST_NAMES = [
  'package.json',
  'Cargo.toml',
  'pom.xml',
  'go.mod',
  'pyproject.toml',
  'build.gradle',
  'build.gradle.kts',
];

/**
 * Detect units from build manifests.
 *
 * Candidate directories are the ancestors of the scanned files, so a manifest is only read
 * where the scanner already saw source; nothing outside the graph is consulted. One unit per
 * directory, chosen in manifest-priority order, because two manifests sharing a directory
 * would otherwise give one file two owners. A file outside every unit falls into the root
 * unit, never dropped.
 */
export function detectUnits(
  root: string,
  files: readonly string[],
  repositoryName: string,
): SystemUnit[] {
  const units: SystemUnit[] = [];

  for (const directory of candidateDirectories(files)) {
    const manifest = readManifest(root, directory);
    if (manifest === null) {
      continue;
    }
    const id = directory === '' ? '.' : directory;
    units.push({ ...manifest, id, parent: null });
  }

  units.push({
    id: '.',
    name: repositoryName || 'repository',
    ecosystem: 'root',
    manifest: null,
    parent: null,
    why: 'the repository root: files no manifest claims',
  });
  // A manifest at the root and the root fallback would share the id; the manifest wins.
  const manifestRoot = units.find(
    (unit) => unit.id === '.' && unit.ecosystem !== 'root',
  );
  const resolved = manifestRoot
    ? units.filter((unit) => !(unit.id === '.' && unit.ecosystem === 'root'))
    : units;

  for (const unit of resolved) {
    unit.parent = enclosingUnit(unit.id, resolved);
  }
  return resolved.sort((a, b) => a.id.localeCompare(b.id) || a.ecosystem.localeCompare(b.ecosystem));
}

/** The unit a file belongs to: the longest enclosing unit root, else the root unit. */
export function assignUnits(
  files: readonly string[],
  units: readonly SystemUnit[],
): Map<string, string> {
  const roots = units
    .map((unit) => unit.id)
    .filter((id) => id !== '.')
    .sort((a, b) => b.length - a.length);
  const assignment = new Map<string, string>();
  for (const file of files) {
    const match = roots.find((id) => file === id || file.startsWith(`${id}/`));
    assignment.set(file, match ?? '.');
  }
  return assignment;
}

/**
 * Directory labels for the map, keyed by the directory a file sits in.
 *
 * Chain compression and unit anchoring are cheap wins that apply to the file map's islands
 * and to Directories-mode block labels alike: a directory that only hops through one child
 * drops out, and the surviving tail is anchored at the name its manifest declares. The
 * repository root stays `.` (the island layer renders it as `/`).
 */
export function buildDirectoryLabels(
  root: string,
  files: readonly string[],
  repositoryName: string,
): Record<string, string> {
  const units = detectUnits(root, files, repositoryName).map((unit) => ({
    id: unit.id,
    name: unit.name,
  }));
  const content = new Set(files.map((file) => directoryParent(file)));
  const labels = compressDirectoryChains(directoriesOf(files), (directory) => content.has(directory), units);
  return Object.fromEntries(labels);
}

/** Compress and anchor a set of block ids, where every id is content by definition. */
export function buildBlockLabels(
  root: string,
  files: readonly string[],
  repositoryName: string,
  blockIds: readonly string[],
): Record<string, string> {
  const units = detectUnits(root, files, repositoryName).map((unit) => ({
    id: unit.id,
    name: unit.name,
  }));
  return Object.fromEntries(compressDirectoryChains(blockIds, () => true, units));
}

/**
 * Read declared groups from `strabo.groups.yml` at the repository root.
 *
 * The shape is a `groups` list of `{ name, globs }`. A malformed file, a missing name, or a
 * group with no globs is ignored rather than inventing a group; a declared group is exempt
 * from `evidence over speculation` because the operator stated it.
 */
export function readDeclaredGroups(root: string): DeclaredGroup[] {
  const content = readIfPresent(root, DECLARED_GROUPS_FILE);
  if (content === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return [];
  }
  const groups = (parsed as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups)) {
    return [];
  }
  const found: DeclaredGroup[] = [];
  for (const entry of groups) {
    const record = entry as { name?: unknown; globs?: unknown };
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const globs = Array.isArray(record.globs)
      ? record.globs.filter((glob): glob is string => typeof glob === 'string' && glob.trim() !== '')
      : [];
    if (name === '' || globs.length === 0) {
      continue;
    }
    found.push({ name, globs });
  }
  return found;
}

/** A declared group's files override the manifest units that would have claimed them. */
export function applyDeclaredGroups(
  derived: readonly SystemUnit[],
  files: readonly string[],
  groups: readonly DeclaredGroup[],
): { units: SystemUnit[]; assignment: Map<string, string> } {
  if (groups.length === 0) {
    return { units: [...derived], assignment: assignUnits(files, derived) };
  }

  const base = assignUnits(files, derived);
  const matchers = groups.map((group) => ({
    group,
    patterns: group.globs.map((glob) => globToRegExp(glob)),
  }));
  const declaredUnits: SystemUnit[] = [];
  const assignment = new Map<string, string>();

  for (const file of files) {
    const match = matchers.find((entry) => entry.patterns.some((pattern) => pattern.test(file)));
    if (match) {
      assignment.set(file, match.group.name);
    } else {
      assignment.set(file, base.get(file) ?? '.');
    }
  }

  for (const { group } of matchers) {
    const members = files.filter((file) => assignment.get(file) === group.name);
    if (members.length === 0) {
      continue;
    }
    const takenFrom = [
      ...new Set(members.map((file) => base.get(file) ?? '.').filter((id) => id !== group.name)),
    ].sort();
    declaredUnits.push({
      id: group.name,
      name: group.name,
      ecosystem: 'declared',
      manifest: DECLARED_GROUPS_FILE,
      parent: null,
      declared: true,
      overrides: takenFrom.length > 0 ? takenFrom : undefined,
      why: `declared group \`${group.name}\` (${DECLARED_GROUPS_FILE})`,
    });
  }

  // Derived units keep only the files the declared groups did not claim.
  const derivedKept = derived
    .map((unit) => ({ ...unit }))
    .filter((unit) => files.some((file) => assignment.get(file) === unit.id));
  return { units: [...declaredUnits, ...derivedKept], assignment };
}

/** A glob with `**` (any depth), `*` (one segment), and `?` (one character). */
function globToRegExp(glob: string): RegExp {
  const pattern = glob.replace(/\\/g, '/');
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` also matches zero directories, so `src/**` matches `src/a.ts`.
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(character)) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }
  return new RegExp(`^${source}$`);
}

/** Classify a scanned file as support, with the first rule that matched. */
export function classifyPeriphery(file: string, kind: string): Periphery | null {
  const lower = file.toLowerCase();

  if (kind === 'test') {
    return { file, category: 'test', rule: 'the scanner marked it a test' };
  }
  // Fixtures are checked before the test path rule: a file under `test/fixtures` is data
  // the tests read, not a test, and folding it with the suite would hide that.
  if (/(^|\/)(fixtures?|__fixtures__|testdata|test-data)\//.test(lower)) {
    return { file, category: 'fixture', rule: 'fixture or testdata directory' };
  }
  if (/(^|\/)(tests?|__tests__|spec|specs)\//.test(lower) || /\.(test|spec)\.[^/]+$/.test(lower)) {
    return { file, category: 'test', rule: 'test path or file suffix' };
  }
  if (
    /(^|\/)(generated|gen|__generated__)\//.test(lower) ||
    /\.(generated|g|designer)\.[^/]+$/.test(lower) ||
    /_pb2?\.(py|go|rb|js|ts)$/.test(lower)
  ) {
    return { file, category: 'generated', rule: 'generated path or file suffix' };
  }
  if (
    /^(scripts?|bin|tools?)\//.test(lower) ||
    /\.(sh|ps1|bat|cmd|bash|zsh)$/.test(lower)
  ) {
    return { file, category: 'script', rule: 'script directory or extension' };
  }
  return null;
}

/** Partition files into their periphery categories, dropping the ones that are components. */
export function classifyPeripheryAll(
  files: readonly string[],
  kindOf: (file: string) => string,
): Periphery[] {
  const found: Periphery[] = [];
  for (const file of files) {
    const periphery = classifyPeriphery(file, kindOf(file));
    if (periphery) {
      found.push(periphery);
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

function candidateDirectories(files: readonly string[]): string[] {
  const directories = new Set<string>(['']);
  for (const file of files) {
    let current = parentDirectory(file);
    while (true) {
      directories.add(current);
      if (current === '') {
        break;
      }
      current = parentDirectory(current);
    }
  }
  return [...directories].sort((a, b) => a.localeCompare(b));
}

function parentDirectory(file: string): string {
  const index = file.lastIndexOf('/');
  return index === -1 ? '' : file.slice(0, index);
}

function enclosingUnit(id: string, units: readonly SystemUnit[]): string | null {
  if (id === '.') {
    return null;
  }
  let best: string | null = null;
  for (const unit of units) {
    if (unit.id === id) {
      continue;
    }
    // The root unit encloses every non-root unit; a nearer manifest overrides it.
    const encloses = unit.id === '.' ? id !== '.' : id.startsWith(`${unit.id}/`);
    if (!encloses) {
      continue;
    }
    if (best === null || unit.id.length > best.length || (best === '.' && unit.id !== '.')) {
      best = unit.id;
    }
  }
  return best;
}

interface ManifestName {
  name: string;
  ecosystem: SystemUnitEcosystem;
  manifest: string;
  why: string;
}

function readManifest(root: string, directory: string): ManifestName | null {
  for (const candidate of MANIFEST_NAMES) {
    const relative = join(directory, candidate);
    const content = readIfPresent(root, relative);
    if (content === null) {
      continue;
    }
    const parsed = parseManifest(candidate, relative, directory, content, root);
    if (parsed) {
      return parsed;
    }
  }
  const csproj = firstCsproj(root, directory);
  if (csproj) {
    return {
      name: path.basename(csproj, path.extname(csproj)),
      ecosystem: 'dotnet',
      manifest: csproj,
      why: `dotnet project \`${path.basename(csproj)}\``,
    };
  }
  return null;
}

function parseManifest(
  candidate: string,
  relative: string,
  directory: string,
  content: string,
  root: string,
): ManifestName | null {
  const fallbackName = directory === '' ? path.basename(root) : path.basename(directory);
  if (candidate === 'package.json') {
    const name = jsonString(content, 'name') ?? fallbackName;
    return { name, ecosystem: 'npm', manifest: relative, why: `npm package \`${name}\` (${relative})` };
  }
  if (candidate === 'Cargo.toml') {
    const name = sectionString(content, 'package', 'name');
    if (!name) {
      // A workspace-only manifest names no crate; members own the files.
      return null;
    }
    return { name, ecosystem: 'cargo', manifest: relative, why: `crate \`${name}\` (${relative})` };
  }
  if (candidate === 'pom.xml') {
    const name = firstTag(content, 'artifactId') ?? fallbackName;
    return { name, ecosystem: 'maven', manifest: relative, why: `Maven module \`${name}\` (${relative})` };
  }
  if (candidate === 'go.mod') {
    const module = /^module\s+(\S+)/m.exec(content)?.[1] ?? fallbackName;
    const name = module.split('/').filter(Boolean).pop() ?? module;
    return { name, ecosystem: 'go', manifest: relative, why: `Go module \`${module}\` (${relative})` };
  }
  if (candidate === 'pyproject.toml') {
    const name = sectionString(content, 'project', 'name') ?? sectionString(content, 'tool.poetry', 'name');
    if (!name) {
      return null;
    }
    return { name, ecosystem: 'python', manifest: relative, why: `Python project \`${name}\` (${relative})` };
  }
  if (candidate === 'build.gradle' || candidate === 'build.gradle.kts') {
    const settings = readIfPresent(root, join(directory, candidate === 'build.gradle' ? 'settings.gradle' : 'settings.gradle.kts'));
    const name = (settings ? /rootProject\.name\s*=\s*['"]([^'"]+)['"]/.exec(settings)?.[1] : undefined) ?? fallbackName;
    return { name, ecosystem: 'gradle', manifest: relative, why: `Gradle project \`${name}\` (${relative})` };
  }
  return null;
}

function firstCsproj(root: string, directory: string): string | null {
  const absolute = path.join(root, directory);
  try {
    const entry = fs
      .readdirSync(absolute, { withFileTypes: true })
      .filter((item) => item.isFile() && item.name.toLowerCase().endsWith('.csproj'))
      .sort((a, b) => a.name.localeCompare(b.name))[0];
    return entry ? join(directory, entry.name) : null;
  } catch {
    return null;
  }
}

function readIfPresent(root: string, relative: string): string | null {
  try {
    const absolute = path.join(root, relative);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) {
      return null;
    }
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

function join(directory: string, name: string): string {
  const relative = directory === '' ? name : `${directory}/${name}`;
  return toPosix(relative);
}

function jsonString(content: string, key: string): string | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return typeof parsed[key] === 'string' && parsed[key] !== '' ? (parsed[key] as string) : null;
  } catch {
    return null;
  }
}

/** Read `key` from a TOML `[section]`, e.g. `[package] name = "x"`. */
function sectionString(content: string, section: string, key: string): string | null {
  const header = new RegExp(`^\\[${section.replace(/[.]/g, '\\.')}\\]\\s*$`, 'm');
  const start = header.exec(content);
  if (!start) {
    return null;
  }
  const rest = content.slice(start.index + start[0].length);
  const nextSection = /^\s*\[/m.exec(rest);
  const body = nextSection ? rest.slice(0, nextSection.index) : rest;
  const hit = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(body);
  return hit?.[1] ?? null;
}

function firstTag(content: string, tag: string): string | null {
  return new RegExp(`<${tag}>\\s*([^<]+?)\\s*</${tag}>`).exec(content)?.[1] ?? null;
}
