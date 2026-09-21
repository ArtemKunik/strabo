import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  extractCppFacts,
  extractCppSymbols,
  resolveCpp,
  type CppFileFacts,
} from '../../src/scan/languages/cpp.ts';
import { symbolExtractorFor } from '../../src/scan/languages/registry.ts';
import { scanRepository } from '../../src/scan/scan.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'cpp-repo');

function pairs(edges: Array<{ source: string; target: string }>): Set<string> {
  return new Set(edges.map((edge) => `${edge.source}->${edge.target}`));
}

async function resolveSources(sources: Record<string, string>) {
  const facts: CppFileFacts[] = [];
  for (const [file, content] of Object.entries(sources)) {
    facts.push((await extractCppFacts(file, content)).facts);
  }
  return resolveCpp(facts);
}

test('extractCppFacts separates quoted includes from angled ones', async () => {
  const source = [
    '#include "widget.h"',
    '#include <vector>',
    '#ifdef DEBUG',
    '#include "debug/trace.h"',
    '#endif',
  ].join('\n');

  const { facts, diagnostics } = await extractCppFacts('src/main.cpp', source);

  assert.deepEqual(diagnostics, []);
  assert.deepEqual(
    facts.includes.map((entry) => [entry.path, entry.quoted]),
    [
      ['widget.h', true],
      ['vector', false],
      // An include inside a preprocessor block is still a real dependency.
      ['debug/trace.h', true],
    ],
  );
});

test('a quoted include resolves beside the including file first', async () => {
  const { edges } = await resolveSources({
    'src/util/log.h': '',
    'src/util/log.cpp': '#include "log.h"',
  });

  assert.deepEqual([...pairs(edges)], ['src/util/log.cpp->src/util/log.h']);
  assert.equal(edges[0]?.evidence.resolution, 'exact');
});

test('an include written against an unknown -I root resolves by path suffix', async () => {
  const { edges, diagnostics } = await resolveSources({
    'include/acme/widget.h': '',
    // Neither beside the file nor at the repository root; only `include/` makes it work.
    'src/widget.cpp': '#include "acme/widget.h"',
  });

  assert.deepEqual([...pairs(edges)], ['src/widget.cpp->include/acme/widget.h']);
  assert.equal(edges[0]?.evidence.resolution, 'root');
  assert.deepEqual(diagnostics, []);
});

test('a `..` include is normalised rather than matched literally', async () => {
  const { edges } = await resolveSources({
    'src/core/engine.h': '',
    'src/ui/panel.cpp': '#include "../core/engine.h"',
  });

  assert.deepEqual([...pairs(edges)], ['src/ui/panel.cpp->src/core/engine.h']);
});

test('an angled include is never an edge and never a diagnostic', async () => {
  const { edges, diagnostics } = await resolveSources({
    'src/main.cpp': ['#include <vector>', '#include <acme/widget.h>'].join('\n'),
  });

  assert.deepEqual(edges, []);
  assert.deepEqual(diagnostics, []);
});

test('a quoted include that matches nothing is reported', async () => {
  const { edges, diagnostics } = await resolveSources({
    'src/main.cpp': '#include "missing/gone.h"',
  });

  assert.deepEqual(edges, []);
  assert.equal(diagnostics[0]?.kind, 'unresolved');
  assert.equal(diagnostics[0]?.specifier, 'missing/gone.h');
});

test('an include matching two files by suffix is ambiguous, not guessed', async () => {
  const { edges, diagnostics } = await resolveSources({
    'a/util/log.h': '',
    'b/util/log.h': '',
    'src/main.cpp': '#include "util/log.h"',
  });

  assert.deepEqual(edges, []);
  assert.equal(diagnostics[0]?.kind, 'ambiguous');
  assert.match(diagnostics[0]?.message ?? '', /matches 2 files/);
});

test('access is positional: a label applies until the next one', async () => {
  const source = [
    'class Widget {',
    '  int hidden_ = 0;',   // a class is private by default
    'public:',
    '  int open = 1;',
    '  void run();',
    'protected:',
    '  int guarded = 2;',
    '};',
    'struct Plain {',
    '  int visible = 3;',   // a struct is public by default
    '};',
  ].join('\n');

  const { symbols } = await extractCppSymbols('w.h', source);
  const visibility = (name: string) => symbols.find((symbol) => symbol.name === name)?.visibility;

  assert.equal(visibility('hidden_'), 'private');
  assert.equal(visibility('open'), 'public');
  assert.equal(visibility('run'), 'public');
  assert.equal(visibility('guarded'), 'protected');
  assert.equal(visibility('visible'), 'public');
});

