import path from 'node:path';

import { isInside } from '../boundary/repository-root.ts';
import { run } from '../process.ts';
import { assertRepository, gitFailure } from './review.ts';

/** One working tree of a repository: the main checkout or a linked `git worktree add`. */
export interface WorktreeSummary {
  /** Absolute path to the worktree root. */
  path: string;
  /** Checked-out commit, or null when Git printed none. */
  head: string | null;
  /** Short branch name, or null when HEAD is detached or the worktree is bare. */
  branch: string | null;
  /** The repository's main worktree: the selected root itself. */
  main: boolean;
  /** A bare or prunable worktree with no working directory to review. */
  bare: boolean;
}

export type WorktreesResult =
  | {
      available: true;
      /** The repository's main worktree first, then linked worktrees in Git's order. */
      worktrees: WorktreeSummary[];
    }
  | { available: false; reason: 'no-git' | 'git-error'; detail?: string };

/**
 * Every working tree attached to the repository at `root`.
 *
 * A coding agent often edits a linked worktree rather than the checked-out root, so the
 * Review surfaces need to name those trees before they can diff one. `git worktree list
 * --porcelain` is parsed rather than the aligned human output, so a path with spaces or a
 * non-ASCII branch name cannot shift the columns.
 */
export async function listWorktrees(root: string): Promise<WorktreesResult> {
  try {
    await assertRepository(root);
    const stdout = await git(root, ['worktree', 'list', '--porcelain']);
    return { available: true, worktrees: parseWorktrees(stdout, root) };
  } catch (error) {
    const failure = gitFailure(error);
    if (failure.available) {
      return { available: false, reason: 'git-error' };
    }
    return {
      available: false,
      reason: failure.reason === 'no-git' ? 'no-git' : 'git-error',
      ...(failure.detail ? { detail: failure.detail } : {}),
    };
  }
}

/**
 * Parse `git worktree list --porcelain`. Blocks are separated by a blank line and the first
 * block is the main worktree. `main` is decided by comparing the path with `mainRoot` rather
 * than by position, so a caller pointing at a linked worktree still marks the true main.
 */
export function parseWorktrees(stdout: string, mainRoot: string): WorktreeSummary[] {
  const main = path.resolve(mainRoot);
  const worktrees: WorktreeSummary[] = [];
  for (const block of stdout.split(/\r?\n\r?\n/)) {
    let worktreePath: string | null = null;
    let head: string | null = null;
    let branch: string | null = null;
    let bare = false;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('HEAD ')) {
        const value = line.slice('HEAD '.length).trim();
        head = /^[0-9a-f]{7,40}$/i.test(value) ? value : null;
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
      } else if (line === 'bare') {
        bare = true;
      }
    }
    if (!worktreePath) {
      continue;
    }
    const resolved = path.resolve(worktreePath);
    worktrees.push({
      path: resolved,
      head,
      branch: bare ? null : branch,
      main: samePath(resolved, main),
      bare,
    });
  }
  return worktrees;
}

/**
 * The repository worktree named by `requested`, or null when it is not one.
 *
 * The path must sit inside `ceiling` and match a working (non-bare) worktree Git lists, so a
 * caller cannot point a review at an arbitrary directory under the ceiling.
 */
export async function resolveWorktree(
  root: string,
  requested: string,
  ceiling: string,
): Promise<WorktreeSummary | null> {
  const candidate = path.resolve(requested);
  if (!isInside(candidate, ceiling)) {
    return null;
  }
  const result = await listWorktrees(root);
  if (!result.available) {
    return null;
  }
  return result.worktrees.find((entry) => !entry.bare && samePath(entry.path, candidate)) ?? null;
}

/** Windows paths compare case-insensitively; everywhere else a path is a byte string. */
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}
