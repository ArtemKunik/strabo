/**
 * Compatibility shim: the single-session PTY was replaced by the multi-session engine.
 * Kept so a stale `./pty.ts` import still resolves; new code imports `./session.ts` or
 * `./registry.ts` directly.
 */
export { createPtySession } from './session.ts';
export type { CreatePtySessionParams, PtyProcess, PtySpawnOptions, PtySpawner } from './session.ts';
export { createSessionManager, getSessionManager, resetSessionManagerForTests } from './registry.ts';
export type { SessionManagerOptions } from './registry.ts';
