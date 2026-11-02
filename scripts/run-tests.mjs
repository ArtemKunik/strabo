#!/usr/bin/env node
/**
 * Run `node --test` with its own temp directory, removed when the run ends.
 *
 * The suite creates repositories, caches, and stores under `os.tmpdir()`, and a test that dies
 * early never reaches its own cleanup. Pointing the whole run at one directory means one
 * removal covers all of it, and keeps the tests away from a running Strabo's cache and terminal
 * daemon, which live in the real temp directory.
 *
 * Arguments are passed through to `node --test`.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Short on purpose: terminal tests bind Unix sockets here, and macOS caps a socket path at 104
// bytes on top of an already long temp directory.
const PREFIX = 'st-';
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

/** Remove best-effort: a daemon on its way out can briefly hold a directory open on Windows. */
function remove(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    console.error(`Could not remove ${directory}: ${error.message}`);
  }
}

/** A killed run cannot clean up, so the next one does. The age check spares a concurrent run. */
function removeAbandonedRuns(parent) {
  for (const entry of fs.readdirSync(parent)) {
    if (!entry.startsWith(PREFIX)) continue;
    const directory = path.join(parent, entry);
    try {
      if (Date.now() - fs.statSync(directory).mtimeMs > ABANDONED_AFTER_MS) remove(directory);
    } catch {
      // Already gone.
    }
  }
}

const parent = os.tmpdir();
removeAbandonedRuns(parent);
const directory = fs.mkdtempSync(path.join(parent, PREFIX));

// Ctrl+C reaches the child too; staying alive until it exits is what lets the removal run.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {});

const child = spawn(process.execPath, ['--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory },
});

child.on('error', (error) => {
  console.error(`Could not start the test runner: ${error.message}`);
  remove(directory);
  process.exit(1);
});

child.on('exit', (code) => {
  remove(directory);
  process.exit(code ?? 1);
});
