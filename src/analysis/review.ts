import fs from 'node:fs';
import path from 'node:path';

import type { Exclusion, Graph } from '../types.ts';
import { impactFromPaths, isSafeRevision, type ImpactResult } from './impact.ts';
import type { BranchDivergence, ChangePassport, ReviewGroup, ReviewFile, ReviewStatus } from './review-types.ts';
import type { TimelineCommit } from './timeline.ts';
import { classifyViewExclusion } from '../scan/exclusions.ts';
import {
  assertRepository,
  getCommit,
  git,
  gitFailure,
  mergeChanges,
  parseNameStatus,
  parseNumstat,
  totalChanges,
} from './review-git.ts';

export {
  assertRepository,
  getCommit,
  gitFailure,
  mergeChanges,
  parseNameStatus,
  parseNumstat,
  totalChanges,
} from './review-git.ts';
export type { MergedChanges, ParsedChange } from './review-git.ts';

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
      /**
       * The linked worktree this working-tree review was taken from. Absent for the main
       * root and for commit or branch reviews. `branch` is null when HEAD is detached.
       */
      worktree?: { path: string; branch: string | null };
    }
  | {
      available: false;
      reason: 'no-git' | 'git-error' | 'unknown-revision';
      detail?: string;
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

function parseNullList(stdout: string): string[] {
  return stdout.split('\0').filter((entry) => entry !== '');
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
