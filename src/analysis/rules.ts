import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { Graph } from '../types.ts';
import { relationshipOf } from './analysis.ts';
import { matchesGlob } from './glob.ts';
import type { StringEdgeReport } from './string-edges.ts';
import { DECLARED_GROUPS_FILE } from './units.ts';

/**
 * Declared architecture: an operator states which file sets may reach which, and the analysis
 * reports the observed edges that break the statement.
 *
 * The intent lives beside `strabo.groups.yml`. A violation is named with the rule, the edge,
 * and its evidence line; a rule whose globs match nothing is reported as unused rather than
 * silently passing, so a typo is visible instead of a false all-clear.
 */
export type RuleAllow = 'import' | 'never' | 'string';

/** One operator-stated rule: an edge from `from` files into `to` files. */
export interface DeclaredRule {
  id: string;
  /** Glob over file paths. */
  from: string;
  /** Glob over file paths. */
  to: string;
  allow: RuleAllow;
}

export interface RuleViolation {
  rule: string;
  from: string;
  to: string;
  edge: { source: string; target: string; kind: string; line: number; specifier: string };
  detail: string;
}

export interface RulesReport {
  available: boolean;
  reason?: string;
  rules: DeclaredRule[];
  /** Rule ids whose `from`/`to` matched no file at all. */
  unused: string[];
  violations: RuleViolation[];
  checkedEdges: number;
}

/** The file name the operator uses to declare architecture rules at the repository root. */
export const DECLARED_RULES_FILE = 'strabo.rules.yml';

/** The dedicated rules files, in search order, before the `rules` key of the groups file. */
const RULES_FILES = [DECLARED_RULES_FILE, 'strabo.rules'];

const ALLOWED: ReadonlySet<string> = new Set(['import', 'never', 'string']);

/** The edge kinds a string edge is drawn with, distinguishing it from an import edge. */
const STRING_KINDS: ReadonlySet<string> = new Set(['env', 'route', 'flag']);

/** One observed edge, normalised across the import and string-edge families. */
interface CandidateEdge {
  source: string;
  target: string;
  kind: string;
  line: number;
  specifier: string;
}

/**
 * Read declared rules from `strabo.rules.yml`, then `strabo.rules`, then the `rules:` key of
 * `strabo.groups.yml`.
 *
 * The first present file wins. Each entry needs a non-empty `id`, `from`, and `to`, and an
 * `allow` of `import`/`never`/`string`; anything else is skipped rather than invented. A
 * missing file or unparseable YAML returns no rules.
 */
export function readDeclaredRules(root: string): DeclaredRule[] {
  for (const file of RULES_FILES) {
    const content = readIfPresent(root, file);
    if (content !== null) {
      return extractRules(parseDocument(content));
    }
  }
  const groups = readIfPresent(root, DECLARED_GROUPS_FILE);
  if (groups === null) {
    return [];
  }
  return extractRules(parseDocument(groups));
}

/**
 * Check the observed edges of a graph against the declared rules.
 *
 * Two edge families are considered: recorded import/re-export edges (a `call` parallels an
 * import and is skipped, and module-declaration edges describe the tree rather than a
 * dependency), and the literal string edges of env vars, routes, and flags. A rule fires when
 * the edge's source matches `from` and its target matches `to`; `never` forbids any such edge,
 * `import` forbids only string edges, and `string` forbids only import edges.
 */
