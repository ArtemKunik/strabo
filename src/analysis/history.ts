import { run } from '../process.ts';

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
  /** Cap on the pairs whose commit list is retained; a pair past it is still co-change. */
  maxCoChangePairs?: number;
  /** Cap on the commits kept per pair, newest first. */
  maxKeptCommitsPerPair?: number;
}

/** A commit left out of co-change because it touched too many files. */
export interface SkippedCommit {
  hash: string;
  files: number;
}

/**
 * One commit behind a co-change pair: enough to name the evidence, never the diff.
 *
 * `subject` is truncated so one commit cannot bloat the summary.
 */
export interface CoChangeCommit {
  hash: string;
  /** Author date, `YYYY-MM-DD` in the author's own timezone. */
  date: string;
  subject: string;
}

/** Two files that changed in the same commits, with a bounded list of those commits. */
export interface CoChangePair {
  /** First endpoint, the smaller path. */
  a: string;
  /** Second endpoint, the larger path. */
  b: string;
  /** Commits the two shared, newest first, capped at `maxKeptCommitsPerPair`. */
  commits: CoChangeCommit[];
  /** Commits the two shared in the window; at least `commits.length`. */
  commitsShared: number;
}

export interface HistorySummary {
  /** Commits in the window that touched the file. */
  churn: Map<string, number>;
  /** Authors and commit count per file, first-seen author order. */
  authors: Map<string, { authors: string[]; commits: number }>;
  /** Files that changed in the same commit as the key, within the window. */
  coChange: Map<string, Set<string>>;
  /**
   * The commit evidence behind each 1-hop co-change pair, keyed by
   * `` `${file}\u0000${file}` `` with `file < file` so the pair is stored once.
   *
   * Absent for a pair whose commits were not retained (the pair cap was reached), so a
   * caller that reads it either finds the commits or draws no edge.
   */
  coChangeCommits: Map<string, CoChangePair>;
  windowDays: number;
  commitsScanned: number;
  /** Mass commits excluded from co-change, with how many files each touched. */
  skippedCommits: SkippedCommit[];
  /** How many commits a pair may keep; the report says so, and every edge carries ≤ this. */
  maxKeptCommitsPerPair: number;
  /** False when the directory is not a Git repository or `git` is unavailable. */
  available: boolean;
}

const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_MAX_FILES_PER_COMMIT = 50;
const DEFAULT_MAX_COMMITS = 2000;
/**
 * Evidence budget. On a 50k-file repository a window can hold ~10^5 co-change pairs and
 * ~4·10^5 pair-commit occurrences, so the discount rate is deliberate: a commit is kept
 * only when its pair is already known or the pair map is below the cap, and each pair
 * keeps at most `MAX_KEPT_COMMITS_PER_PAIR` commits. Heap words stay bounded by
 * `MAX_COCHANGE_PAIRS · (MAX_KEPT_COMMITS_PER_PAIR + 2)`, and the drop is counted so a
 * partial list is never mistaken for the whole.
 */
const DEFAULT_MAX_COCHANGE_PAIRS = 2000;
const DEFAULT_MAX_KEPT_COMMITS_PER_PAIR = 20;
const MAX_SUBJECT_LENGTH = 120;
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
    coChangeCommits: new Map(),
    windowDays,
    commitsScanned: 0,
    skippedCommits: [],
    maxKeptCommitsPerPair: DEFAULT_MAX_KEPT_COMMITS_PER_PAIR,
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
  const maxCoChangePairs = options.maxCoChangePairs ?? DEFAULT_MAX_COCHANGE_PAIRS;
  const maxKeptCommitsPerPair = options.maxKeptCommitsPerPair ?? DEFAULT_MAX_KEPT_COMMITS_PER_PAIR;

  let head: string;
  try {
    head = (await run('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  } catch {
    return emptySummary(windowDays, false);
  }

  const key = `${head}\u0000${windowDays}\u0000${maxFilesPerCommit}\u0000${maxCoChangePairs}\u0000${maxKeptCommitsPerPair}\u0000${hashFiles(files)}`;
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
        '--format=%x1e%H%x1f%an%x1f%ad%x1f%s',
        '--date=short',
        '--numstat',
      ],
      { cwd: root, maxBuffer: MAX_BUFFER },
    ));
  } catch {
    return emptySummary(windowDays, false);
  }

  const summary = parseHistory(
    stdout,
    new Set(files),
    windowDays,
    maxFilesPerCommit,
    maxCoChangePairs,
    maxKeptCommitsPerPair,
  );
  cache.set(key, summary);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return summary;
}

