import { pushBranch } from './branch-actions.ts';
import { assertRepository, type ReviewResult } from './review.ts';
import { run } from '../process.ts';

/**
 * Commit the working tree, optionally pushing the current branch, from recorded evidence.
 *
 * This is the one place Strabo creates a commit. It is a write action, so it follows the
 * same rules as the branch actions: no value reaches a shell, the commit message is passed
 * as a `-m` argument, the process is time-bounded, credential prompts are disabled, and a
 * push is a normal (never forced) push through `pushBranch`, so a diverged branch is
 * reported rather than overwritten.
 *
 * The message is produced by the narrator route from recorded facts and confirmed by the
 * operator before it arrives here; this module never invents it.
 */

const ACTION_TIMEOUT_MS = 120_000;
const MAX_MESSAGE_CHARS = 8000;
/** Directories whose whole diff is noise in an evidence summary. */
const MAX_EVIDENCE_FILES = 200;

export type CommitReason = 'no-git' | 'git-error' | 'timeout' | 'nothing-to-commit' | 'empty-message';

export interface CommitSuccess {
  available: true;
  /** Short hash of the commit that was created. */
  commit: string;
  /** The commit's subject line, as Git recorded it. */
  subject: string;
  /** The branch the commit landed on, or null for a detached HEAD. */
  branch: string | null;
  /** How many files the commit touched. */
  files: number;
  /** True when the commit reached a remote. */
  pushed: boolean;
  /** One line for the status bar. */
  message: string;
  /** Why a push did not happen, when the commit itself succeeded. */
  pushReason?: string;
}

export interface CommitFailure {
  available: false;
  reason: CommitReason;
  detail: string;
}

export type CommitResult = CommitSuccess | CommitFailure;

/** Trim and bound a commit message; null when there is nothing to commit. */
export function normalizeCommitMessage(message: unknown): string | null {
  if (typeof message !== 'string') {
    return null;
  }
  const trimmed = message.replace(/\r\n/g, '\n').trim();
  if (trimmed === '') {
    return null;
  }
  return trimmed.length > MAX_MESSAGE_CHARS ? trimmed.slice(0, MAX_MESSAGE_CHARS) : trimmed;
}

/** One reviewed file as an evidence line, naming an uncounted file rather than a zero. */
function evidenceLine(file: NonNullable<Extract<ReviewResult, { available: true }>['files']>[number]): string {
  const rename = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
  const counts =
    file.insertions === null || file.deletions === null
      ? 'line counts unavailable'
      : `+${file.insertions} −${file.deletions}`;
  return `- ${file.status} · ${rename} · ${counts}`;
}

/**
 * The recorded facts a commit message is written from: every changed working-tree file with
 * its status and line counts, then the files that can reach them through the dependency
 * graph. Only recorded data is included; a section with nothing to say is omitted, not
 * filled in.
 */
export function buildCommitEvidence(review: ReviewResult): string {
  if (!review.available) {
    return '';
  }
  const files = review.files.slice(0, MAX_EVIDENCE_FILES);
  const lines: string[] = [];
  lines.push(`${review.totals.files} file(s) changed · +${review.totals.insertions} −${review.totals.deletions}`);
  lines.push('');
  lines.push('Changed files:');
  for (const file of files) {
    lines.push(evidenceLine(file));
  }
  if (review.files.length > files.length) {
    lines.push(`- …and ${review.files.length - files.length} more`);
  }
  const affected = review.impact.affected.filter((entry) => entry.distance > 0);
  if (affected.length > 0) {
    lines.push('');
    lines.push('Files that can reach the change through the dependency graph (potential impact):');
    for (const entry of affected.slice(0, MAX_EVIDENCE_FILES)) {
      lines.push(`- ${entry.id} (distance ${entry.distance})`);
    }
    if (affected.length > MAX_EVIDENCE_FILES) {
      lines.push(`- …and ${affected.length - MAX_EVIDENCE_FILES} more`);
    }
  }
  if (review.impact.outsideGraph.length > 0) {
    lines.push('');
    lines.push(`Changed paths outside the scanned graph: ${review.impact.outsideGraph.join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Create one commit over the whole working tree, then push the current branch.
 *
 * `git add -A` is deliberate: the action commits what the operator can see on the map,
 * including untracked files. `push` defaults on; a failed push still leaves the commit in
 * place and is reported, never rolled back.
 */
export async function commitWorkingTree(
  root: string,
  message: string,
  options: { push?: boolean } = {},
): Promise<CommitResult> {
  const push = options.push !== false;
  const normalized = normalizeCommitMessage(message);
  if (!normalized) {
    return { available: false, reason: 'empty-message', detail: 'A commit message is required.' };
  }
  try {
    await assertRepository(root);
  } catch (error) {
    return { available: false, reason: 'no-git', detail: firstLine(error) };
  }
  try {
    const status = await git(root, ['status', '--porcelain']);
    if (status.trim() === '') {
      return {
        available: false,
        reason: 'nothing-to-commit',
        detail: 'There are no working-tree changes to commit.',
      };
    }
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-m', normalized]);
    const commit = (await git(root, ['rev-parse', '--short', 'HEAD'])).trim();
    const subject = (await git(root, ['log', '-1', '--pretty=%s'])).trim();
    const files = (await git(root, ['show', '--name-only', '--format=', 'HEAD']))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean).length;
    const branch = (await gitValue(root, ['symbolic-ref', '-q', '--short', 'HEAD'])) || null;

    let pushed = false;
    let pushReason: string | undefined;
    let pushDetail = '';
    if (push) {
      if (!branch) {
        pushReason = 'not-current';
        pushDetail = 'HEAD is detached; the commit was not pushed.';
      } else {
        const result = await pushBranch(root, branch);
        if (result.available) {
          pushed = true;
          pushDetail = result.message;
        } else {
          pushReason = result.reason;
          pushDetail = result.detail;
        }
      }
    }

    const summary = pushed
      ? `Committed ${commit} and ${pushDetail.charAt(0).toLowerCase()}${pushDetail.slice(1)}`
      : `Committed ${commit}.${pushDetail ? ` ${pushDetail}` : ''}`;
    return {
      available: true,
      commit,
      subject,
      branch,
      files,
      pushed,
      message: summary,
      ...(pushReason ? { pushReason } : {}),
    };
  } catch (error) {
    return { available: false, reason: classifyFailure(error), detail: firstLine(error) };
  }
}

function classifyFailure(error: unknown): CommitReason {
  const failure = error as { killed?: boolean; signal?: string; message?: string };
  const message = failure.message ?? String(error);
  if (/not a git repository|not inside a Git working tree|dubious ownership/i.test(message)) return 'no-git';
  if (failure.killed || failure.signal === 'SIGTERM' || /timed? ?out/i.test(message)) return 'timeout';
  return 'git-error';
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n').map((line) => line.trim()).find(Boolean) ?? message;
}

async function gitValue(root: string, args: string[]): Promise<string> {
  try {
    return (await git(root, args)).trim();
  } catch {
    return '';
  }
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
    timeout: ACTION_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return String(stdout);
}
