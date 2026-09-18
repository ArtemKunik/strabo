import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface TimelineCommit {
  hash: string;
  shortHash: string;
  author: string;
  /** Author date, ISO 8601. */
  date: string;
  subject: string;
}

export type TimelineResult =
  | { available: true; commits: TimelineCommit[] }
  | { available: false; reason: 'no-git' | 'git-error'; detail?: string };

const FIELD_SEPARATOR = '\u001f';

/**
 * Recent commits, newest first.
 *
 * Git metadata being unavailable is reported explicitly rather than as an empty timeline,
 * so the UI can say "no history" instead of implying the repository has no commits.
 */
export async function getTimeline(root: string, limit = 30): Promise<TimelineResult> {
  try {
    const { stdout } = await run(
      'git',
      ['log', `-n${limit}`, `--pretty=format:%H${FIELD_SEPARATOR}%h${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s`],
      { cwd: root, maxBuffer: 8 * 1024 * 1024 },
    );
    return { available: true, commits: parseTimeline(stdout) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not a git repository|dubious ownership|does not have any commits/i.test(message)) {
      return { available: false, reason: 'no-git', detail: firstLine(message) };
    }
    return { available: false, reason: 'git-error', detail: firstLine(message) };
  }
}

/** Parse the `git log` output produced by {@link getTimeline}. */
export function parseTimeline(stdout: string): TimelineCommit[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash = '', shortHash = '', author = '', date = '', subject = ''] = line.split(FIELD_SEPARATOR);
      return { hash, shortHash, author, date, subject };
    })
    .filter((commit) => commit.hash.length > 0);
}

function firstLine(value: string): string {
  return value.split('\n')[0] ?? value;
}