test('a declaration and its out-of-line definition are one member, measured at the body', async () => {
  const source = [
    'class Widget {',
    'public:',
    '  void render();',
    '};',
    '',
    'void Widget::render() {',
    '  int x = 0;',
    '}',
  ].join('\n');

  const { symbols } = await extractCppSymbols('widget.cpp', source);
  const render = symbols.filter((symbol) => symbol.name === 'render');

  assert.equal(render.length, 1, 'the method is not listed twice');
  assert.equal(render[0]?.owner, 'Widget');
  // Measured from the definition, not from the declaration eight lines above it.
  assert.equal(render[0]?.metrics?.lines, 3);
});

test('an out-of-line definition takes its owner from the qualified name', async () => {
  const source = 'namespace acme {\nvoid Widget::render() { }\n}';

  const { symbols } = await extractCppSymbols('widget.cpp', source);

  // The namespace falls away; the segment before the method names the type.
  assert.equal(symbols.find((symbol) => symbol.name === 'render')?.owner, 'Widget');
});

test('a bodyless declaration carries no metrics, and an inline definition does', async () => {
  const source = [
    'class Widget {',
    'public:',
    '  void declared();',
    '  int inline_one() { return 1; }',
    '};',
  ].join('\n');

  const { symbols } = await extractCppSymbols('w.h', source);

  assert.equal(symbols.find((symbol) => symbol.name === 'declared')?.metrics, undefined);
  assert.ok(symbols.find((symbol) => symbol.name === 'inline_one')?.metrics);
});

test('fields, member access, and a this-> call are recorded', async () => {
  const source = [
    'class Store {',
    '  int value_ = 0;',
    'public:',
    '  int read() const { return value_; }',
    '  void write(int next) {',
    '    value_ = next;',
    '    other.compute();',
    '    this->read();',
    '  }',
    '};',
  ].join('\n');

  const { symbols, accesses, calls } = await extractCppSymbols('store.h', source);

  assert.equal(symbols.find((symbol) => symbol.name === 'value_')?.type, 'int');
  assert.ok(accesses?.some((entry) => entry.field === 'value_' && entry.method === 'read' && entry.mode === 'read'));
  assert.ok(accesses?.some((entry) => entry.field === 'value_' && entry.method === 'write' && entry.mode === 'write'));
  assert.ok(calls?.some((entry) => entry.method === 'write' && entry.callee === 'read' && entry.kind === 'self'));
  // The receiver's type is not known, so `other.compute()` is not claimed.
  assert.equal(calls?.some((entry) => entry.callee === 'compute'), false);
});

test('function metrics count C++ branching', async () => {
  const source = [
    'void walk(int n) {',
    '  for (int i = 0; i < n; ++i) {',
    '    if (i % 2 == 0 && n > 1) {',
    '      continue;',
    '    }',
    '  }',
    '}',
  ].join('\n');

  const { symbols } = await extractCppSymbols('w.cpp', source);
  const metrics = symbols.find((symbol) => symbol.name === 'walk')?.metrics;

  // 1 base + for + if + `&&`.
  assert.equal(metrics?.decisionPoints, 4);
  assert.equal(metrics?.maxNestingDepth, 2);
});

test('symbolExtractorFor covers the C++ header and implementation extensions', () => {
  for (const file of ['a.cpp', 'a.cc', 'a.cxx', 'a.hpp', 'a.hh', 'a.hxx', 'a.h']) {
    assert.equal(symbolExtractorFor(file)?.language, 'cpp', file);
  }
});

