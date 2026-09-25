import path from 'node:path';

import type { RepositoryDescriptor } from './types.ts';
import { run } from './process.ts';

/** Describe a repository for the API: name, HEAD, dirty state, and Git URL. */
export async function describeRepository(root: string): Promise<RepositoryDescriptor> {
  const name = path.basename(root);
  let head: string | null = null;
  let dirty = false;
  let gitUrl: string | null = null;

  try {
    const [{ stdout: headOut }, { stdout: statusOut }] = await Promise.all([
      run('git', ['rev-parse', 'HEAD'], { cwd: root }),
      run('git', ['status', '--porcelain'], { cwd: root, maxBuffer: 16 * 1024 * 1024 }),
    ]);
    head = headOut.trim() || null;
    dirty = statusOut.trim().length > 0;
  } catch {
    // Git metadata being unavailable does not block scanning.
  }

  try {
    const { stdout } = await run('git', ['remote', 'get-url', 'origin'], { cwd: root });
    gitUrl = stdout.trim() || null;
  } catch {
    gitUrl = null;
  }

  return { name, root, head, dirty, gitUrl };
}
