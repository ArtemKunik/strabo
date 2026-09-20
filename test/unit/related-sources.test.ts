import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { collectRelatedSources } from '../../src/analysis/related-sources.ts';
import type { Graph } from '../../src/types.ts';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-related-'));
}

function graphOf(edges: Array<[string, string]>): Graph {
  return {
    nodes: [],
    edges: edges.map(([source, target]) => ({
      source,
      target,
      kind: 'import' as const,
      evidence: { line: 1, specifier: target, resolution: 'exact' as const },
    })),
    diagnostics: [],
    excluded: [],
    externalImports: [],
  } as unknown as Graph;
}

test('only the recorded dependencies of the named file are read', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'a.h'), 'A');
  fs.writeFileSync(path.join(root, 'b.h'), 'B');
  fs.writeFileSync(path.join(root, 'other.h'), 'OTHER');

  const related = collectRelatedSources(
    root,
    graphOf([
      ['main.cpp', 'a.h'],
      ['main.cpp', 'b.h'],
      ['unrelated.cpp', 'other.h'],
    ]),
    'main.cpp',
  );

  assert.deepEqual([...related.keys()].sort(), ['a.h', 'b.h']);
  assert.equal(related.get('a.h'), 'A');
});

test('a dependency that cannot be read is skipped, not fatal', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'present.h'), 'HERE');

  const related = collectRelatedSources(
    root,
    graphOf([
      ['main.cpp', 'present.h'],
      ['main.cpp', 'deleted.h'],
    ]),
    'main.cpp',
  );

  assert.deepEqual([...related.keys()], ['present.h']);
});

test('the number of dependencies read is bounded', () => {
  const root = tempRoot();
  const edges: Array<[string, string]> = [];
  for (let index = 0; index < 10; index += 1) {
    fs.writeFileSync(path.join(root, `h${index}.h`), 'X');
    edges.push(['main.cpp', `h${index}.h`]);
  }

  assert.equal(collectRelatedSources(root, graphOf(edges), 'main.cpp', 3).size, 3);
});

test('a dependency outside the scan ceiling is refused, not read', () => {
  const root = tempRoot();
  const outside = path.join(root, '..', `escape-${path.basename(root)}.h`);
  fs.writeFileSync(outside, 'SECRET');
  try {
    const related = collectRelatedSources(
      root,
      graphOf([['main.cpp', `../${path.basename(outside)}`]]),
      'main.cpp',
    );
    assert.equal(related.size, 0);
  } finally {
    fs.rmSync(outside, { force: true });
  }
});
