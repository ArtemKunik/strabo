import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { symbolExtractorFor } from '../../src/index.ts';
import {
  extractPythonFacts,
  extractPythonSymbols,
  resolvePython,
  type PythonFileFacts,
} from '../../src/scan/languages/python.ts';
import { scanRepository } from '../../src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'python-repo');

function pairs(edges: Array<{ source: string; target: string }>): Set<string> {
  return new Set(edges.map((edge) => `${edge.source}->${edge.target}`));
}

/** Resolve a set of files whose only content is their import statements. */
async function resolveSources(sources: Record<string, string>) {
  const facts: PythonFileFacts[] = [];
  for (const [file, content] of Object.entries(sources)) {
    facts.push((await extractPythonFacts(file, content)).facts);
  }
  return resolvePython(facts);
}

test('extractPythonFacts reads plain, aliased, relative, and wildcard imports', async () => {
  const source = [
    'import os',
    'import numpy as np',
    'from app.services import UserService, Other',
    'from . import sibling',
    'from ..pkg.deep import thing as alias',
    'from app.models import *',
  ].join('\n');

  const { facts, diagnostics } = await extractPythonFacts('app/main.py', source);

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(
    facts.imports.map((entry) => [entry.module, entry.names, entry.relativeDepth, entry.wildcard]),
    [
      ['os', [], 0, false],
      // An alias is recorded under the module it renames, not under the local name.
      ['numpy', [], 0, false],
      ['app.services', ['UserService', 'Other'], 0, false],
      ['', ['sibling'], 1, false],
      ['pkg.deep', ['thing'], 2, false],
      ['app.models', [], 0, true],
    ],
  );
});

test('extractPythonFacts records a deferred import inside a function', async () => {
  const source = ['def late():', '    from app.heavy import Thing', '    return Thing'].join('\n');

  const { facts } = await extractPythonFacts('app/main.py', source);

  assert.deepEqual(facts.imports.map((entry) => entry.module), ['app.heavy']);
  assert.equal(facts.imports[0]?.line, 2);
});

test('resolvePython finds the source root from __init__.py, so a src/ layout resolves', async () => {
  const { edges, diagnostics } = await resolveSources({
    'src/app/__init__.py': '',
    'src/app/config.py': 'SETTINGS = {}',
    'scripts/run.py': 'from app.config import SETTINGS',
  });

  assert.deepEqual([...pairs(edges)], ['scripts/run.py->src/app/config.py']);
  assert.deepEqual(diagnostics, []);
});

test('resolvePython resolves a relative import against the importing package', async () => {
  const { edges } = await resolveSources({
    'app/__init__.py': '',
    'app/config.py': '',
    'app/services/__init__.py': '',
    'app/services/helpers.py': '',
    'app/services/main.py': ['from . import helpers', 'from ..config import SETTINGS'].join('\n'),
  });

  const drawn = pairs(edges);
  assert.ok(drawn.has('app/services/main.py->app/services/helpers.py'), 'depth 1 names its own package');
  assert.ok(drawn.has('app/services/main.py->app/config.py'), 'depth 2 names the parent package');
});

test("a package's __init__ resolves `.` to itself, not to its parent", async () => {
  const { edges } = await resolveSources({
    'app/__init__.py': '',
    'app/services/__init__.py': 'from . import helpers',
    'app/services/helpers.py': '',
  });

  assert.deepEqual([...pairs(edges)], ['app/services/__init__.py->app/services/helpers.py']);
});

test('a relative import climbing above the source root is reported, not drawn', async () => {
  const { edges, diagnostics } = await resolveSources({
    'app/__init__.py': '',
    'app/main.py': 'from ....far import thing',
  });

  assert.deepEqual(edges, []);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.kind, 'unresolved');
  assert.match(diagnostics[0]?.message ?? '', /climbs above the source root/);
});

test('from a package, a submodule and the package itself are both recorded', async () => {
  const { edges } = await resolveSources({
    'app/__init__.py': '',
    'app/models/__init__.py': 'VERSION = 1',
    'app/models/user.py': '',
    'app/main.py': 'from app.models import user',
  });

  const drawn = pairs(edges);
  assert.ok(drawn.has('app/main.py->app/models/user.py'), 'the submodule is loaded');
  assert.ok(drawn.has('app/main.py->app/models/__init__.py'), 'the package body runs too');
  assert.equal(
    edges.find((edge) => edge.target === 'app/models/user.py')?.evidence.resolution,
    'module-tree',
  );
});

test('`from . import x` reads as `.x`, not `..x`', async () => {
  const { edges } = await resolveSources({
    'app/__init__.py': '',
    'app/helpers.py': '',
    'app/main.py': 'from . import helpers',
  });

  assert.equal(edges[0]?.evidence.specifier, '.helpers');
});

test('an import that looks internal but matches nothing is a diagnostic, not an edge', async () => {
  const { edges, diagnostics } = await resolveSources({
    'app/__init__.py': '',
    'app/main.py': ['from app.missing import Ghost', 'import requests'].join('\n'),
  });

  assert.deepEqual(edges, []);
  // `requests` shares no package with the repository, so it is external and stays silent.
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]?.specifier, 'app.missing');
  assert.equal(diagnostics[0]?.kind, 'unresolved');
});

test('two files claiming one module name are reported as ambiguous rather than picked', async () => {
  const { edges, diagnostics } = await resolveSources({
    // `src` and `lib` are both source roots, so each spells the same module `pkg.mod`.
    'src/pkg/__init__.py': '',
    'src/pkg/mod.py': '',
    'lib/pkg/__init__.py': '',
    'lib/pkg/mod.py': '',
    'main.py': 'from pkg.mod import thing',
  });

  assert.deepEqual(edges, []);
  assert.equal(diagnostics[0]?.kind, 'ambiguous');
  assert.match(diagnostics[0]?.message ?? '', /claimed by 2 files/);
});

