import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The options `run` accepts; `windowsHide` is forced on and cannot be turned off by a caller. */
type RunOptions = ExecFileOptionsWithStringEncoding;

/**
 * Run a program and collect its text output, without flashing a console window on Windows.
 *
 * A console child inherits its parent's console only when the parent has one. Strabo often
 * runs without a Windows console — under a pty terminal such as Git Bash/mintty, as a detached
 * terminal daemon, or inside a GUI host — and then every spawned console program allocates its
 * own console window. Git drives almost every analysis, so a single action (`scan`, `review`,
 * `report`) would otherwise flash a burst of windows. `windowsHide` suppresses that; it is a
 * no-op on POSIX. Callers pass the same options `execFile` accepts.
 */
export function run(file: string, args: readonly string[], options: RunOptions = {}) {
  return execFileAsync(file, args, { ...options, windowsHide: true });
}
