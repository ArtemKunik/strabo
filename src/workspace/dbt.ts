import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { toPosix } from '../boundary/repository-root.ts';
import { excludedDirectory } from '../scan/exclusions.ts';
import type { DbtProject } from '../types.ts';

const MAX_BYTES = 2 * 1024 * 1024;

/** A `ref()` or `source()` a model declares, and the model that declares it. */
export interface DbtModelReference {
  repository: string;
  /** The repository-relative model file. */
  file: string;
  line: number;
  /** The referenced model or source table name. */
  target: string;
  kind: 'ref' | 'source';
  evidence: string;
}

/** A column a dbt model produces, read from its final `select` projection. */
export interface DbtModelColumn {
  repository: string;
  model: string;
  file: string;
  name: string;
}

export interface DbtExtraction {
  projects: DbtProject[];
  references: DbtModelReference[];
  columns: DbtModelColumn[];
}

/**
 * Detect dbt projects as units of their own (J12).
 *
 * A `dbt_project.yml` makes its directory (or the repository root) a dbt unit. Models, seeds,
 * snapshots, and macros are counted; `ref()` and `source()` become recorded lineage dependencies.
 * A `ref` built from a variable or a macro is left unresolved, named rather than guessed.
 */
export function extractDbt(root: string, repository: string): DbtExtraction {
  const projects: DbtProject[] = [];
  const references: DbtModelReference[] = [];
  const columns: DbtModelColumn[] = [];
  for (const manifest of findFiles(root, (name) => name === 'dbt_project.yml' || name === 'dbt_project.yaml')) {
    const projectRoot = path.posix.dirname(manifest) === '.' ? '.' : path.posix.dirname(manifest);
    const document = readYaml(root, manifest);
    const name = (document && typeof document.name === 'string' && document.name.trim() !== ''
      ? document.name.trim()
      : path.posix.basename(projectRoot === '.' ? repository : projectRoot)) || repository;

    const files = findFiles(root, () => true, projectRoot);
    const models = files.filter((file) => isUnder(file, projectRoot, 'models') && file.endsWith('.sql'));
    const seeds = files.filter((file) => isUnder(file, projectRoot, 'seeds'));
    const snapshots = files.filter((file) => isUnder(file, projectRoot, 'snapshots') && file.endsWith('.sql'));
    const schemaFiles = files.filter((file) => isUnder(file, projectRoot, 'models') && /\.ya?ml$/i.test(file));

    const sources: string[] = [];
    const exposures: DbtProject['exposures'] = [];
    for (const file of schemaFiles) {
      const schema = readYaml(root, file);
      if (!schema) {
        continue;
      }
      if (Array.isArray(schema.sources)) {
        for (const source of schema.sources) {
          if (isRecord(source) && typeof source.name === 'string') {
            sources.push(source.name);
          }
        }
      }
      if (Array.isArray(schema.exposures)) {
        for (const exposure of schema.exposures) {
          if (!isRecord(exposure) || typeof exposure.name !== 'string') {
            continue;
          }
          const dependsOn = isRecord(exposure.depends_on) && Array.isArray(exposure.depends_on.nodes)
            ? exposure.depends_on.nodes.filter((entry): entry is string => typeof entry === 'string')
            : [];
          exposures.push({ name: exposure.name, type: typeof exposure.type === 'string' ? exposure.type : null, dependsOn });
        }
      }
    }

    const unresolved: DbtProject['unresolved'] = [];
    for (const file of models) {
      const content = readText(root, file);
      if (content === null) {
        continue;
      }
      references.push(...referencesIn(file, repository, content, unresolved));
      const model = path.posix.basename(file, '.sql');
      for (const name of modelColumns(content)) {
        columns.push({ repository, model, file, name });
      }
    }

    projects.push({
      repository,
      root: projectRoot,
      name,
      modelCount: models.length,
      seedCount: seeds.length,
      snapshotCount: snapshots.length,
      sources: [...new Set(sources)].sort(),
      exposures: exposures.sort((a, b) => a.name.localeCompare(b.name)),
      unresolved,
    });
  }
  return {
    projects: projects.sort((a, b) => a.root.localeCompare(b.root)),
    references,
    columns: columns.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name)),
  };
}

