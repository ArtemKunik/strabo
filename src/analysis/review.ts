import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Exclusion, Graph } from '../types.ts';
import { impactFromPaths, isSafeRevision, type ImpactResult } from './impact.ts';
import type { BranchDivergence, ChangePassport, ReviewGroup, ReviewFile, ReviewStatus } from './review-types.ts';
import type { TimelineCommit } from './timeline.ts';
import { classifyViewExclusion } from '../scan/exclusions.ts';

const run = promisify(execFile);

export type { BranchDivergence, CohesionChange, ReviewFile, ReviewGroup, ReviewStatus } from './review-types.ts';

export interface ReviewTotals {
  files: number;
  insertions: number;
  deletions: number;
  /** Paths Git reported as binary, or untracked files whose size was not counted. */
  uncounted: number;
}

export interface ReviewImpact {
  affected: ImpactResult['affected'];
  outsideGraph: string[];
}

export type ReviewResult =
  | {
      available: true;
      kind: 'commit' | 'working-tree' | 'branch';
      /** Present for commit and branch reviews. */
      ref?: string;
      /** The reviewed commit, or a branch's tip. */
      commit?: TimelineCommit;
      /** Present for branch reviews. */
      branch?: BranchDivergence;
      files: ReviewFile[];
      totals: ReviewTotals;
      impact: ReviewImpact;
      /**
       * Changed paths dropped from the review, each with the reason it was left out — a
       * generated bundle or a lockfile. Named rather than silently discarded.
       */
      excluded?: Exclusion[];
      /** Cohesion before/after for the changed files, when the caller computed it. */
      cohesion?: ChangePassport;
    }
  | {
      available: false;
      reason: 'no-git' | 'git-error' | 'unknown-revision';
      detail?: string;
    };

const STATUS_BY_LETTER: Record<string, ReviewStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
  U: 'unmerged',
};

/**
 * Review a commit's own changes.
 *
 * `git show --first-parent` is used rather than `<ref>^..<ref>` because it resolves for a
 * root commit, which has no parent to name, and reports a merge against its first parent.
 * Unlike a bare `<ref>` diff it never folds in uncommitted working-tree changes.
 */
export async function reviewCommit(
  root: string,
  graph: Graph,
  ref: string,
): Promise<ReviewResult> {
  if (!ref.trim()) {
    return { available: false, reason: 'unknown-revision', detail: 'A revision is required.' };
  }
  if (!isSafeRevision(ref)) {
    // Reported exactly like any other unresolvable ref — never a distinct "rejected"
    // shape, so a probing caller learns nothing about why it failed.
    return { available: false, reason: 'unknown-revision', detail: `Unknown revision "${ref}".` };
  }
  try {
    await assertRepository(root);
    const commit = await getCommit(root, ref);
    if (!commit) {
      return { available: false, reason: 'unknown-revision', detail: `Unknown revision "${ref}".` };
    }
    const [nameStatus, numstat] = await Promise.all([
      git(root, ['show', '--first-parent', '--format=', '--name-status', '-z', '-M', ref]),
      git(root, ['show', '--first-parent', '--format=', '--numstat', '-z', '-M', ref]),
    ]);
    const { files, excluded } = mergeChanges(
      parseNameStatus(nameStatus),
      parseNumstat(numstat),
      graph,
      'commit',
    );
    return {
      available: true,
      kind: 'commit',
      ref,
      commit,
      files,
      totals: totalChanges(files),
      impact: impactFor(graph, files),
      excluded,
    };
  } catch (error) {
    return gitFailure(error);
  }
}

/**
 * Review the working tree, split into staged and unstaged changes plus untracked files.
 *
 * Untracked files have no diff, so their line count is read directly; a file that cannot
 * be read as text stays uncounted rather than being reported as zero lines.
 */
export async function reviewWorkingTree(root: string, graph: Graph): Promise<ReviewResult> {
  try {
    await assertRepository(root);
    const [stagedStatus, stagedNumstat, unstagedStatus, unstagedNumstat, untracked] =
      await Promise.all([
        git(root, ['diff', '--cached', '-M', '--name-status', '-z']),
        git(root, ['diff', '--cached', '-M', '--numstat', '-z']),
        git(root, ['diff', '-M', '--name-status', '-z']),
        git(root, ['diff', '-M', '--numstat', '-z']),
        git(root, ['ls-files', '--others', '--exclude-standard', '-z']),
      ]);

    const staged = mergeChanges(parseNameStatus(stagedStatus), parseNumstat(stagedNumstat), graph, 'staged');
    const unstaged = mergeChanges(
      parseNameStatus(unstagedStatus),
      parseNumstat(unstagedNumstat),
      graph,
      'unstaged',
    );
    const excluded: Exclusion[] = [...staged.excluded, ...unstaged.excluded];
    const untrackedFiles = parseNullList(untracked).flatMap((file): ReviewFile[] => {
      const exclusion = classifyViewExclusion(file);
      if (exclusion) {
        excluded.push(exclusion);
        return [];
      }
      const lines = countLines(path.join(root, file));
      return [
        {
          path: file,
          status: 'untracked',
          group: 'untracked',
          insertions: lines,
          deletions: lines === null ? null : 0,
          inGraph: graph.nodes.some((node) => node.id === file),
        },
      ];
    });

    const files = [...staged.files, ...unstaged.files, ...untrackedFiles];
    return {
      available: true,
      kind: 'working-tree',
      files,
      totals: totalChanges(files),
      impact: impactFor(graph, files),
      excluded,
    };
  } catch (error) {
    return gitFailure(error);
  }
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

interface ParsedChange {
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

function toCount(value: string): number | null {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseNullList(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry !== '');
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

function impactFor(graph: Graph, files: ReviewFile[]): ReviewImpact {
  return impactFromPaths(
    graph,
    files.map((file) => file.path),
  );
}

/** Count lines in a readable text file; null when it is binary, missing, or too large. */
function countLines(file: string): number | null {
  const MAX_BYTES = 4 * 1024 * 1024;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) {
      return null;
    }
    const content = fs.readFileSync(file);
    if (content.includes(0)) {
      return null;
    }
    if (content.length === 0) {
      return 0;
    }
    const text = content.toString('utf8');
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return null;
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

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}