/**
 * Parse `--format=%x1e%H%x1f%an%x1f%ad%x1f%s --numstat` output: records split on \x1e,
 * header fields on \x1f, then one numstat line per file.
 *
 * A commit touching more than `maxFilesPerCommit` files is a mass change: it is reported
 * in `skippedCommits` and excluded from churn, authorship, and co-change alike, so a
 * rename or format commit cannot invent coupling. Old format output with no date or
 * subject still parses, with those fields empty rather than guessed.
 */
export function parseHistory(
  stdout: string,
  fileSet: ReadonlySet<string>,
  windowDays: number,
  maxFilesPerCommit: number,
  maxCoChangePairs = DEFAULT_MAX_COCHANGE_PAIRS,
  maxKeptCommitsPerPair = DEFAULT_MAX_KEPT_COMMITS_PER_PAIR,
): HistorySummary {
  const churn = new Map<string, number>();
  const authors = new Map<string, { authors: string[]; commits: number }>();
  const coChange = new Map<string, Set<string>>();
  const coChangeCommits = new Map<string, CoChangePair>();
  const foundPairs: string[] = [];
  const foundPairsSet = new Set<string>();
  const skippedCommits: SkippedCommit[] = [];
  let commitsScanned = 0;

  /** Record one commit against every pair it touched, still bounded by the evidence caps. */
  const addPairCommits = (changed: Set<string>, commit: CoChangeCommit): void => {
    const files = [...changed].sort();
    for (let left = 0; left < files.length; left += 1) {
      for (let rightFile = left + 1; rightFile < files.length; rightFile += 1) {
        const key = `${files[left]}\u0000${files[rightFile]}`;
        const pair = coChangeCommits.get(key);
        if (pair) {
          if (pair.commits.length < maxKeptCommitsPerPair) {
            pair.commits.push(commit);
          }
          continue;
        }
        // A pair past the cap keeps its co-change set membership but no commit list, so the
        // edge builder drops it rather than drawing an edge with no evidence.
        if (foundPairsSet.size >= maxCoChangePairs) {
          continue;
        }
        coChangeCommits.set(key, {
          a: files[left] as string,
          b: files[rightFile] as string,
          commits: [commit],
          commitsShared: 1,
        });
        foundPairsSet.add(key);
        foundPairs.push(key);
      }
    }
  };

  /** Churn and authorship count every commit; a mass commit is dropped from co-change only. */
  const applyCommit = (
    hash: string,
    author: string,
    date: string,
    subject: string,
    body: string,
    headerEnd: number,
  ): void => {
    commitsScanned += 1;

    const changed = new Set<string>();
    for (const line of headerEnd === -1 ? [] : body.slice(headerEnd + 1).split('\n')) {
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

    const touched = countNumstatPaths(body, headerEnd);
    if (touched > maxFilesPerCommit) {
      // A mass rename or format commit says nothing about coupling; report it, skip the join.
      skippedCommits.push({ hash, files: touched });
      return;
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
    addPairCommits(changed, { hash, date, subject });
  };

  for (const record of stdout.split('\u001e')) {
    const body = record.replace(/^\n+/, '');
    if (body === '') {
      continue;
    }
    const newline = body.indexOf('\n');
    const header = newline === -1 ? body : body.slice(0, newline);
    const [hash = '', author = '', date = '', ...rest] = header.split('\u001f');
    if (hash === '') {
      continue;
    }
    // `git log` walks newest first, so each pair's list is retained newest first.
    applyCommit(hash, author, date, rest.join('\u001f').slice(0, MAX_SUBJECT_LENGTH), body, newline);
  }

  for (const key of foundPairs) {
    const pair = coChangeCommits.get(key);
    if (pair) {
      pair.commitsShared = pair.commits.length;
    }
  }

  return {
    churn,
    authors,
    coChange,
    coChangeCommits,
    windowDays,
    commitsScanned,
    skippedCommits,
    maxKeptCommitsPerPair,
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
