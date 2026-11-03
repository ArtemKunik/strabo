/**
 * Keep Strabo's leftovers from piling up while it runs.
 *
 * Each module sweeps the files it owns; this only decides when. It runs in the long-lived
 * commands, shortly after startup and then daily, so a server left open stays tidy too.
 */
import { sweepCaches } from '../cache/housekeeping.ts';
import { pruneWorkspaceCache } from '../cache/workspace-cache.ts';
import { isDisabled } from '../config.ts';
import { sweepDaemonEndpoints } from '../terminal/daemon.ts';
import { delegateRoot, pruneDelegateDirs } from './routes/delegate.ts';

/** Long enough to stay out of startup's way, short enough to run in a brief session. */
const FIRST_SWEEP_DELAY_MS = 10_000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** One sweep of everything Strabo owns. Returns the paths it removed. */
export async function runHousekeeping(now: number = Date.now()): Promise<string[]> {
  pruneWorkspaceCache();
  return [
    ...sweepCaches({ now }),
    ...pruneDelegateDirs(delegateRoot(), now),
    ...(await sweepDaemonEndpoints(now)),
  ];
}

/** Schedule the sweeps. The timers are unref'd, so they never keep a process alive. */
export function startHousekeeping(
  log?: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isDisabled(env.STRABO_HOUSEKEEPING)) return;
  const sweep = (): void => {
    runHousekeeping()
      .then((removed) => {
        if (removed.length > 0) log?.(`housekeeping removed ${removed.length} leftover(s)`);
      })
      .catch((error: unknown) => {
        log?.(`housekeeping failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  };
  setTimeout(sweep, FIRST_SWEEP_DELAY_MS).unref();
  setInterval(sweep, SWEEP_INTERVAL_MS).unref();
}