export function checkDeclaredRules(
  rules: readonly DeclaredRule[],
  graph: Graph,
  options?: { stringEdges?: StringEdgeReport | null },
): RulesReport {
  if (rules.length === 0) {
    return {
      available: false,
      reason: 'no declared rules',
      rules: [],
      unused: [],
      violations: [],
      checkedEdges: 0,
    };
  }

  const candidates: CandidateEdge[] = [
    ...importCandidates(graph),
    ...stringCandidates(options?.stringEdges ?? null),
  ];

  const violations: RuleViolation[] = [];
  for (const rule of rules) {
    for (const candidate of candidates) {
      if (!matchesGlob(candidate.source, rule.from)) {
        continue;
      }
      if (!matchesGlob(candidate.target, rule.to)) {
        continue;
      }
      const isString = STRING_KINDS.has(candidate.kind);
      const breaks =
        rule.allow === 'never' ||
        (rule.allow === 'import' && isString) ||
        (rule.allow === 'string' && !isString);
      if (!breaks) {
        continue;
      }
      violations.push({
        rule: rule.id,
        from: rule.from,
        to: rule.to,
        edge: {
          source: candidate.source,
          target: candidate.target,
          kind: candidate.kind,
          line: candidate.line,
          specifier: candidate.specifier,
        },
        detail:
          `${candidate.source} → ${candidate.target} (${candidate.kind}) violates ` +
          `${rule.id}: ${rule.from} may not reach ${rule.to}`,
      });
    }
  }
  violations.sort(
    (a, b) =>
      a.rule.localeCompare(b.rule) ||
      a.edge.source.localeCompare(b.edge.source) ||
      a.edge.target.localeCompare(b.edge.target) ||
      a.edge.line - b.edge.line,
  );

  const nodeIds = graph.nodes.map((node) => node.id);
  const unused = rules
    .filter((rule) => {
      const reachesFrom = nodeIds.some((id) => matchesGlob(id, rule.from));
      const reachesTo = nodeIds.some((id) => matchesGlob(id, rule.to));
      return !reachesFrom || !reachesTo;
    })
    .map((rule) => rule.id)
    .sort();

  return { available: true, rules: [...rules], unused, violations, checkedEdges: candidates.length };
}

/** Recorded import and re-export edges, with a `call` or a module declaration left out. */
function importCandidates(graph: Graph): CandidateEdge[] {
  const found: CandidateEdge[] = [];
  for (const edge of graph.edges) {
    if (edge.kind === 'call') {
      continue;
    }
    const relationship = relationshipOf(edge);
    if (relationship !== 'import' && relationship !== 're-export') {
      continue;
    }
    found.push({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      line: edge.evidence?.line ?? 0,
      specifier: edge.evidence?.specifier ?? '',
    });
  }
  return found;
}

/**
 * String edges as directed edges: one per reader→declaration pair when the key is declared.
 *
 * An undeclared key has no target, so it becomes a self edge from each reader only when at
 * least two readers share the key; a lone undeclared read records nothing rather than a guess.
 */
function stringCandidates(report: StringEdgeReport | null): CandidateEdge[] {
  if (report === null) {
    return [];
  }
  const found: CandidateEdge[] = [];
  for (const edge of [...report.env, ...report.routes, ...report.flags]) {
    if (edge.declarations.length > 0) {
      for (const reader of edge.readers) {
        for (const declaration of edge.declarations) {
          found.push({
            source: reader.file,
            target: declaration.file,
            kind: edge.kind,
            line: reader.line,
            specifier: edge.key,
          });
        }
      }
      continue;
    }
    if (edge.readers.length >= 2) {
      for (const reader of edge.readers) {
        found.push({
          source: reader.file,
          target: reader.file,
          kind: edge.kind,
          line: reader.line,
          specifier: edge.key,
        });
      }
    }
  }
  return found;
}

function parseDocument(content: string): unknown {
  try {
    return parseYaml(content);
  } catch {
    return null;
  }
}

function extractRules(parsed: unknown): DeclaredRule[] {
  const entries = (parsed as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(entries)) {
    return [];
  }
  const found: DeclaredRule[] = [];
  for (const entry of entries) {
    const record = entry as { id?: unknown; from?: unknown; to?: unknown; allow?: unknown };
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const from = typeof record.from === 'string' ? record.from.trim() : '';
    const to = typeof record.to === 'string' ? record.to.trim() : '';
    const allow = typeof record.allow === 'string' && ALLOWED.has(record.allow)
      ? (record.allow as RuleAllow)
      : null;
    if (id === '' || from === '' || to === '' || allow === null) {
      continue;
    }
    found.push({ id, from, to, allow });
  }
  return found;
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
