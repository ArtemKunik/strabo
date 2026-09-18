import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractCSharpFacts, resolveCSharp } from '../../src/scan/languages/csharp.ts';
import { scanRepository } from '../../src/scan/scan.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'csharp-repo');

test('extractCSharpFacts reads the namespace, using kinds, and nested types', async () => {
  const source = [
    'using System;',
    'using Acme.Util;',
    'using static Acme.Util.Helper;',
    'using Alias = Acme.Util.Widget;',
    'namespace Acme.App;',
    'public class Outer {',
    '  public class Inner {}',
    '}',
  ].join('\n');

  const { facts } = await extractCSharpFacts('Main.cs', source);

  assert.equal(facts.namespace, 'Acme.App');
  assert.deepEqual(facts.usings, [
    { kind: 'simple', target: 'System', line: 1 },
    { kind: 'simple', target: 'Acme.Util', line: 2 },
    { kind: 'static', target: 'Acme.Util.Helper', line: 3 },
    { kind: 'alias', target: 'Acme.Util.Widget', line: 4 },
  ]);
  assert.deepEqual(facts.types, [
    { name: 'Outer', line: 6 },
    { name: 'Outer.Inner', line: 7 },
  ]);
});

test('resolveCSharp links namespace imports to members and type imports exactly', () => {
  const { edges, diagnostics } = resolveCSharp([
    {
      file: 'App/Main.cs',
      namespace: 'Acme.App',
      usings: [
        { kind: 'simple', target: 'Acme.Util', line: 2 },
        { kind: 'static', target: 'Acme.Util.Helper', line: 3 },
        { kind: 'simple', target: 'System', line: 1 },
        { kind: 'simple', target: 'Acme.Util.Missing', line: 6 },
      ],
      types: [],
    },
    {
      file: 'Util/Helper.cs',
      namespace: 'Acme.Util',
      usings: [],
      types: [{ name: 'Helper', line: 1 }],
    },
    {
      file: 'Util/Widget.cs',
      namespace: 'Acme.Util',
      usings: [],
      types: [{ name: 'Widget', line: 1 }],
    },
  ]);

  const pairs = new Set(edges.map((edge) => `${edge.source}->${edge.target}`));
  assert.deepEqual(pairs, new Set(['App/Main.cs->Util/Helper.cs', 'App/Main.cs->Util/Widget.cs']));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.specifier, 'Acme.Util.Missing');
});

test('scanRepository resolves C# usings, including nested types, inside the repository', async () => {
  const report = await scanRepository(fixture);
  const resolved = new Set(report.graph.edges.map((edge) => `${edge.source}->${edge.target}`));
  const main = 'src/App/Main.cs';

  assert.ok(resolved.has(`${main}->src/Util/Helper.cs`));
  assert.ok(resolved.has(`${main}->src/Util/Widget.cs`));
  assert.ok(resolved.has(`${main}->src/Util/Outer.cs`));
});

test('scanRepository resolves C# same-namespace type references without a using', async () => {
  const report = await scanRepository(fixture);
  const resolved = new Set(report.graph.edges.map((edge) => `${edge.source}->${edge.target}`));

  assert.ok(resolved.has('src/Util/Registry.cs->src/Util/Helper.cs'));
  assert.ok(resolved.has('src/Util/Registry.cs->src/Util/Widget.cs'));
});

test('resolveCSharp reports an ambiguous same-namespace type reference', () => {
  const { diagnostics } = resolveCSharp([
    { file: 'Util/Alpha.cs', namespace: 'Acme.Util', usings: [], types: [{ name: 'Dupe', line: 1 }], typeReferences: [] },
    { file: 'Util/Beta.cs', namespace: 'Acme.Util', usings: [], types: [{ name: 'Dupe', line: 1 }], typeReferences: [] },
    {
      file: 'Util/User.cs',
      namespace: 'Acme.Util',
      usings: [],
      types: [{ name: 'User', line: 1 }],
      typeReferences: [{ name: 'Dupe', line: 3 }],
    },
  ]);

  const ambiguous = diagnostics.find((item) => item.kind === 'ambiguous');
  assert.ok(ambiguous);
  assert.equal(ambiguous.specifier, 'Dupe');
});

test('C# unresolved internal usings are diagnostics; System is ignored', async () => {
  const report = await scanRepository(fixture);
  const mainDiagnostics = report.graph.diagnostics.filter((item) => item.file.endsWith('Main.cs'));

  assert.ok(mainDiagnostics.some((item) => item.specifier === 'Acme.Util.Missing'));
  assert.ok(!mainDiagnostics.some((item) => item.specifier === 'System'));
});