/** The output columns of a model, read from the projection of its final `select`. */
function modelColumns(content: string): string[] {
  const withoutComments = content.replace(/--[^\n]*/g, '').replace(/\{\{[\s\S]*?\}\}/g, '');
  const matches = [...withoutComments.matchAll(/\bselect\b([\s\S]*?)\bfrom\b/gi)];
  const last = matches[matches.length - 1];
  if (!last) {
    return [];
  }
  const projection = last[1] ?? '';
  const columns: string[] = [];
  for (const item of projection.split(',')) {
    const trimmed = item.trim().replace(/\s+as\s+.*$/i, (alias) => alias).trim();
    const alias = /\bas\s+["`]?([A-Za-z_][\w$]*)["`]?\s*$/i.exec(trimmed)?.[1];
    const plain = /^(?:[\w$"`]+\.)?["`]?([A-Za-z_][\w$]*)["`]?$/.exec(trimmed)?.[1];
    const name = alias ?? plain;
    if (name && name !== '*') {
      columns.push(name.toLowerCase());
    }
  }
  return [...new Set(columns)];
}

/** `ref('x')`, `ref("x")`, `source('src', 'table')`; a variable argument is unresolved. */
function referencesIn(
  file: string,
  repository: string,
  content: string,
  unresolved: DbtProject['unresolved'],
): DbtModelReference[] {
  const references: DbtModelReference[] = [];
  for (const match of content.matchAll(/\b(ref|source)\s*\(([^)]*)\)/g)) {
    const kind = match[1] === 'source' ? 'source' : 'ref';
    const args = (match[2] ?? '').trim();
    const literals = [...args.matchAll(/['"]([^'"]+)['"]/g)].map((entry) => entry[1] ?? '');
    const line = countLines(content, match.index ?? 0) + 1;
    const argumentCount = args === '' ? 0 : args.split(',').length;
    if (kind === 'ref' && literals.length === 1 && argumentCount === 1) {
      references.push({ repository, file, line, target: literals[0] as string, kind, evidence: `dbt ref('${literals[0]}')` });
    } else if (kind === 'source' && literals.length === 2 && argumentCount === 2) {
      references.push({
        repository,
        file,
        line,
        target: `${literals[1]}`,
        kind,
        evidence: `dbt source('${literals[0]}', '${literals[1]}')`,
      });
    } else {
      unresolved.push({ file, line, text: match[0] });
    }
  }
  return references;
}

function isUnder(file: string, projectRoot: string, folder: string): boolean {
  const prefix = projectRoot === '.' ? `${folder}/` : `${projectRoot}/${folder}/`;
  return file === `${prefix}` || file.startsWith(prefix);
}

function readYaml(root: string, file: string): Record<string, unknown> | null {
  const content = readText(root, file);
  if (content === null) {
    return null;
  }
  try {
    const parsed = parseYaml(content) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function findFiles(root: string, predicate: (name: string) => boolean, subdirectory = '.'): string[] {
  const base = subdirectory === '.' ? root : path.join(root, subdirectory);
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
      if (predicate(entry.name)) {
        found.push(relative);
      }
    }
  };
  walk(base);
  return found.sort();
}

function countLines(content: string, index: number): number {
  let count = 0;
  for (let offset = content.indexOf('\n'); offset !== -1 && offset < index; offset = content.indexOf('\n', offset + 1)) {
    count += 1;
  }
  return count;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readText(root: string, file: string): string | null {
  try {
    const absolute = path.join(root, file);
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_BYTES) {
      return null;
    }
    const content = fs.readFileSync(absolute);
    return content.includes(0) ? null : content.toString('utf8');
  } catch {
    return null;
  }
}
