import fs from 'node:fs';
import path from 'node:path';

import { stateRoot } from '../state/repository-store.ts';

/**
 * The write-only API key the operator stores on this machine for the narrator.
 *
 * This is the first secret Strabo writes to disk, so the handling is deliberately
 * narrow:
 *
 * - The file holds `{ host, key, createdAt }` for exactly one endpoint host. The host
 *   binding is what makes "changing the endpoint host clears the stored key" true: a
 *   key confirmed for `api.openai.com` is never sent to another host.
 * - The file is created with owner-only permissions (`0o600`) and the directory is
 *   created when missing. On platforms without POSIX modes this is best-effort.
 * - The key is never logged, never cached, never audited, and never returned to the
 *   browser. Reads report only whether a key is stored for a host, never its value.
 * - Writes come only from `POST /narrator/key` after the same-origin check, and the
 *   endpoint must already be configured so the host binding is unambiguous.
 */

export interface StoredNarratorKey {
  host: string;
  key: string;
  createdAt: string;
}

export interface NarratorKeyStore {
  /** The host the stored key is bound to, or null when nothing is stored. */
  host(): string | null;
  /** True when a key is stored for `host` (exact host match, including port). */
  has(host: string): boolean;
  /** The stored key for `host`, or null. Never exposed over HTTP. */
  read(host: string): string | null;
  /** Store `key` for `host`, replacing any previous host binding. */
  write(host: string, key: string): void;
  /** Remove any stored key. Used when the endpoint host changes. */
  clear(): void;
}

/** Path of the stored narrator key. Exposed for diagnostics and tests. */
export function narratorKeyPath(): string {
  return path.join(stateRoot(), 'strabo-narrator-key.json');
}

function readFile(file: string): StoredNarratorKey | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoredNarratorKey>;
    if (typeof parsed.host !== 'string' || parsed.host.trim() === '') {
      return null;
    }
    if (typeof parsed.key !== 'string' || parsed.key === '') {
      return null;
    }
    return { host: parsed.host, key: parsed.key, createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '' };
  } catch {
    return null;
  }
}

export function createNarratorKeyStore(options: { file?: string } = {}): NarratorKeyStore {
  const file = options.file ?? narratorKeyPath();

  return {
    host(): string | null {
      return readFile(file)?.host ?? null;
    },

    has(host: string): boolean {
      const stored = readFile(file);
      return stored !== null && stored.host === host;
    },

    read(host: string): string | null {
      const stored = readFile(file);
      if (!stored || stored.host !== host) {
        return null;
      }
      return stored.key;
    },

    write(host: string, key: string): void {
      const trimmedHost = host.trim();
      if (!trimmedHost || !key) {
        return;
      }
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const temporary = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(
          temporary,
          JSON.stringify({ host: trimmedHost, key, createdAt: new Date().toISOString() }),
        );
        try {
          fs.chmodSync(temporary, 0o600);
        } catch {
          // Owner-only mode is best-effort on platforms without POSIX permissions.
        }
        fs.renameSync(temporary, file);
        try {
          fs.chmodSync(file, 0o600);
        } catch {
          // See above.
        }
      } catch {
        // Persistence is best-effort and must never fail a request.
      }
    },

    clear(): void {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // Clearing is best-effort.
      }
    },
  };
}
