import fs from 'node:fs';

import { assertReadable } from '../boundary/repository-root.ts';
import { run } from '../process.ts';

/**
 * Reading one version of one file, shared by the analyses that compare two sides.
 *
 * Both helpers return null on any failure (missing object, binary content, a path outside
 * the scan boundary) rather than throwing, so a caller names the missing side instead of
 * fabricating an empty one.
 */

const MAX_BYTES = 4 * 1024 * 1024;

/** The content of one file at a revision, or null when it cannot be read as text. */
export async function contentAtRevision(root: string, ref: string, file: string): Promise<string | null> {
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

/** The working-tree content of one file, bounded and text-only. */
export function readWorkingFile(root: string, file: string): string | null {
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
