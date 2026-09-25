import { readWorkingFile } from './git-content.ts';
import { isSafeRevision } from './impact.ts';
import { run } from '../process.ts';

/**
 * Reading one file's change for the in-page viewer.
 *
 * A unified diff is parsed into numbered lines rather than handed over as raw text, so the
 * viewer can pair old and new line numbers without re-deriving them. Every failure is named
 * (`no-git`, `unknown-revision`, `unreadable`) rather than reported as an empty change: an
 * empty diff means the two sides are equal, which is a different fact from "could not read".
 */


export type DiffLineKind = 'context' | 'add' | 'del';

/** One line of a hunk, with the line number it holds on each side of the change. */
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number in the old version; null on an added line. */
  oldLine: number | null;
  /** 1-based line number in the new version; null on a removed line. */
  newLine: number | null;
}

export interface DiffHunk {
  /** The `@@ … @@` header exactly as Git printed it. */
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

/** One file's change, parsed into hunks. `hunks` is empty when the sides are equal. */
export interface FileDiff {
  file: string;
  /** Git's own leading lines (`index`, modes, `---`, `+++`), kept for the raw reading. */
  header: string[];
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** True when Git marked the file binary, so there are no hunks to show. */
  binary: boolean;
}

/** Which pair of versions a diff was taken between. */
export type DiffSide = 'commit' | 'range' | 'staged' | 'unstaged' | 'untracked';

export interface DiffSpec {
  file: string;
  /** One commit against its first parent; resolves for a root commit. */
  ref?: string;
  /** `head` against `base`; `head` defaults to the working tree. */
  base?: string;
  head?: string;
  /** The index against the working tree's staged side. */
  staged?: boolean;
  /** A path Git does not track: there is no diff, so the whole file reads as an addition. */
  untracked?: boolean;
}

export type FileDiffResult =
  | { available: true; file: string; side: DiffSide; diff: FileDiff }
  | { available: false; reason: 'no-git' | 'unknown-revision' | 'git-error' | 'unreadable'; detail?: string };

/** Parse a hunk header, or null when the line is not one. */
export function parseHunkHeader(line: string): Pick<DiffHunk, 'oldStart' | 'oldLines' | 'newStart' | 'newLines'> | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (!match) {
    return null;
  }
  return {
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
  };
}

/**
 * Parse a unified diff of a single file into hunks with numbered lines.
 *
 * Only lines after a `@@` header are classified, so the `---`/`+++` file headers are not
 * mistaken for a removal and an addition. A `\ No newline at end of file` marker is dropped.
 */
export function parseUnifiedDiff(text: string, file = ''): FileDiff {
  const header: string[] = [];
  const hunks: DiffHunk[] = [];
  let added = 0;
  let removed = 0;
  let binary = false;
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const last = index === lines.length - 1;

    if (line.startsWith('@@')) {
      const parsed = parseHunkHeader(line);
      if (!parsed) {
        continue;
      }
      current = { header: line, ...parsed, lines: [] };
      hunks.push(current);
      oldLine = parsed.oldStart;
      newLine = parsed.newStart;
      continue;
    }

    if (!current) {
      if (/^Binary files .+ differ$/.test(line) || line === 'GIT binary patch') {
        binary = true;
      }
      if (line !== '' || !last) {
        header.push(line);
      }
      continue;
    }

    // A trailing empty string is the artifact of the final newline, not an empty context line.
    if (line === '' && last) {
      break;
    }
    if (line.startsWith('\\')) {
      continue;
    }
    const body = line.slice(1).replace(/\r$/, '');
    if (line.startsWith('+')) {
      current.lines.push({ kind: 'add', text: body, oldLine: null, newLine });
      newLine += 1;
      added += 1;
      continue;
    }
    if (line.startsWith('-')) {
      current.lines.push({ kind: 'del', text: body, oldLine, newLine: null });
      oldLine += 1;
      removed += 1;
      continue;
    }
    current.lines.push({ kind: 'context', text: body, oldLine, newLine });
    oldLine += 1;
    newLine += 1;
  }

  return { file, header, hunks, added, removed, binary };
}

/** A whole untracked file read as one all-added hunk. */
function entireFileDiff(file: string, content: string): FileDiff {
  const text = content.replace(/\n$/, '');
  const body = text === '' ? [] : text.split('\n');
  const lines: DiffLine[] = body.map((line, index) => ({
    kind: 'add',
    text: line.replace(/\r$/, ''),
    oldLine: null,
    newLine: index + 1,
  }));
  const hunks: DiffHunk[] =
    lines.length === 0
      ? []
      : [
          {
            header: `@@ -0,0 +1,${lines.length} @@`,
            oldStart: 0,
            oldLines: 0,
            newStart: 1,
            newLines: lines.length,
            lines,
          },
        ];
  return { file, header: ['new file'], hunks, added: lines.length, removed: 0, binary: false };
}

function gitErrorResult(error: unknown): FileDiffResult {
  const message = error instanceof Error ? error.message : String(error);
  if (/not a git repository|not inside a Git working tree/i.test(message)) {
    return { available: false, reason: 'no-git', detail: message.split('\n')[0] };
  }
  if (/unknown revision|bad revision|ambiguous argument|does not have any commits/i.test(message)) {
    return { available: false, reason: 'unknown-revision', detail: message.split('\n')[0] };
  }
  return { available: false, reason: 'git-error', detail: message.split('\n')[0] };
}

/**
 * The change to one file, by any of the routes a review uses: one commit's own change, a
 * range, the staged or unstaged working tree, or an untracked file Git has no other side for.
 */
export async function diffFile(root: string, spec: DiffSpec): Promise<FileDiffResult> {
  const { file } = spec;
  if (!file.trim()) {
    return { available: false, reason: 'unreadable', detail: 'A file is required.' };
  }

  if (spec.untracked) {
    const content = readWorkingFile(root, file);
    return content === null
      ? { available: false, reason: 'unreadable', detail: `"${file}" is not readable as text.` }
      : { available: true, file, side: 'untracked', diff: entireFileDiff(file, content) };
  }

  let args: string[];
  let side: DiffSide;
  if (spec.ref) {
    if (!isSafeRevision(spec.ref)) {
      return { available: false, reason: 'unknown-revision', detail: `Unknown revision "${spec.ref}".` };
    }
    args = ['show', '--first-parent', '--format=', '-M', spec.ref, '--', file];
    side = 'commit';
  } else if (spec.base) {
    if (!isSafeRevision(spec.base) || (spec.head !== undefined && !isSafeRevision(spec.head))) {
      return { available: false, reason: 'unknown-revision', detail: `Unknown revision "${spec.base}".` };
    }
    args = ['diff', '-M', spec.base, ...(spec.head ? [spec.head] : []), '--', file];
    side = 'range';
  } else if (spec.staged) {
    args = ['diff', '--cached', '-M', '--', file];
    side = 'staged';
  } else {
    args = ['diff', '-M', '--', file];
    side = 'unstaged';
  }

  try {
    const { stdout } = await run('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
    return { available: true, file, side, diff: parseUnifiedDiff(String(stdout), file) };
  } catch (error) {
    return gitErrorResult(error);
  }
}
