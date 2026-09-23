import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { checkDeclaredRules, readDeclaredRules } from '../../src/analysis/rules.ts';
import type { StringEdge, StringEdgeReport } from '../../src/analysis/string-edges.ts';
import type { Graph } from '../../src/index.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // best-effort teardown
    }
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-rules-'));
  created.push(directory);
  return directory;
}

function write(root: string, file: string, content: string): void {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function graph(nodes: Graph['nodes'], edges: Graph['edges']): Graph {
  return { nodes, edges, diagnostics: [], excluded: [] };
}

function node(id: string): Graph['nodes'][number] {
  return { id, kind: 'module', directory: id.slice(0, id.lastIndexOf('/')) };
}

function edge(source: string, target: string): Graph['edges'][number] {
  return { source, target, kind: 'import', evidence: { line: 1, specifier: target, resolution: 'exact' } };
}

function stringReport(parts: {
  env?: StringEdge[];
  routes?: StringEdge[];
  flags?: StringEdge[];
}): StringEdgeReport {
  return {
    available: true,
    env: parts.env ?? [],
    routes: parts.routes ?? [],
    flags: parts.flags ?? [],
    diagnostics: [],
    totals: { env: 0, routes: 0, flags: 0, unresolved: 0 },
  };
}

test('checkDeclaredRules flags a never rule across domain to infra and not the reverse', () => {
  const g = graph(
    [node('domain/a.ts'), node('infra/b.ts')],
    [edge('domain/a.ts', 'infra/b.ts'), edge('infra/b.ts', 'domain/a.ts')],
  );

  const report = checkDeclaredRules(
    [{ id: 'domain-no-infra', from: 'domain/**', to: 'infra/**', allow: 'never' }],
    g,
  );

  assert.equal(report.available, true);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0]?.rule, 'domain-no-infra');
  assert.equal(report.violations[0]?.edge.source, 'domain/a.ts');
  assert.equal(report.violations[0]?.edge.target, 'infra/b.ts');
  assert.match(report.violations[0]?.detail ?? '', /domain\/a\.ts → infra\/b\.ts \(import\)/);
});

test("checkDeclaredRules tells an import edge from a string edge with allow import/string", () => {
  const g = graph([node('domain/a.ts'), node('infra/b.ts')], [edge('domain/a.ts', 'infra/b.ts')]);
  const strings = stringReport({
    env: [
      {
        kind: 'env',
        key: 'DATABASE_URL',
        readers: [{ file: 'domain/a.ts', line: 3 }],
        declarations: [{ file: 'infra/b.ts', line: 7 }],
        declared: true,
      },
    ],
  });

  const onlyImports = checkDeclaredRules(
    [{ id: 'no-strings', from: 'domain/**', to: 'infra/**', allow: 'import' }],
    g,
    { stringEdges: strings },
  );
  assert.deepEqual(onlyImports.violations.map((entry) => entry.edge.kind), ['env']);

  const onlyStrings = checkDeclaredRules(
    [{ id: 'no-imports', from: 'domain/**', to: 'infra/**', allow: 'string' }],
    g,
    { stringEdges: strings },
  );
  assert.deepEqual(onlyStrings.violations.map((entry) => entry.edge.kind), ['import']);
});

test('checkDeclaredRules reports a rule whose globs match no node as unused', () => {
  const g = graph([node('domain/a.ts'), node('infra/b.ts')], []);

  const report = checkDeclaredRules(
    [
      { id: 'ghost', from: 'nowhere/**', to: 'infra/**', allow: 'never' },
      { id: 'real', from: 'domain/**', to: 'infra/**', allow: 'never' },
    ],
    g,
  );

  assert.deepEqual(report.unused, ['ghost']);
  assert.deepEqual(report.violations, []);
});

test('checkDeclaredRules reports no rules as unavailable', () => {
  const report = checkDeclaredRules([], graph([node('domain/a.ts')], []));
  assert.equal(report.available, false);
  assert.equal(report.reason, 'no declared rules');
  assert.equal(report.checkedEdges, 0);
});

test('readDeclaredRules reads strabo.rules.yml and skips a malformed entry', () => {
  const root = tempDir();
  write(
    root,
    'strabo.rules.yml',
    [
      'rules:',
      '  - id: domain-no-infra',
      '    from: "domain/**"',
      '    to: "infra/**"',
      '    allow: never',
      '  - id: broken',
      '    from: "domain/**"',
      '    allow: never',
    ].join('\n'),
  );

  assert.deepEqual(readDeclaredRules(root), [
    { id: 'domain-no-infra', from: 'domain/**', to: 'infra/**', allow: 'never' },
  ]);
});

test('readDeclaredRules falls back to the rules key of strabo.groups.yml', () => {
  const root = tempDir();
  write(
    root,
    'strabo.groups.yml',
    ['rules:', '  - id: no-infra', '    from: "domain/**"', '    to: "infra/**"', '    allow: never'].join('\n'),
  );

  assert.deepEqual(readDeclaredRules(root).map((rule) => rule.id), ['no-infra']);
});

test('readDeclaredRules returns no rules when the file is absent', () => {
  assert.deepEqual(readDeclaredRules(tempDir()), []);
});
