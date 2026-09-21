import fs from 'node:fs';
import path from 'node:path';

import { stateRoot } from './repository-store.ts';

/**
 * The server settings the operator changed at runtime, persisted across restarts.
 *
 * Every field is nullable, and null means "no override": the value from the environment or
 * startup arguments stays in force. This is what lets a persisted choice survive a restart
 * without freezing a value the operator never touched.
 */
export interface PersistedSettings {
  /** The scan ceiling in force, or null to use the startup ceiling. */
  scanCeiling: string | null;
  /** Whether OSV.dev / deps.dev lookups are enabled, or null for the startup value. */
  riskOnline: boolean | null;
  /** Whether the ceiling may be widened at runtime, or null for the startup value. */
  allowCeilingWidening: boolean | null;
}

export interface SettingsStore {
  read(): PersistedSettings;
  /** Merge `patch` into the stored settings and persist the result. */
  write(patch: Partial<PersistedSettings>): PersistedSettings;
}

export const SETTINGS_STORE_VERSION = 1;

interface StoreFile extends PersistedSettings {
  version: number;
}

const NO_OVERRIDES: PersistedSettings = {
  scanCeiling: null,
  riskOnline: null,
  allowCeilingWidening: null,
};

/** Path of the persisted server settings. Exposed for diagnostics and tests. */
export function settingsStorePath(): string {
  return path.join(stateRoot(), 'strabo-settings.json');
}

function emptyStore(): StoreFile {
  return { version: SETTINGS_STORE_VERSION, ...NO_OVERRIDES };
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function nullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function readStore(file: string): StoreFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoreFile>;
    if (parsed.version !== SETTINGS_STORE_VERSION) {
      return emptyStore();
    }
    return {
      version: SETTINGS_STORE_VERSION,
      scanCeiling: nullableString(parsed.scanCeiling),
      riskOnline: nullableBoolean(parsed.riskOnline),
      allowCeilingWidening: nullableBoolean(parsed.allowCeilingWidening),
    };
  } catch {
    // A missing or corrupt file means "no overrides", never an error.
    return emptyStore();
  }
}

/** Write through a temporary file and rename so readers never see a partial file. */
function writeStore(file: string, store: StoreFile): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(store, null, 2));
    fs.renameSync(temporary, file);
  } catch {
    // Persistence is best-effort and must never fail a request.
  }
}

/**
 * A small JSON-backed record of the operator's server settings.
 *
 * Synchronous and dependency-free, like the repository store: it is read once at startup
 * and written only when the settings route accepts a change.
 */
export function createSettingsStore(options: { file?: string } = {}): SettingsStore {
  const file = options.file ?? settingsStorePath();

  return {
    read(): PersistedSettings {
      const { version: _version, ...settings } = readStore(file);
      return settings;
    },

    write(patch: Partial<PersistedSettings>): PersistedSettings {
      const store = { ...readStore(file), ...patch, version: SETTINGS_STORE_VERSION };
      writeStore(file, store);
      const { version: _version, ...settings } = store;
      return settings;
    },
  };
}
