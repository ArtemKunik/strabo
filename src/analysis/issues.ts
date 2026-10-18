import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Declared issue classes: a symptom an operator reports, and the recording that ranks the
 * files which might explain it.
 *
 * A class is data, not code — declared under the `issues:` key of `strabo.groups.yml`, beside
 * `tiers:` and `rules:`, so an operator can add one without a release. A symptom that maps to
 * no class keeps the generic delegated task, unchanged.
 */

/** The reading a class ranks its candidates by. */
export type IssueRanking = 'retention' | 'compute' | 'change' | 'breakage';

export interface DeclaredIssue {
  name: string;
  /** The operator's symptom, verbatim, when one was declared. */
  symptom?: string;
  ranksBy: IssueRanking;
  /**
   * The signals of that reading the class cares about, **heaviest first** so the order doubles
   * as the severity weighting. Empty means every signal the reading records.
   */
  signals: string[];
}

const DECLARED_GROUPS_FILE = 'strabo.groups.yml';

export const ISSUE_RANKINGS: readonly IssueRanking[] = ['retention', 'compute', 'change', 'breakage'];

/**
 * The classes Strabo ships.
 *
 * `crash-memory` ranks by the retention reading (Phase 40); `slow-path` by the compute
 * signals the Functions tab already derives; `breakage` by the change reading. A built-in is
 * evidence-free by construction: it names which recording to read, not a verdict.
 */
export const BUILT_IN_ISSUES: readonly DeclaredIssue[] = [
  {
    name: 'crash-memory',
    symptom: 'the process dies or is killed outright, and memory is suspected',
    ranksBy: 'retention',
    signals: [
      'no-release-path',
      'unbounded-collection',
      'field-retained-resource',
      'listener-without-removal',
      'double-materialisation',
      'eager-load-on-validation',
    ],
  },
  {
    name: 'slow-path',
    symptom: 'something is slow, and the cost is suspected to be in the code',
    ranksBy: 'compute',
    signals: [
      'sort-in-loop',
      'linear-scan-in-loop',
      'nested-loops',
      'recursion',
      'high-complexity',
      'deep-nesting',
      'long-function',
      'many-parameters',
    ],
  },
  {
    name: 'breakage',
    symptom: 'something broke, most likely because of a change',
    ranksBy: 'change',
    signals: [],
  },
];

/** Read `issues:` from `strabo.groups.yml`. Malformed entries are skipped, never invented. */
export function readDeclaredIssues(root: string): DeclaredIssue[] {
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
  const issues = (parsed as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) {
    return [];
  }
  const found: DeclaredIssue[] = [];
  for (const entry of issues) {
    const record = entry as { name?: unknown; symptom?: unknown; ranksBy?: unknown; signals?: unknown };
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const ranksBy = record.ranksBy;
    if (name === '' || typeof ranksBy !== 'string' || !isRanking(ranksBy)) {
      continue;
    }
    const signals = Array.isArray(record.signals)
      ? record.signals.filter((signal): signal is string => typeof signal === 'string' && signal.trim() !== '')
      : [];
    found.push({
      name,
      ...(typeof record.symptom === 'string' && record.symptom.trim() !== ''
        ? { symptom: record.symptom.trim() }
        : {}),
      ranksBy,
      signals,
    });
  }
  return found;
}

/**
 * The classes in force: the built-ins, with a declared class of the same name replacing its
 * built-in and a new declared name appended. Sorted by name so the list is stable.
 */
export function resolveIssues(root: string): DeclaredIssue[] {
  const declared = readDeclaredIssues(root);
  const byName = new Map<string, DeclaredIssue>();
  for (const issue of [...BUILT_IN_ISSUES, ...declared]) {
    byName.set(issue.name, issue);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findIssue(issues: readonly DeclaredIssue[], name: string): DeclaredIssue | undefined {
  return issues.find((issue) => issue.name === name);
}

function isRanking(value: string): value is IssueRanking {
  return (ISSUE_RANKINGS as readonly string[]).includes(value);
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
