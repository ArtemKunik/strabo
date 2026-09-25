import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Phase 21 G4: a deterministic synthetic corpus for the scan benchmark.
 *
 * No operator repository of 20k-50k files is available, so the committed benchmark result
 * is measured on a generated tree instead. This generator is the provenance for that tree:
 * the same `--seed` and `--files` always produce byte-identical source files and a
 * byte-identical manifest, so the measured number is checkable by regenerating it.
 *
 * The tree is deliberately *not* a real repository and is not committed. It mirrors the
 * languages Strabo scans and writes internal imports for each: relative imports for
 * JS/TS, package modules for Python, packages for Java and Kotlin, namespaces for C#,
 * `mod`/`use` for Rust, quoted includes for C++, and standalone schema for SQL.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Languages generated and the share of files each contributes. Shares sum to 1. */
export const CORPUS_LANGUAGES = Object.freeze([
  Object.freeze({ language: 'typescript', extensions: ['.ts'], share: 0.42 }),
  Object.freeze({ language: 'javascript', extensions: ['.js'], share: 0.14 }),
  Object.freeze({ language: 'tsx', extensions: ['.tsx'], share: 0.06 }),
  Object.freeze({ language: 'python', extensions: ['.py'], share: 0.1 }),
  Object.freeze({ language: 'java', extensions: ['.java'], share: 0.08 }),
  Object.freeze({ language: 'csharp', extensions: ['.cs'], share: 0.06 }),
  Object.freeze({ language: 'rust', extensions: ['.rs'], share: 0.05 }),
  Object.freeze({ language: 'cpp', extensions: ['.cpp', '.h'], share: 0.05 }),
  Object.freeze({ language: 'kotlin', extensions: ['.kt'], share: 0.02 }),
  Object.freeze({ language: 'sql', extensions: ['.sql'], share: 0.02 }),
]);

export const DEFAULT_FILES = 20000;
export const DEFAULT_SEED = 20260925;

/** Files per generated unit; units avoid one giant directory and keep imports local. */
const UNIT_SIZE = 40;
const KERNEL_MODULES = 100;

/** A deterministic 32-bit PRNG (mulberry32); the corpus depends on this exact stream. */
export function createRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Split `files` across languages by share, largest-remainder so the parts sum exactly.
 * Returns a Map of language -> count.
 */
