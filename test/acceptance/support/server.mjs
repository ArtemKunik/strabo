import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const ACCEPTANCE_PORT = 3131;
export const ACCEPTANCE_URL = `http://127.0.0.1:${ACCEPTANCE_PORT}`;
export const ACCEPTANCE_FIXTURES = path.resolve('test/fixtures');
export const ACCEPTANCE_ROOT = path.join(ACCEPTANCE_FIXTURES, 'block-repo');
export const ACCEPTANCE_POLYGLOT_ROOT = path.join(ACCEPTANCE_FIXTURES, 'system-repo');

let child = null;

/** Start the standalone server against the acceptance fixture on a dedicated port. */
export async function startServer() {
  const fixtures = ACCEPTANCE_FIXTURES;
  const root = ACCEPTANCE_ROOT;
  const cacheDir = path.resolve('test/acceptance/reports/cache');
  // A fresh state dir per run keeps the remembered-repositories list deterministic.
  const stateDir = path.resolve('test/acceptance/reports/state');
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true });
  child = spawn(process.execPath, ['bin/strabo.js'], {
    env: {
      ...process.env,
      STRABO_ROOT: root,
      // The folder dialog browses within the scan ceiling; widen it to the fixtures dir.
      STRABO_SCAN_CEILING: fixtures,
      PORT: String(ACCEPTANCE_PORT),
      STRABO_CACHE_DIR: cacheDir,
      STRABO_STATE_DIR: stateDir,
    },
    stdio: 'ignore',
  });

  await waitForHealth();
}

export async function stopServer() {
  if (child) {
    child.kill();
    child = null;
  }
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`${ACCEPTANCE_URL}/api/strabo/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Strabo acceptance server did not become healthy in time.');
}
