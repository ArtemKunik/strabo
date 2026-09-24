import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve a command name to an absolute executable path using `PATH`.
 *
 * `node-pty`'s Windows ConPTY backend hands the command to `CreateProcess` as the process
 * image name, so it searches neither `PATH` nor `PATHEXT`: a bare `opencode` fails with
 * `File not found` even when `opencode.exe` sits on `PATH`, and `npm` is not found at all.
 * Resolving first makes every external command — agents and task presets alike — launch
 * with the same absolute path on Windows and POSIX. A name that already contains a path
 * separator, or is already absolute, is returned untouched, as is a name that cannot be
 * found, so the spawner still reports its own "not found" error for a genuinely missing tool.
 *
 * On Windows an extensionless name is matched against `PATHEXT` in its declared order, so
 * `npm` resolves to `npm.cmd` rather than the extensionless shell script beside it, which
 * `CreateProcess` cannot run.
 */
export function resolveExecutable(
  file: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!file || path.isAbsolute(file) || file.includes('/') || file.includes('\\')) {
    return file;
  }
  const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
  if (pathValue === '') {
    return file;
  }
  const extensions = executableExtensions(file, env);
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir === '') {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(dir, file + extension);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return file;
}

/**
 * The suffixes to try for a bare command. POSIX executables carry no suffix; on Windows the
 * `PATHEXT` list applies, unless the name already ends in one of those suffixes, in which
 * case only the exact name is tried (so `opencode.exe` is not searched as `opencode.exe.COM`).
 */
function executableExtensions(file: string, env: Record<string, string | undefined>): string[] {
  if (process.platform !== 'win32') {
    return [''];
  }
  const declared = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const lower = file.toLowerCase();
  if (declared.some((extension) => lower.endsWith(extension.toLowerCase()))) {
    return [''];
  }
  return declared;
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}
