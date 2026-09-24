import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The `strabo` command injected onto every session's PATH.
 *
 * Running `strabo focus src/foo.ts` from inside a terminal session prints a single marker
 * line (`::strabo::focus src/foo.ts`). The browser filters that line out of the visible output
 * and turns it into a map action, so a script or an agent can drive the graph from the shell.
 * The shim is inert on its own: it only writes the marker, never executes anything, and the
 * verbs it accepts are a fixed whitelist the browser enforces again.
 */
const SHIM_SCRIPT = `#!/usr/bin/env node
'use strict';
const VERBS = new Set(['focus', 'open', 'highlight', 'review', 'note', 'screen']);
const [verb, ...rest] = process.argv.slice(2);
if (!verb || !VERBS.has(verb)) {
  process.stderr.write('usage: strabo <focus|open|highlight|review|note|screen> [args]\\n');
  process.exit(2);
}
// Path arguments are made repository-relative when they sit under STRABO_REPO, so a shell that
// reports an absolute path still matches a node id on the map.
function rel(value) {
  const root = process.env.STRABO_REPO;
  if (!root || !value) return value;
  let candidate = value.replace(/\\\\/g, '/');
  const base = root.replace(/\\\\/g, '/').replace(/\\/+$/, '');
  if (candidate.toLowerCase().startsWith((base + '/').toLowerCase())) {
    candidate = candidate.slice(base.length + 1);
  }
  return candidate;
}
let args = rest;
if (verb === 'focus' && args[0]) args = [rel(args[0]), ...args.slice(1)];
if (verb === 'open' && args[0]) args = [rel(args[0]), ...args.slice(1)];
if (verb === 'highlight') args = args.map(rel);
process.stdout.write('::strabo::' + verb + (args.length ? ' ' + args.join(' ') : '') + '\\n');
`;

let cached: string | null | undefined;

/**
 * Write the shim (once) into a temp directory and return that directory, or null when it could
 * not be created — in which case sessions simply start without the command rather than failing.
 */
export function terminalShimDir(): string | null {
  if (cached !== undefined) {
    return cached;
  }
  try {
    const dir = path.join(os.tmpdir(), 'strabo-shim');
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, 'strabo.js');
    fs.writeFileSync(script, SHIM_SCRIPT, 'utf8');
    if (process.platform === 'win32') {
      fs.writeFileSync(
        path.join(dir, 'strabo.cmd'),
        `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`,
        'utf8',
      );
    } else {
      const wrapper = path.join(dir, 'strabo');
      fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, {
        encoding: 'utf8',
        mode: 0o755,
      });
      fs.chmodSync(wrapper, 0o755);
    }
    cached = dir;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * Prepend the shim directory to the child's PATH in place. Windows env keys are
 * case-insensitive, so the existing key's case is preserved rather than adding a second one.
 */
export function withTerminalShimPath(env: Record<string, string>): void {
  const dir = terminalShimDir();
  if (!dir) {
    return;
  }
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
  const current = env[key] ?? '';
  env[key] = current ? `${dir}${path.delimiter}${current}` : dir;
}

/** Test seam: forget the cached directory so a test can re-create it. */
export function resetTerminalShimCache(): void {
  cached = undefined;
}
