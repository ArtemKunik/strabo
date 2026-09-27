import { run } from '../process.ts';

/**
 * One commit row from a bounded `git log`: the full hash, the short hash, the author date,
 * and the subject. Shared by the architecture-drift timeline and the coverage trend, which
 * read the same field order.
 */
export interface CommitRow {
  /** Full sha. */
  revision: string;
  /** 7-char short sha. */
  short: string;
  /** ISO author date, or `null` when the format recorded none. */
  date: string | null;
  subject: string | null;
}

/** The `git log` fields both readers request: full hash, short hash, author date, subject. */
export const COMMIT_LOG_FORMAT = '%H%x1f%h%x1f%aI%x1f%s';

/** The largest `git log` output either reader will buffer. */
export const COMMIT_LOG_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * The outcome of a bounded `git log`: the commits, or the reason git failed so the caller
 * can report it rather than an empty timeline.
 */
export type CommitLogResult =
  | { available: true; commits: CommitRow[] }
  | { available: false; reason: string };

/**
 * Read the most recent commits matching `args` through one bounded `git log`.
 *
 * A repository that is not a git repo, has no commits, or whose ref is bad is `available: false`
 * with a reason, never an empty list.
 */
export async function readCommits(
  root: string,
  args: readonly string[],
): Promise<CommitLogResult> {
  try {
    const { stdout } = await run(
      'git',
      ['log', `--format=${COMMIT_LOG_FORMAT}`, '-z', ...args],
      { cwd: root, maxBuffer: COMMIT_LOG_MAX_BUFFER },
    );
    return { available: true, commits: parseCommitLog(stdout) };
  } catch (error) {
    return { available: false, reason: gitLogFailureReason(error) };
  }
}

/**
 * Parse `git log --format=%H%x1f%h%x1f%aI%x1f%s -z`: records are NUL-separated (a trailing
 * NUL ends the last one), and fields inside a record are unit-separator separated.
 */
export function parseCommitLog(stdout: string): CommitRow[] {
  const commits: CommitRow[] = [];
  for (const record of stdout.split('\0')) {
    if (record === '') continue;
    const [revision = '', short = '', date = '', ...subjectParts] = record.split('\u001f');
    if (revision === '') continue;
    commits.push({
      revision,
      short,
      date: date === '' ? null : date,
      subject: subjectParts.length === 0 ? null : subjectParts.join('\u001f'),
    });
  }
  return commits;
}

/** Why a `git log` failed, in the small vocabulary the timelines report. */
export function gitLogFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/not a git repository|dubious ownership|not inside a Git working tree/i.test(message)) {
    return 'not-a-git-repository';
  }
  return 'git-log-failed';
}
