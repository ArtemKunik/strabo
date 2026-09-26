import type { Exclusion, Graph } from '../types.ts';
import type { ReviewGroup, ReviewFile, ReviewStatus } from './review-types.ts';
import type { TimelineCommit } from './timeline.ts';
import type { ReviewResult, ReviewTotals } from './review.ts';
import { isSafeRevision } from './impact.ts';
import { classifyViewExclusion } from '../scan/exclusions.ts';
import { run } from '../process.ts';

const STATUS_BY_LETTER: Record<string, ReviewStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
  U: 'unmerged',
};

export function toCount(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface ParsedChange {
  path: string;
  previousPath?: string;
  status: ReviewStatus;
}

/** Parse `git diff --name-status -z` output. Rename/copy entries carry two paths. */
export function parseNameStatus(stdout: string): ParsedChange[] {
  const tokens = stdout.split('\0');
  const changes: ParsedChange[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    const letter = token[0] ?? '';
    const status = STATUS_BY_LETTER[letter];
    if (!status) {
      continue;
    }
    if (status === 'renamed' || status === 'copied') {
      const previousPath = tokens[index + 1] ?? '';
      const nextPath = tokens[index + 2] ?? '';
      index += 2;
      if (nextPath) {
        changes.push({ path: nextPath, previousPath, status });
      }
      continue;
    }
    const filePath = tokens[index + 1] ?? '';
    index += 1;
    if (filePath) {
      changes.push({ path: filePath, status });
    }
  }
  return changes;
}

/** Parse `git diff --numstat -z` output into `path -> { insertions, deletions }`. */
export function parseNumstat(stdout: string): Map<string, { insertions: number | null; deletions: number | null }> {
  const tokens = stdout.split('\0');
  const counts = new Map<string, { insertions: number | null; deletions: number | null }>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    const fields = token.split('\t');
    if (fields.length < 3) {
      continue;
    }
    const insertions = toCount(fields[0] ?? '');
    const deletions = toCount(fields[1] ?? '');
    const inlinePath = fields.slice(2).join('\t');
    if (inlinePath) {
      counts.set(inlinePath, { insertions, deletions });
      continue;
    }
    // A rename prints an empty path, then the old and new paths as separate tokens.
    const nextPath = tokens[index + 2] ?? '';
    index += 2;
    if (nextPath) {
      counts.set(nextPath, { insertions, deletions });
    }
  }
  return counts;
}

/** A change set split into the files to review and the exclusions that dropped the rest. */
export interface MergedChanges {
  files: ReviewFile[];
  excluded: Exclusion[];
}

export function mergeChanges(
  changes: ParsedChange[],
  counts: Map<string, { insertions: number | null; deletions: number | null }>,
  graph: Graph,
  group: ReviewGroup,
): MergedChanges {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const excluded: Exclusion[] = [];
  const files = changes.flatMap((change): ReviewFile[] => {
    // Generated output (a built bundle, its source map, minified files) and lockfiles are
    // out of scope: they mirror or restate authored source, so reviewing them inflates
    // every change set. The exclusion is named so the drop is visible, not silent.
    const exclusion = classifyViewExclusion(change.path);
    if (exclusion) {
      excluded.push(exclusion);
      return [];
    }
    const stat = counts.get(change.path) ?? { insertions: null, deletions: null };
    return [
      {
        path: change.path,
        ...(change.previousPath ? { previousPath: change.previousPath } : {}),
        status: change.status,
        group,
        insertions: stat.insertions,
        deletions: stat.deletions,
        inGraph: nodeIds.has(change.path),
      },
    ];
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, excluded };
}

export function totalChanges(files: ReviewFile[]): ReviewTotals {
  let insertions = 0;
  let deletions = 0;
  let uncounted = 0;
  for (const file of files) {
    if (file.insertions === null || file.deletions === null) {
      uncounted += 1;
      continue;
    }
    insertions += file.insertions;
    deletions += file.deletions;
  }
  return { files: files.length, insertions, deletions, uncounted };
}

/** Read one commit's metadata, or null when the revision does not resolve. */
export async function getCommit(root: string, ref: string): Promise<TimelineCommit | null> {
  if (!isSafeRevision(ref)) {
    return null;
  }
  try {
    const stdout = await git(root, [
      'show',
      '-s',
      '--format=%H\u001f%h\u001f%an\u001f%aI\u001f%s',
      ref,
    ]);
    const line = stdout.split('\n').find((entry) => entry.trim() !== '');
    if (!line) {
      return null;
    }
    const [hash = '', shortHash = '', author = '', date = '', subject = ''] = line.split('\u001f');
    return hash ? { hash, shortHash, author, date, subject } : null;
  } catch {
    return null;
  }
}

/**
 * Fail early and clearly outside a repository.
 *
 * Without this, a non-repo `git diff --cached` exits with an option error rather than a
 * "not a git repository" message, which would be misreported as a generic git failure.
 */
export async function assertRepository(root: string): Promise<void> {
  try {
    const stdout = await git(root, ['rev-parse', '--is-inside-work-tree']);
    if (stdout.trim() !== 'true') {
      throw new Error(`"${root}" is not inside a Git working tree.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository|not inside a Git working tree/i.test(message)) {
      throw new NoGitError(message);
    }
    throw error;
  }
}

class NoGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoGitError';
  }
}

export function gitFailure(error: unknown): ReviewResult {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof NoGitError || /not a git repository|dubious ownership|does not have any commits/i.test(message)) {
    return { available: false, reason: 'no-git', detail: firstLine(message) };
  }
  return { available: false, reason: 'git-error', detail: firstLine(message) };
}

function firstLine(value: string): string {
  return value.split('\n')[0] ?? value;
}

export async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}
