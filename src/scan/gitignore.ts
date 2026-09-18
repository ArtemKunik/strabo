import { spawn } from 'node:child_process';

/**
 * List git-ignored candidates within a repository.
 *
 * Git metadata being unavailable is not fatal: the caller keeps scanning and simply
 * loses persisted-fingerprint reuse.
 */
export async function findGitIgnoredFiles(root: string, files: string[]): Promise<Set<string>> {
  if (files.length === 0) {
    return new Set();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Set<string>): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const child = spawn('git', ['check-ignore', '--stdin'], { cwd: root });
    const chunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => finish(new Set()));
    child.on('close', () => {
      const output = Buffer.concat(chunks).toString('utf8');
      finish(
        new Set(
          output
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
        ),
      );
    });

    // `git check-ignore` may exit before stdin is drained (e.g. outside a work tree),
    // which surfaces as EPIPE/EOF on the stdin socket. Ignore it; `close` decides.
    child.stdin.on('error', () => finish(new Set()));
    try {
      child.stdin.end(files.join('\n'));
    } catch {
      finish(new Set());
    }
  });
}
