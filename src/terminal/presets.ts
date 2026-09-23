import fs from 'node:fs';
import path from 'node:path';

import type { SessionKind } from './protocol.ts';

/**
 * A runnable command derived from a repository's own manifests.
 *
 * `argv` is the literal process invocation — nothing here is ever concatenated into a
 * shell string, so a hostile package script name cannot become one. `source` names the
 * file the preset came from, so the UI can show provenance. `cwd` is relative to the
 * repository root and is omitted when the command runs at the root.
 */
export interface TerminalPreset {
  id: string;
  label: string;
  kind: SessionKind;
  argv: string[];
  cwd?: string;
  source: string;
}

/** Ceiling on the returned list; a monorepo can declare hundreds of scripts and targets. */
const MAX_PRESETS = 40;

/**
 * npm lifecycle scripts that run around another script rather than standing on their own.
 * `prepare` is deliberately excluded too: it is an install hook, and running it by hand is
 * almost never what the operator means. `prestart`/`poststart` and friends exist only to
 * wrap their counterpart, so surfacing them is noise.
 */
const NPM_LIFECYCLE_PREFIXES = ['pre', 'post'];

const NPM_INTERNAL = new Set(['prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack', 'preinstall', 'install', 'postinstall']);

function readText(absolute: string): string | null {
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      return null;
    }
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

function readJsonObject(absolute: string): Record<string, unknown> | null {
  const text = readText(absolute);
  if (text === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Whether an npm script is worth showing. Lifecycle hooks (`pretest` beside `test`) are
 * dropped, but a `pre*`/`post*` name whose counterpart does not exist is a real script the
 * project happens to have named that way, so it is kept.
 */
function isInterestingNpmScript(name: string, all: Set<string>): boolean {
  if (NPM_INTERNAL.has(name)) {
    return false;
  }
  for (const prefix of NPM_LIFECYCLE_PREFIXES) {
    if (name.length <= prefix.length || !name.startsWith(prefix)) {
      continue;
    }
    const base = name.slice(prefix.length);
    if (all.has(base)) {
      return false;
    }
  }
  return true;
}

function npmPresets(root: string): TerminalPreset[] {
  const manifest = readJsonObject(path.join(root, 'package.json'));
  const scripts = manifest?.scripts;
  if (typeof scripts !== 'object' || scripts === null || Array.isArray(scripts)) {
    return [];
  }
  const names = new Set(Object.keys(scripts as Record<string, unknown>));
  const presets: TerminalPreset[] = [];
  for (const name of names) {
    if (!isInterestingNpmScript(name, names)) {
      continue;
    }
    presets.push({
      id: `pkg:${name}`,
      label: name,
      kind: 'task',
      argv: ['npm', 'run', name],
      source: 'package.json',
    });
  }
  return presets;
}

/** Match a top-level `name:` rule. Recipe lines and target-specific variables are ignored. */
const MAKE_TARGET = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/;

function makefilePresets(root: string): TerminalPreset[] {
  const text = readText(path.join(root, 'Makefile')) ?? readText(path.join(root, 'makefile')) ?? readText(path.join(root, 'GNUmakefile'));
  if (text === null) {
    return [];
  }
  const presets: TerminalPreset[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('\t') || line.startsWith(' ') || line.startsWith('#')) {
      continue;
    }
    const match = MAKE_TARGET.exec(line);
    const name = match?.[1];
    if (!name || name === '.PHONY' || seen.has(name)) {
      continue;
    }
    seen.add(name);
    presets.push({
      id: `make:${name}`,
      label: name,
      kind: 'task',
      argv: ['make', name],
      source: 'Makefile',
    });
  }
  return presets;
}

function cargoPresets(root: string): TerminalPreset[] {
  if (readText(path.join(root, 'Cargo.toml')) === null) {
    return [];
  }
  return [
    { id: 'cargo:build', label: 'cargo build', kind: 'task', argv: ['cargo', 'build'], source: 'Cargo.toml' },
    { id: 'cargo:test', label: 'cargo test', kind: 'task', argv: ['cargo', 'test'], source: 'Cargo.toml' },
  ];
}

function goPresets(root: string): TerminalPreset[] {
  if (readText(path.join(root, 'go.mod')) === null) {
    return [];
  }
  return [
    { id: 'go:build', label: 'go build ./...', kind: 'task', argv: ['go', 'build', './...'], source: 'go.mod' },
    { id: 'go:test', label: 'go test ./...', kind: 'task', argv: ['go', 'test', './...'], source: 'go.mod' },
  ];
}

/**
 * Whether a conventional test directory exists. Directory probes are shallow on purpose:
 * walking a monorepo to find one test file is not worth the syscalls for a hint.
 */
function hasTestLayout(root: string): boolean {
  for (const candidate of ['tests', 'test']) {
    try {
      if (fs.statSync(path.join(root, candidate)).isDirectory()) {
        return true;
      }
    } catch {
      // Missing is the common case; fall through to the next candidate.
    }
  }
  return false;
}

function pythonPresets(root: string): TerminalPreset[] {
  const source = readText(path.join(root, 'pyproject.toml')) !== null ? 'pyproject.toml' : 'requirements.txt';
  if (readText(path.join(root, source)) === null) {
    return [];
  }
  if (readText(path.join(root, 'pytest.ini')) === null && !hasTestLayout(root)) {
    return [];
  }
  return [{ id: 'py:pytest', label: 'pytest', kind: 'task', argv: ['pytest'], source }];
}

/**
 * Derive the runnable commands a repository declares, capped and stably identified.
 *
 * Reading is defensive by design: a missing, unreadable, or corrupt manifest yields no
 * presets from that source rather than throwing, because this runs behind a route that
 * lists what is available. Nothing is executed and no network is touched.
 */
export function listPresets(root: string): TerminalPreset[] {
  const presets = [
    ...npmPresets(root),
    ...makefilePresets(root),
    ...cargoPresets(root),
    ...pythonPresets(root),
    ...goPresets(root),
  ];
  return presets.slice(0, MAX_PRESETS);
}
