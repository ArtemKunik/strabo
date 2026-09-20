import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

interface ImportFact {
  typeOnly: boolean;
  specifier: string;
}

/**
 * Read `import` statements from a source string.
 *
 * A side-effect import (`import './x'`) and a value import are runtime imports; only
 * `import type ...` is erased. A mixed `import { type A, b }` is counted as runtime,
 * because it carries at least one value binding.
 */
function importsOf(source: string): ImportFact[] {
  const facts: ImportFact[] = [];
  const fromPattern = /^[ \t]*import\s+([^;]*?)\bfrom\s*['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(fromPattern)) {
    const clause = (match[1] ?? '').trim();
    facts.push({ typeOnly: clause.startsWith('type ') || clause === 'type', specifier: match[2] ?? '' });
  }
  const barePattern = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(barePattern)) {
    facts.push({ typeOnly: false, specifier: match[1] ?? '' });
  }
  return facts;
}

function typescriptFilesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...typescriptFilesUnder(absolute));
    } else if (entry.name.endsWith('.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

test('the shared contract module has no runtime imports', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'types.ts'), 'utf8');
  const runtime = importsOf(source).filter((fact) => !fact.typeOnly);

  assert.deepEqual(
    runtime,
    [],
    `src/types.ts must stay data-only; found runtime imports: ${runtime
      .map((fact) => fact.specifier)
      .join(', ')}`,
  );
});

test('the analysis layer never depends on the API layer', () => {
  const apiDir = path.join(root, 'src', 'api');
  const offenders: string[] = [];

  for (const file of typescriptFilesUnder(path.join(root, 'src', 'analysis'))) {
    for (const fact of importsOf(fs.readFileSync(file, 'utf8'))) {
      if (!fact.specifier.startsWith('.')) {
        continue;
      }
      const resolved = path.resolve(path.dirname(file), fact.specifier);
      if (isInside(resolved, apiDir)) {
        offenders.push(`${path.relative(root, file)} -> ${fact.specifier}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `analysis must not import api: ${offenders.join(', ')}`);
});
