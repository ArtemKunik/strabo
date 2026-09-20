import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractJavaFacts, resolveJava } from '../../src/index.ts';
import {
  GRAMMAR_LANGUAGES,
  availableGrammarLanguages,
  grammarPath,
} from '../../src/scan/languages/parser-runtime.ts';
import {
  POLYGLOT_RESOLVERS,
  UNRESOLVED_POLYGLOT_LANGUAGES,
  isResolvedPolyglotLanguage,
} from '../../src/scan/languages/resolvers.ts';
import { scanRepository } from '../../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'polyglot-repo');

function pairs(edges: Array<{ source: string; target: string }>): Set<string> {
  return new Set(edges.map((edge) => `${edge.source}->${edge.target}`));
}

test('grammar assets are present for every shipped language', () => {
  assert.deepEqual(availableGrammarLanguages(), [...GRAMMAR_LANGUAGES]);
  assert.ok(grammarPath('java')?.endsWith('tree-sitter-java.wasm'));
});

test('extractJavaFacts reads the package, imports, and declared types', async () => {
  const source = [
    'package com.acme.app;',
    'import com.acme.util.Helper;',
    'import static com.acme.util.Helper.VALUE;',
    'import com.acme.util.*;',
    'public class Main {}',
  ].join('\n');

  const { facts, diagnostics } = await extractJavaFacts('Main.java', source);

  assert.equal(facts.package, 'com.acme.app');
  assert.deepEqual(facts.types, [{ name: 'Main', line: 5 }]);
  assert.equal(facts.imports.length, 3);
  assert.deepEqual(facts.imports[0], {
    name: 'com.acme.util.Helper',
    static: false,
    wildcard: false,
    line: 2,
  });
  assert.equal(facts.imports[1]?.static, true);
  assert.equal(facts.imports[2]?.wildcard, true);
  assert.equal(diagnostics.length, 0);
});

test('extractJavaFacts records nested types with dotted names', async () => {
  const source = ['package com.acme.app;', 'public class Outer {', '  static class Inner {}', '}'].join('\n');
  const { facts } = await extractJavaFacts('Outer.java', source);

  assert.deepEqual(facts.types, [
    { name: 'Outer', line: 2 },
    { name: 'Outer.Inner', line: 3 },
  ]);
});

test('resolveJava reports an unresolved internal-looking import but not external ones', () => {
  const { edges, diagnostics } = resolveJava([
    {
      file: 'app/Main.java',
      package: 'com.acme.app',
      imports: [
        { name: 'com.acme.util.Helper', static: false, wildcard: false, line: 2 },
        { name: 'com.acme.util', static: false, wildcard: true, line: 3 },
        { name: 'com.acme.missing.Gone', static: false, wildcard: false, line: 4 },
        { name: 'java.util.List', static: false, wildcard: false, line: 5 },
        { name: 'com.google.common.collect.Lists', static: false, wildcard: false, line: 6 },
      ],
      types: [{ name: 'Main', line: 7 }],
    },
    { file: 'util/Helper.java', package: 'com.acme.util', imports: [], types: [{ name: 'Helper', line: 1 }] },
  ]);

  assert.deepEqual(pairs(edges), new Set(['app/Main.java->util/Helper.java']));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.specifier, 'com.acme.missing.Gone');
  assert.equal(diagnostics[0]?.kind, 'unresolved');
});

test('scanRepository resolves Java package imports into internal edges', async () => {
  const report = await scanRepository(fixture);
  const resolved = pairs(report.graph.edges);

  assert.ok(resolved.has('src/main/java/com/acme/app/Main.java->src/main/java/com/acme/util/Helper.java'));
  assert.ok(resolved.has('src/main/java/com/acme/app/Main.java->src/main/java/com/acme/util/Widget.java'));
  assert.ok(resolved.has('src/main/java/com/acme/app/Static.java->src/main/java/com/acme/util/Helper.java'));
});