test('extractPythonSymbols records classes, class attributes, and methods', async () => {
  const source = [
    'class Repo(Base):',
    '    limit: int = 10',
    '    _hidden = None',
    '',
    '    def __init__(self, conn):',
    '        self.conn = conn',
    '        self.__secret = 1',
    '',
    '    def fetch(self, key, fallback=None):',
    '        return self.conn',
    '',
    'TOP = 1',
    '',
    'def helper(a):',
    '    return a',
  ].join('\n');

  const { symbols, diagnostics } = await extractPythonSymbols('app/repo.py', source);

  assert.deepEqual(diagnostics, []);
  const find = (name: string) => symbols.find((symbol) => symbol.name === name);
  assert.equal(find('Repo')?.kind, 'type');
  assert.equal(find('limit')?.type, 'int');
  assert.equal(find('limit')?.owner, 'Repo');
  // Instance state is declared by assignment in a method, not in the class body.
  assert.equal(find('conn')?.kind, 'field');
  assert.equal(find('conn')?.owner, 'Repo');
  // Top-level declarations are grouped under the module's base name.
  assert.equal(find('TOP')?.owner, 'repo');
  assert.equal(find('helper')?.owner, 'repo');
});

test('visibility follows the underscore convention, and a dunder stays public', async () => {
  const source = [
    'class C:',
    '    def __init__(self):',
    '        self.open = 1',
    '        self._guarded = 2',
    '        self.__private = 3',
    '',
    '    def __str__(self):',
    '        return ""',
  ].join('\n');

  const { symbols } = await extractPythonSymbols('c.py', source);
  const visibility = (name: string) => symbols.find((symbol) => symbol.name === name)?.visibility;

  assert.equal(visibility('open'), 'public');
  assert.equal(visibility('_guarded'), 'protected');
  assert.equal(visibility('__private'), 'private');
  assert.equal(visibility('__init__'), 'public');
  assert.equal(visibility('__str__'), 'public');
});

test('the bound receiver is not counted as a parameter', async () => {
  const source = [
    'class C:',
    '    def none(self):',
    '        pass',
    '    def two(self, a, b=1):',
    '        pass',
    '    @classmethod',
    '    def made(cls, a):',
    '        pass',
    '',
    'def free(a, b):',
    '    pass',
  ].join('\n');

  const { symbols } = await extractPythonSymbols('c.py', source);
  const parameters = (name: string) => symbols.find((symbol) => symbol.name === name)?.parameters;

  assert.equal(parameters('none'), 0);
  assert.equal(parameters('two'), 2);
  assert.equal(parameters('made'), 1, 'a decorated classmethod is still found, without cls');
  assert.equal(parameters('free'), 2);
});

test('function metrics count Python branching, and recursion is marked', async () => {
  const source = [
    'def walk(items, flag):',
    '    total = 0',
    '    for item in items:',
    '        if item and flag:',
    '            total += 1',
    '        elif item:',
    '            total += walk([], flag)',
    '    return total',
  ].join('\n');

  const { symbols } = await extractPythonSymbols('w.py', source);
  const metrics = symbols.find((symbol) => symbol.name === 'walk')?.metrics;

  // 1 base + for + if + `and` + elif.
  assert.equal(metrics?.decisionPoints, 5);
  assert.equal(metrics?.maxNestingDepth, 2);
  assert.equal(metrics?.recursive, true);
});

test('member access and self calls are recorded; a call on a value is not claimed', async () => {
  const source = [
    'class Store:',
    '    def __init__(self):',
    '        self.value = 0',
    '',
    '    def read(self):',
    '        return self.value',
    '',
    '    def write(self, value):',
    '        self.value = value',
    '        other.compute()',
    '        return self.read()',
  ].join('\n');

  const { accesses, calls } = await extractPythonSymbols('store.py', source);

  assert.ok(accesses?.some((entry) => entry.field === 'value' && entry.method === 'read' && entry.mode === 'read'));
  assert.ok(accesses?.some((entry) => entry.field === 'value' && entry.method === 'write' && entry.mode === 'write'));
  // The parameter shadows the field, so the bare `value` on the right is not a field read.
  assert.ok(calls?.some((entry) => entry.method === 'write' && entry.callee === 'read' && entry.kind === 'self'));
  assert.equal(calls?.some((entry) => entry.callee === 'compute'), false);
});

test('symbolExtractorFor covers Python', () => {
  assert.equal(symbolExtractorFor('a.py')?.language, 'python');
  assert.equal(symbolExtractorFor('pkg/__init__.py')?.language, 'python');
});

test('scanning the Python fixture draws the recorded imports and nothing else', async () => {
  const report = await scanRepository(fixture);
  const drawn = pairs(report.graph.edges);

  assert.equal(report.graph.nodes.length, 8);
  assert.ok(drawn.has('scripts/run.py->src/app/services/user_service.py'));
  assert.ok(drawn.has('src/app/services/user_service.py->src/app/models/user.py'));
  assert.ok(drawn.has('src/app/services/user_service.py->src/app/config.py'));
  assert.ok(drawn.has('src/app/services/user_service.py->src/app/services/helpers.py'));
  assert.ok(drawn.has('src/app/__init__.py->src/app/config.py'));

  // `requests` and `dataclasses` are external; only the internal miss is reported.
  const unresolved = report.graph.diagnostics.filter((entry) => entry.kind === 'unresolved');
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0]?.specifier, 'app.missing');
});