export function allocateFiles(files, plan = CORPUS_LANGUAGES) {
  const floors = plan.map((entry) => ({ entry, exact: entry.share * files }));
  const counts = floors.map((item) => Math.floor(item.exact));
  let assigned = counts.reduce((sum, value) => sum + value, 0);
  const order = floors
    .map((item, index) => ({ index, remainder: item.exact - Math.floor(item.exact) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order) {
    if (assigned >= files) {
      break;
    }
    counts[index] += 1;
    assigned += 1;
  }
  const result = new Map();
  plan.forEach((entry, index) => result.set(entry.language, counts[index]));
  return result;
}

/** Group a language's file count into unit descriptors with unique directories. */
function buildUnits(language, count, rng) {
  const units = [];
  const unitCount = Math.ceil(count / UNIT_SIZE);
  let remaining = count;
  for (let index = 0; index < unitCount; index += 1) {
    const size = Math.min(UNIT_SIZE, remaining);
    remaining -= size;
    units.push(createUnit(language, index, size, rng));
  }
  return units;
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

function createUnit(language, index, size, rng) {
  const id = pad(index, 4);
  switch (language) {
    case 'typescript':
    case 'tsx':
      return { language, size, rng, kind: 'tslike' };
    case 'javascript':
      return { language, size, rng, kind: 'tslike' };
    case 'python':
      return { language, size, rng, kind: 'python', dir: `python/pkg_${id}` };
    case 'java':
      return { language, size, rng, kind: 'java', dir: `java/src/main/java/com/acme/j${id}` };
    case 'csharp':
      return { language, size, rng, kind: 'csharp', dir: `csharp/Acme.K${id}/src` };
    case 'rust':
      return { language, size, rng, kind: 'rust', dir: `rust/crate_${id}/src` };
    case 'cpp':
      return { language, size, rng, kind: 'cpp', dir: `cpp/lib_${id}/src` };
    case 'kotlin':
      return { language, size, rng, kind: 'kotlin', dir: `kotlin/com/acme/kt${id}` };
    case 'sql':
      return { language, size, rng, kind: 'sql', dir: `sql/db_${id}` };
    default:
      throw new Error(`No corpus layout for language "${language}"`);
  }
}

const TS_EXTENSIONS = new Set(['.ts', '.js', '.tsx']);

/** Materialise the unit's files and the content for each, with internal imports. */
function renderUnit(unit, kernelPaths) {
  switch (unit.kind) {
    case 'tslike':
      return renderTsLike(unit, kernelPaths);
    case 'python':
      return renderPython(unit);
    case 'java':
      return renderJava(unit);
    case 'csharp':
      return renderCsharp(unit);
    case 'rust':
      return renderRust(unit);
    case 'cpp':
      return renderCpp(unit);
    case 'kotlin':
      return renderKotlin(unit);
    case 'sql':
      return renderSql(unit);
    default:
      throw new Error(`No renderer for "${unit.kind}"`);
  }
}

function extensionFor(language) {
  if (language === 'tsx') return '.tsx';
  if (language === 'typescript') return '.ts';
  if (language === 'javascript') return '.js';
  const entry = CORPUS_LANGUAGES.find((item) => item.language === language);
  return entry ? entry.extensions[0] : '.txt';
}

/** Draw up to `limit` distinct forward neighbours within a small window, deterministically. */
function forwardTargets(rng, index, size, limit) {
  const chosen = new Set();
  const window = Math.min(index + 5, size);
  let attempts = 0;
  while (chosen.size < limit && attempts < 20 && index + 1 < size) {
    const candidate = index + 1 + Math.floor(rng() * (window - index - 1 || 1));
    if (candidate < size && candidate !== index) {
      chosen.add(candidate);
    }
    attempts += 1;
  }
  return [...chosen].sort((a, b) => a - b);
}

function relativeSpecifier(fromFile, targetFileNoExt) {
  const fromDir = path.posix.dirname(fromFile);
  let relative = path.posix.relative(fromDir, targetFileNoExt);
  if (!relative.startsWith('.')) {
    relative = `./${relative}`;
  }
  return relative;
}

function renderTsLike(unit, kernelPaths) {
  const components = ['apps', 'packages', 'services', 'tools', 'features'];
  const component = components[unit.__componentIndex % components.length];
  const extension = extensionFor(unit.language);
  const dir = `${component}/u${pad(unit.__componentIndex, 4)}/src`;
  const files = [];
  for (let index = 0; index < unit.size; index += 1) {
    files.push(`${dir}/mod_${pad(index, 4)}${extension}`);
  }

  const contents = new Map();
  for (let index = 0; index < unit.size; index += 1) {
    const file = files[index];
    const targetIndexes = forwardTargets(unit.rng, index, unit.size, 2);
    const lines = [];
    const callable = `fn_${pad(index, 4)}`;
    for (const targetIndex of targetIndexes) {
      const targetNoExt = `${dir}/mod_${pad(targetIndex, 4)}`;
      lines.push(
        `import { fn_${pad(targetIndex, 4)} } from '${relativeSpecifier(file, targetNoExt)}';`,
      );
    }
    if (kernelPaths.length > 0 && unit.rng() < 0.25) {
      const kernelIndex = Math.floor(unit.rng() * kernelPaths.length);
      const kernelNoExt = kernelPaths[kernelIndex].replace(/\.(ts|js|tsx)$/, '');
      lines.push(
        `import { kernel_${pad(kernelIndex, 4)} } from '${relativeSpecifier(file, kernelNoExt)}';`,
      );
    }
    if (unit.language === 'tsx') {
      lines.push(
        `export function ${callable}(): unknown { return <div className="mod">${index}</div>; }`,
      );
    } else if (unit.language === 'javascript') {
      const call = targetIndexes.length > 0 ? `fn_${pad(targetIndexes[0], 4)}(value)` : `value + ${index}`;
      lines.push(`export function ${callable}(value) { return ${call}; }`);
    } else {
      const call =
        targetIndexes.length > 0 ? `fn_${pad(targetIndexes[0], 4)}(value)` : `value + ${index}`;
      lines.push(`export function ${callable}(value: number): number { return ${call}; }`);
    }
    contents.set(file, `${lines.join('\n')}\n`);
  }
  return { files, contents };
}

function renderPython(unit) {
  const pkg = path.posix.basename(unit.dir);
  const files = [`${unit.dir}/__init__.py`];
  for (let index = 0; index < unit.size; index += 1) {
    files.push(`${unit.dir}/mod_${pad(index, 4)}.py`);
  }
  const contents = new Map();
  contents.set(
    files[0],
    `from .mod_0000 import fn_0000\n\n__all__ = ["fn_0000"]\n`,
  );
  for (let index = 0; index < unit.size; index += 1) {
    const targets = forwardTargets(unit.rng, index, unit.size, 2);
    const lines = [];
    for (const target of targets) {
      lines.push(`from .mod_${pad(target, 4)} import fn_${pad(target, 4)}`);
    }
    lines.push(`def fn_${pad(index, 4)}(value):`);
    if (targets.length > 0) {
      lines.push(`    return fn_${pad(targets[0], 4)}(value)`);
    } else {
      lines.push(`    return value + ${index}`);
    }
    lines.push('');
    contents.set(`${unit.dir}/mod_${pad(index, 4)}.py`, lines.join('\n'));
  }
  return { files, contents };
}

function renderJava(unit) {
  const pkg = `com.acme.j${unit.dir.slice(unit.dir.lastIndexOf('j') + 1)}`;
  const files = [];
  for (let index = 0; index < unit.size; index += 1) {
    files.push(`${unit.dir}/Type_${pad(index, 4)}.java`);
  }
  const contents = new Map();
  for (let index = 0; index < unit.size; index += 1) {
    const targets = forwardTargets(unit.rng, index, unit.size, 2);
    const lines = [`package ${pkg};`, ''];
    for (const target of targets) {
      lines.push(`import ${pkg}.Type_${pad(target, 4)};`);
    }
    lines.push('');
    lines.push(`public class Type_${pad(index, 4)} {`);
    lines.push(`  public int fn_${pad(index, 4)}(int value) { return value + ${index}; }`);
    if (targets.length > 0) {
      lines.push(
        `  public int use(Type_${pad(targets[0], 4)} other) { return other.fn_${pad(
          targets[0],
          4,
        )}(1); }`,
      );
    }
    lines.push('}');
    contents.set(files[index], `${lines.join('\n')}\n`);
  }
  return { files, contents };
}

function renderCsharp(unit) {
  const ns = `Acme.K${unit.dir.slice(unit.dir.lastIndexOf('K') + 1).replace('/src', '')}`;
  const files = [];
  for (let index = 0; index < unit.size; index += 1) {
    files.push(`${unit.dir}/Class_${pad(index, 4)}.cs`);
  }
  const contents = new Map();
  for (let index = 0; index < unit.size; index += 1) {
    const targets = forwardTargets(unit.rng, index, unit.size, 2);
    const lines = [`namespace ${ns};`, ''];
    lines.push(`public class Class_${pad(index, 4)} {`);
    lines.push(`  public int Fn_${pad(index, 4)}(int value) { return value + ${index}; }`);
    if (targets.length > 0) {
      lines.push(
        `  public int Use(Class_${pad(targets[0], 4)} other) { return other.Fn_${pad(
          targets[0],
          4,
        )}(1); }`,
      );
    }
    lines.push('}');
    contents.set(files[index], `${lines.join('\n')}\n`);
  }
  return { files, contents };
}

function renderRust(unit) {
  const files = [`${unit.dir}/lib.rs`];
  for (let index = 0; index < unit.size; index += 1) {
    files.push(`${unit.dir}/mod_${pad(index, 4)}.rs`);
  }
  const contents = new Map();
  const lib = [];
  for (let index = 0; index < unit.size; index += 1) {
    lib.push(`pub mod mod_${pad(index, 4)};`);
  }
  contents.set(files[0], `${lib.join('\n')}\n`);
  for (let index = 0; index < unit.size; index += 1) {
    const targets = forwardTargets(unit.rng, index, unit.size, 2);
    const lines = [];
    for (const target of targets) {
      lines.push(`use crate::mod_${pad(target, 4)}::fn_${pad(target, 4)};`);
    }
    lines.push(
      `pub fn fn_${pad(index, 4)}(value: i32) -> i32 { ${
        targets.length > 0 ? `fn_${pad(targets[0], 4)}(value)` : `value + ${index}`
      } }`,
    );
    contents.set(`${unit.dir}/mod_${pad(index, 4)}.rs`, `${lines.join('\n')}\n`);
  }
  return { files, contents };
}

function renderCpp(unit) {
  const files = [];
  const contentFiles = [];
  const headerFiles = [];
  const half = Math.floor(unit.size / 2);
  for (let index = 0; index < half; index += 1) {
    headerFiles.push(`${unit.dir}/unit_${pad(index, 4)}.h`);
    contentFiles.push(`${unit.dir}/unit_${pad(index, 4)}.cpp`);
  }
  while (files.length + headerFiles.length + contentFiles.length < unit.size) {
    contentFiles.push(`${unit.dir}/extra_${pad(contentFiles.length, 4)}.cpp`);
  }
  files.push(...headerFiles, ...contentFiles);
  const contents = new Map();
  for (let index = 0; index < half; index += 1) {
    contents.set(
      `${unit.dir}/unit_${pad(index, 4)}.h`,
      `#pragma once\nint fn_${pad(index, 4)}(int value);\n`,
    );
    const lines = [`#include "unit_${pad(index, 4)}.h"`];
    if (index + 1 < half) {
      lines.push(`#include "unit_${pad(index + 1, 4)}.h"`);
    }
    lines.push(
      `int fn_${pad(index, 4)}(int value) { return ${
        index + 1 < half ? `fn_${pad(index + 1, 4)}(value)` : `value + ${index}`
      }; }`,
    );
    contents.set(`${unit.dir}/unit_${pad(index, 4)}.cpp`, `${lines.join('\n')}\n`);
  }
  for (const file of files) {
    if (!contents.has(file)) {
      contents.set(file, `int unused_${path.posix.basename(file).replace(/\W+/g, '_')}(void) { return 0; }\n`);
    }
  }
  return { files, contents };
}

function renderKotlin(unit) {
  const id = unit.dir.slice(unit.dir.lastIndexOf('kt') + 2);
  const pkg = `com.acme.kt${id}`;
  const files = [];
  for (let index = 0; index < unit.size; index += 1) {
    files.push(`${unit.dir}/Type_${pad(index, 4)}.kt`);
  }
  const contents = new Map();
  for (let index = 0; index < unit.size; index += 1) {
    const targets = forwardTargets(unit.rng, index, unit.size, 2);
    const lines = [`package ${pkg}`, ''];
    for (const target of targets) {
      lines.push(`import ${pkg}.Type_${pad(target, 4)}`);
    }
    lines.push('');
    lines.push(`class Type_${pad(index, 4)} {`);
    lines.push(`  fun fn_${pad(index, 4)}(value: Int): Int = value + ${index}`);
    if (targets.length > 0) {
      lines.push(
        `  fun use(other: Type_${pad(targets[0], 4)}): Int = other.fn_${pad(targets[0], 4)}(1)`,
      );
    }
    lines.push('}');
    contents.set(files[index], `${lines.join('\n')}\n`);
  }
  return { files, contents };
}

function renderSql(unit) {
  const files = [];
  for (let index = 0; index < unit.size; index += 1) {
    files.push(`${unit.dir}/schema_${pad(index, 4)}.sql`);
  }
  const contents = new Map();
  for (let index = 0; index < unit.size; index += 1) {
    contents.set(
      files[index],
      `CREATE TABLE t_${pad(index, 4)} (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\n` +
        `CREATE INDEX idx_t_${pad(index, 4)} ON t_${pad(index, 4)} (name);\n`,
    );
  }
  return { files, contents };
}

/**
 * Build the full, ordered plan for a corpus. Exported so tests can inspect it without
 * writing 20k files to disk.
 */
export function planCorpus({ files = DEFAULT_FILES, seed = DEFAULT_SEED, plan = CORPUS_LANGUAGES } = {}) {
  const rng = createRng(seed);
  const allocation = allocateFiles(files, plan);
  const units = [];
  let componentIndex = 0;

  const kernel = [];
  for (let index = 0; index < Math.min(KERNEL_MODULES, Math.max(1, Math.floor(files * 0.005))); index += 1) {
    kernel.push(`shared/kernel/src/mod_${pad(index, 4)}.ts`);
  }

  const languageOrder = plan.map((entry) => entry.language);
  for (const language of languageOrder) {
    const count = allocation.get(language) ?? 0;
    if (count === 0) {
      continue;
    }
    for (const unit of buildUnits(language, count, rng)) {
      if (unit.kind === 'tslike') {
        unit.__componentIndex = componentIndex;
        componentIndex += 1;
      }
      units.push(unit);
    }
  }

  return { units, kernel, allocation, seed, files };
}

/** Render every planned unit to `{ path: content }`, in deterministic order. */
export function renderCorpus(plan) {
  const out = new Map();
  for (const file of plan.kernel) {
    const index = Number(/(\d+)\.ts$/.exec(file)?.[1] ?? 0);
    out.set(
      file,
      `export function kernel_${pad(index, 4)}(): number { return ${index}; }\n`,
    );
  }
  for (const unit of plan.units) {
    const { files, contents } = renderUnit(unit, plan.kernel);
    for (const file of files) {
      out.set(file, contents.get(file) ?? '');
    }
  }
  return out;
}

/** Count files per extension and per language for the manifest. */
export function summarise(rendered) {
  const extensions = {};
  const languages = {};
  const languageOf = new Map();
  for (const entry of CORPUS_LANGUAGES) {
    for (const extension of entry.extensions) {
      languageOf.set(extension, entry.language);
    }
  }
  for (const file of rendered.keys()) {
    const dot = file.lastIndexOf('.');
    const extension = dot === -1 ? '<none>' : file.slice(dot);
    extensions[extension] = (extensions[extension] ?? 0) + 1;
    const language = languageOf.get(extension) ?? 'unknown';
    languages[language] = (languages[language] ?? 0) + 1;
  }
  return { extensions, languages, total: rendered.size };
}

/** Write a rendered corpus under `root`, replacing any existing tree there. */
export function writeCorpus(root, rendered) {
  fs.rmSync(root, { recursive: true, force: true });
  for (const [file, content] of rendered) {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
}

export function manifestFor(plan, rendered, command) {
  const summary = summarise(rendered);
  return {
    kind: 'synthetic',
    generator: 'scripts/bench-corpus.mjs',
    seed: plan.seed,
    requestedFiles: plan.files,
    generatedFiles: rendered.size,
    languages: summary.languages,
    extensions: summary.extensions,
    regenerate: command,
  };
}

export function defaultManifestPath(outDir) {
  return `${path.resolve(outDir)}.manifest.json`;
}

function parseArgs(argv) {
  let out;
  let files = DEFAULT_FILES;
  let seed = DEFAULT_SEED;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') {
      out = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
    } else if (arg === '--files') {
      files = Number(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith('--files=')) {
      files = Number(arg.slice('--files='.length));
    } else if (arg === '--seed') {
      seed = Number(argv[index + 1]);
      index += 1;
    } else if (arg.startsWith('--seed=')) {
      seed = Number(arg.slice('--seed='.length));
    }
  }
  return { out, files, seed };
}

export async function main(argv) {
  const options = parseArgs(argv);
  if (!options.out) {
    throw new Error('Missing --out <directory>. The corpus is generated outside the repository.');
  }
  if (!Number.isInteger(options.files) || options.files < 1) {
    throw new Error(`--files must be a positive integer, got ${options.files}`);
  }
  if (!Number.isInteger(options.seed)) {
    throw new Error(`--seed must be an integer, got ${options.seed}`);
  }
  const outDir = path.resolve(options.out);
  if (outDir === repoRoot || outDir.startsWith(`${repoRoot}${path.sep}`)) {
    throw new Error(
      `Refusing to generate the corpus inside the Strabo repository (${outDir}); use a temp directory.`,
    );
  }
  const plan = planCorpus({ files: options.files, seed: options.seed });
  const rendered = renderCorpus(plan);
  writeCorpus(outDir, rendered);
  const regenerate =
    `node scripts/bench-corpus.mjs --out ${outDir} --files ${options.files} --seed ${options.seed}`;
  const manifest = manifestFor(plan, rendered, regenerate);
  const manifestPath = defaultManifestPath(outDir);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `Wrote ${manifest.generatedFiles} synthetic source files to ${outDir}\n` +
      `Manifest: ${manifestPath}\n` +
      `Languages: ${Object.entries(manifest.languages)
        .map(([name, count]) => `${name}=${count}`)
        .join(', ')}\n`,
  );
  return { outDir, manifestPath, manifest };
}

const entry = process.argv[1];
const isDirectRun = entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href;
if (isDirectRun) {
  await main(process.argv.slice(2));
}