test('scanRepository resolves a nested-type import to its declaring file', async () => {
  const report = await scanRepository(fixture);
  const edge = report.graph.edges.find(
    (candidate) =>
      candidate.source.endsWith('app/Outer.java') && candidate.target.endsWith('util/Helper.java'),
  );

  assert.ok(edge);
  assert.equal(edge.evidence.specifier, 'com.acme.util.Helper.Nested');
  assert.equal(edge.evidence.resolution, 'exact');
});

test('scanRepository resolves same-package type references without an import', async () => {
  const report = await scanRepository(fixture);
  const resolved = new Set(report.graph.edges.map((edge) => `${edge.source}->${edge.target}`));

  assert.ok(
    resolved.has('src/main/java/com/acme/app/Main.java->src/main/java/com/acme/app/Sibling.java'),
  );
  assert.ok(
    resolved.has('src/main/java/com/acme/app/Main.java->src/main/java/com/acme/app/Outer.java'),
  );
});

test('resolveJava reports an ambiguous same-package type reference', () => {
  const { diagnostics } = resolveJava([
    {
      file: 'app/Alpha.java',
      package: 'com.acme.app',
      imports: [],
      types: [{ name: 'Dupe', line: 1 }],
      typeReferences: [],
    },
    {
      file: 'app/Beta.java',
      package: 'com.acme.app',
      imports: [],
      types: [{ name: 'Dupe', line: 1 }],
      typeReferences: [],
    },
    {
      file: 'app/User.java',
      package: 'com.acme.app',
      imports: [],
      types: [{ name: 'User', line: 1 }],
      typeReferences: [{ name: 'Dupe', line: 3 }],
    },
  ]);

  const ambiguous = diagnostics.find((item) => item.kind === 'ambiguous');
  assert.ok(ambiguous);
  assert.equal(ambiguous.specifier, 'Dupe');
});

test('previously unresolved Java imports now resolve to internal files; external JDK imports are ignored', async () => {
   const report = await scanRepository(fixture);
   const javaDiagnostics = report.graph.diagnostics.filter((item) => item.file.endsWith('Main.java'));

   assert.ok(!javaDiagnostics.some((item) => item.specifier === 'com.acme.missing.Gone'));
   assert.ok(report.graph.edges.some((edge) => edge.source.includes('Main.java') && edge.target.includes('missing/Gone.java')));
   assert.ok(!javaDiagnostics.some((item) => item.specifier === 'java.util.List'));
   assert.ok(!report.graph.edges.some((edge) => edge.source.includes('java/util') || edge.target.includes('java/util')));
});

test('every recognised polyglot language now has a resolver', () => {
  // The unsupported-language report is driven by this list, so an empty list is the claim
  // that nothing recognised by extension is silently dropped.
  assert.deepEqual(UNRESOLVED_POLYGLOT_LANGUAGES, []);
  for (const resolver of POLYGLOT_RESOLVERS) {
    assert.equal(isResolvedPolyglotLanguage(resolver.language), true, resolver.language);
    assert.ok(resolver.extensions.length > 0, resolver.language);
  }
});

test('a C++ file is resolved rather than reported as unsupported', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-cpp-'));
  try {
    fs.writeFileSync(path.join(directory, 'engine.h'), '#pragma once\n');
    fs.writeFileSync(path.join(directory, 'engine.cpp'), '#include "engine.h"\nint main() { return 0; }\n');
    const report = await scanRepository(directory);

    assert.equal(report.graph.diagnostics.some((item) => item.kind === 'unsupported'), false);
    assert.ok(
      report.graph.edges.some((edge) => edge.source === 'engine.cpp' && edge.target === 'engine.h'),
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SQL files are resolved, not reported as unsupported', async () => {
  const report = await scanRepository(fixture);

  assert.ok(!report.graph.diagnostics.some((item) => item.file.endsWith('schema.sql')));
});

test('Java edges are deterministic across scans', async () => {
  const first = await scanRepository(fixture);
  const second = await scanRepository(fixture);
  assert.deepEqual([...pairs(first.graph.edges)].sort(), [...pairs(second.graph.edges)].sort());
});
