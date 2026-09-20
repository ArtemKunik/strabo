import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Copy package-owned grammar assets out of the `tree-sitter-wasm` devDependency into
 * `parsers/vendor/`, so a published Strabo tarball owns its parser assets and needs no
 * build toolchain or network access at runtime.
 *
 * Run with `npm run vendor:parsers`; `prepare` runs it automatically.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const sourceRoot = path.join(packageRoot, 'node_modules', 'tree-sitter-wasm', 'out');
const targetRoot = path.join(packageRoot, 'parsers', 'vendor');

/**
 * Grammars are **resolver-driven**: only languages with an implemented resolver are
 * vendored, so the published package does not carry unused multi-megabyte binaries.
 * Add a language here when its resolver lands and the runtime will find it automatically.
 */
const LANGUAGES = ['java', 'rust', 'c_sharp', 'kotlin', 'typescript', 'tsx'];

if (fs.existsSync(targetRoot)) {
  fs.rmSync(targetRoot, { recursive: true, force: true });
}

let copied = 0;
let missing = 0;

for (const language of LANGUAGES) {
  const filename = `tree-sitter-${language}.wasm`;
  const source = path.join(sourceRoot, language, filename);
  const target = path.join(targetRoot, language, filename);

  if (!fs.existsSync(source)) {
    console.warn(`[vendor:parsers] missing ${source}; skipped`);
    missing += 1;
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  copied += 1;
}

console.log(`[vendor:parsers] copied ${copied} grammar(s) to ${targetRoot}${missing ? `, ${missing} missing` : ''}`);
