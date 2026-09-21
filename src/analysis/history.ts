import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * The git history measures behind the quality scorecard, in one bounded pass.
 *
 * A per-file `git log` (the previous shape) shells out once per module, and an unbounded
 * co-change query reads the whole history for every file. This reads the window once, caps
 * the files a commit may contribute to co-change, and caches by HEAD so a second request for
 * the same graph costs nothing.
 */
export interface HistoryOptions {
  /** How far back to look. */
  windowDays?: number;
  /** A commit touching more files than this is a mass change; it is reported, not joined. */
  maxFilesPerCommit?: number;
  /** Upper bound on commits read, so a long history cannot stall the request. */
  maxCommits?: number;
}

/** A commit left out of co-change because it touched too many files. */
export interface SkippedCommit {
  hash: string;
  files: number;
}

export interface HistorySummary {
  /** Commits in the window that touched the file. */
  churn: Map<string, number>;
  /** Authors and commit count per file, first-seen author order. */
  authors: Map<string, { authors: string[]; commits: number }>;
  /** Files that changed in the same commit as the key, within the window. */
  coChange: Map<string, Set<string>>;
  windowDays: number;
  commitsScanned: number;
  /** Mass commits excluded from co-change, with how many files each touched. */
  skippedCommits: SkippedCommit[];
  /** False when the directory is not a Git repository or `git` is unavailable. */
  available: boolean;
}

const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_MAX_FILES_PER_COMMIT = 50;
const DEFAULT_MAX_COMMITS = 2000;
const MAX_BUFFER = 64 * 1024 * 1024;
const CACHE_LIMIT = 4;

const cache = new Map<string, HistorySummary>();

/** Drop the cached summaries; tests call this so one case cannot read another's history. */
export function clearHistoryCache(): void {
  cache.clear();
}

function emptySummary(windowDays: number, available: boolean): HistorySummary {
  return {
    churn: new Map(),
    authors: new Map(),
    coChange: new Map(),
    windowDays,
    commitsScanned: 0,
    skippedCommits: [],
    available,
  };
}

/** Read churn, authorship, and co-change for the given files in one bounded `git log`. */
export async function collectHistory(
  root: string,
  files: readonly string[],
  options: HistoryOptions = {},
): Promise<HistorySummary> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const maxFilesPerCommit = options.maxFilesPerCommit ?? DEFAULT_MAX_FILES_PER_COMMIT;
  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;

  let head: string;
  try {
    head = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  } catch {
    return emptySummary(windowDays, false);
  }

  const key = `${head}\u0000${windowDays}\u0000${maxFilesPerCommit}\u0000${hashFiles(files)}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  let stdout: string;
  try {
    ({ stdout } = await run(
      'git',
      [
        'log',
        `--since=${windowDays} days ago`,
        `--max-count=${maxCommits}`,
        '--no-merges',
        '--format=%x1e%H%x1f%an',
        '--numstat',
      ],
      { cwd: root, maxBuffer: MAX_BUFFER },
    ));
  } catch {
    return emptySummary(windowDays, false);
  }

  const summary = parseHistory(stdout, new Set(files), windowDays, maxFilesPerCommit);
  cache.set(key, summary);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return summary;
}

/** Parse `--format=%x1e%H%x1f%an --numstat` output: records split on \x1e, fields on \x1f. */
export function parseHistory(
  stdout: string,
  fileSet: ReadonlySet<string>,
  windowDays: number,
  maxFilesPerCommit: number,
): HistorySummary {
  const churn = new Map<string, number>();
  const authors = new Map<string, { authors: string[]; commits: number }>();
  const coChange = new Map<string, Set<string>>();
  const skippedCommits: SkippedCommit[] = [];
  let commitsScanned = 0;

  for (const record of stdout.split('\u001e')) {
    const body = record.replace(/^\n+/, '');
    if (body === '') {
      continue;
    }
    const newline = body.indexOf('\n');
    const header = newline === -1 ? body : body.slice(0, newline);
    const [hash = '', author = ''] = header.split('\u001f');
    if (hash === '') {
      continue;
    }
    commitsScanned += 1;

    const changed = new Set<string>();
    for (const line of newline === -1 ? [] : body.slice(newline + 1).split('\n')) {
      const path = numstatPath(line);
      if (path !== null && fileSet.has(path)) {
        changed.add(path);
      }
    }

    for (const file of changed) {
      churn.set(file, (churn.get(file) ?? 0) + 1);
      const entry = authors.get(file) ?? { authors: [], commits: 0 };
      if (!entry.authors.includes(author)) {
        entry.authors.push(author);
      }
      entry.commits += 1;
      authors.set(file, entry);
    }

    const touched = countNumstatPaths(body, newline);
    if (touched > maxFilesPerCommit) {
      // A mass rename or format commit says nothing about coupling; report it, skip the join.
      skippedCommits.push({ hash, files: touched });
      continue;
    }
    for (const file of changed) {
      const partners = coChange.get(file) ?? new Set<string>();
      for (const other of changed) {
        if (other !== file) {
          partners.add(other);
        }
      }
      coChange.set(file, partners);
    }
  }

  return {
    churn,
    authors,
    coChange,
    windowDays,
    commitsScanned,
    skippedCommits,
    available: true,
  };
}

function countNumstatPaths(body: string, headerEnd: number): number {
  if (headerEnd === -1) {
    return 0;
  }
  let count = 0;
  for (const line of body.slice(headerEnd + 1).split('\n')) {
    if (numstatPath(line) !== null) {
      count += 1;
    }
  }
  return count;
}

/** The destination path of a numstat line, or null for a blank/rename-only marker. */
function numstatPath(line: string): string | null {
  const parts = line.split('\t');
  if (parts.length < 3) {
    return null;
  }
  let path = parts.slice(2).join('\t').trim();
  if (path === '' || path === '/dev/null') {
    return null;
  }
  if (path.includes(' => ')) {
    const brace = /^(.*)\{(.*?) => (.*?)\}(.*)$/.exec(path);
    if (brace) {
      path = `${brace[1]}${brace[3]}${brace[4]}`;
    } else {
      path = path.slice(path.lastIndexOf(' => ') + 4);
    }
  }
  return path.replace(/^"|"$/g, '');
}

function hashFiles(files: readonly string[]): string {
  let hash = 5381;
  for (const file of [...files].sort()) {
    for (let index = 0; index < file.length; index += 1) {
      hash = ((hash * 33) ^ file.charCodeAt(index)) >>> 0;
    }
    hash = ((hash * 33) ^ 0x1f) >>> 0;
  }
  return hash.toString(36);
}
