import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

import { assertReadable } from '../boundary/repository-root.ts';
import { symbolExtractorFor, type SymbolExtractor } from '../scan/languages/registry.ts';
import { computeMemberCohesion } from './file-health.ts';
import { isSafeRevision } from './impact.ts';
import type { ChangePassport, CohesionChange, ReviewFile, ReviewStatus } from './review-types.ts';

const run = promisify(execFile);
const MAX_FILES = 40;
const MAX_BYTES = 4 * 1024 * 1024;

export type { ChangePassport, CohesionChange } from './review-types.ts';

/**
 * The Change passport: cohesion before and after a change, from the member wiring the
 * symbol extractor records for each file.
 *
 * Cohesion needs only one file's content, so unlike the graph axes it can be compared
 * without scanning the base revision. The base content is read with `git show <ref>:<path>`
 * so the comparison is the recorded revision, not a reconstruction. A file whose language
 * has no extractor, is binary, or is new/deleted reports the missing side as null with a
 * note rather than a fabricated score.
 */
export async function computeChangePassport(
  root: string,
  files: readonly ReviewFile[],
  baseline: string | null,
): Promise<ChangePassport> {
  const safeBaseline = baseline && isSafeRevision(baseline) ? baseline : null;
  const measured = files.slice(0, MAX_FILES);
  const changes: CohesionChange[] = [];
  for (const file of measured) {
    changes.push(await cohesionChange(root, file, safeBaseline));
  }
  return { files: changes, baseline: safeBaseline, capped: files.length > measured.length };
}

async function cohesionChange(
  root: string,
  file: ReviewFile,
  baseline: string | null,
): Promise<CohesionChange> {
  const base: Pick<CohesionChange, 'path' | 'status' | 'previousPath'> = {
    path: file.path,
    status: file.status,
    ...(file.previousPath ? { previousPath: file.previousPath } : {}),
  };

  const extractor = symbolExtractorFor(file.path);
  if (!extractor) {
    return { ...base, before: null, after: null, note: 'no symbol extractor for this language' };
  }
  if (extractor.tracksAccess === false) {
    return { ...base, before: null, after: null, note: 'this language records no member access' };
  }

  const sourcePath = file.previousPath ?? file.path;
  const beforeContent = baseline ? await contentAtRevision(root, baseline, sourcePath) : null;
  const afterContent = file.status === 'deleted' ? null : readWorkingFile(root, file.path);
  const before = beforeContent === null ? null : await cohesionOf(extractor, sourcePath, beforeContent);
  const after = afterContent === null ? null : await cohesionOf(extractor, file.path, afterContent);

  return {
    ...base,
    before,
    after,
    note: noteFor({ file, baseline, beforeContent, before, after }),
  };
}

function noteFor(options: {
  file: ReviewFile;
  baseline: string | null;
  beforeContent: string | null;
  before: number | null;
  after: number | null;
}): string {
  const { file, baseline, beforeContent, before, after } = options;
  if (file.status === 'deleted') {
    return 'deleted — no reviewed state';
  }
  if (baseline === null) {
    return 'no baseline revision';
  }
  if (beforeContent === null) {
    return `not present in ${baseline}`;
  }
  if (before === null) {
    return `cohesion unavailable in ${baseline}`;
  }
  if (after === null) {
    return 'cohesion unavailable in the reviewed copy';
  }
  return `compared with ${baseline}`;
}

async function cohesionOf(
  extractor: SymbolExtractor,
  file: string,
  content: string,
): Promise<number | null> {
  try {
    const result = await extractor.extract(file, content);
    return computeMemberCohesion(result.symbols, result.accesses ?? []).value;
  } catch {
    return null;
  }
}

async function contentAtRevision(root: string, ref: string, file: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['show', `${ref}:${file}`], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    });
    const content = typeof stdout === 'string' ? stdout : String(stdout);
    return content.includes('\0') ? null : content;
  } catch {
    return null;
  }
}

function readWorkingFile(root: string, file: string): string | null {
  try {
    const resolved = assertReadable(root, file);
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_BYTES) {
      return null;
    }
    const content = fs.readFileSync(resolved);
    return content.includes(0) ? null : content.toString('utf8');
  } catch {
    return null;
  }
}