test('scanning the C++ fixture resolves includes and reports only the real miss', async () => {
  const report = await scanRepository(fixture);
  const drawn = pairs(report.graph.edges);

  assert.ok(drawn.has('src/widget.cpp->include/acme/widget.h'));
  assert.ok(drawn.has('src/widget.cpp->src/util/log.h'));
  assert.ok(drawn.has('include/acme/widget.h->include/acme/base.h'));
  assert.ok(drawn.has('src/util/log.cpp->src/util/log.h'));

  // `<string>` and `<vector>` are system headers; only the quoted miss is reported.
  const reported = report.graph.diagnostics.filter((entry) => entry.kind !== 'info');
  assert.equal(reported.length, 1);
  assert.equal(reported[0]?.specifier, 'missing/gone.h');

  // C++ no longer reports itself as an unimplemented language.
  assert.equal(
    report.graph.diagnostics.some((entry) => entry.message.includes('cpp resolution is not implemented')),
    false,
  );
});

test('without its header, an implementation records no access rather than a false zero', async () => {
  const source = 'void Widget::render() { count_ = 0; }';

  const { symbols, accesses } = await extractCppSymbols('widget.cpp', source);

  assert.equal(symbols.find((symbol) => symbol.name === 'render')?.owner, 'Widget');
  assert.deepEqual(accesses, []);
});

test('an implementation borrows the fields its header declares, and says where from', async () => {
  const header = [
    'class Widget {',
    'public:',
    '  void render();',
    '  void reset();',
    'private:',
    '  int count_ = 0;',
    '};',
  ].join('\n');
  const source = ['void Widget::render() {', '  count_ += 1;', '  this->reset();', '}'].join('\n');

  const { symbols, accesses, calls } = await extractCppSymbols('src/widget.cpp', source, {
    related: new Map([['include/widget.h', header]]),
  });

  const field = symbols.find((symbol) => symbol.name === 'count_');
  assert.equal(field?.owner, 'Widget');
  assert.equal(field?.visibility, 'private');
  assert.equal(field?.declaredIn, 'include/widget.h', 'the borrowed member names its source');
  assert.ok(accesses?.some((entry) => entry.field === 'count_' && entry.method === 'render'));
  // `reset` is declared only in the header, and is still a provable call target.
  assert.ok(calls?.some((entry) => entry.method === 'render' && entry.callee === 'reset'));
});

test('a member declared in this file carries no declaredIn', async () => {
  const source = ['class Widget {', '  int here_ = 0;', 'public:', '  int read() { return here_; }', '};'].join('\n');

  const { symbols } = await extractCppSymbols('widget.h', source);

  assert.equal(symbols.find((symbol) => symbol.name === 'here_')?.declaredIn, undefined);
});

test('an unrelated header contributes nothing to the file that includes it', async () => {
  // Only a type this file actually implements can have its state explained here.
  const unrelated = ['class Logger {', 'public:', '  int sink_ = 0;', '};'].join('\n');
  const source = 'void Widget::render() { }';

  const { symbols } = await extractCppSymbols('src/widget.cpp', source, {
    related: new Map([['src/util/log.h', unrelated]]),
  });

  assert.equal(symbols.some((symbol) => symbol.name === 'sink_'), false);
  assert.equal(symbols.some((symbol) => symbol.name === 'Logger'), false);
});

function callPairs(edges: Array<{ source: string; target: string; kind: string }>): string[] {
  return edges.filter((edge) => edge.kind === 'call').map((edge) => `${edge.source}->${edge.target}`);
}

test('a call to a function declared in an included header becomes a call edge', async () => {
  const { edges } = await resolveSources({
    'src/widget.cpp': '#include "widget.h"\nvoid run() { render(); }\n',
    'src/widget.h': '#pragma once\nvoid render();\n',
  });

  assert.deepEqual(callPairs(edges), ['src/widget.cpp->src/widget.h']);
});

test('a qualified call resolves to the included header that declares the type', async () => {
  const { edges } = await resolveSources({
    'src/widget.cpp': '#include "widget.h"\nvoid run() { Widget::render(); }\n',
    'src/widget.h': '#pragma once\nclass Widget { public: static void render(); };\n',
  });

  assert.deepEqual(callPairs(edges), ['src/widget.cpp->src/widget.h']);
});

test('a call to a name no included header declares is not claimed', async () => {
  const { edges } = await resolveSources({
    'src/widget.cpp': '#include "widget.h"\nvoid run() { missing(); }\n',
    'src/widget.h': '#pragma once\nvoid render();\n',
  });

  assert.deepEqual(callPairs(edges), []);
});
