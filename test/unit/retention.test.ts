import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildRetention, declaredTypeName, retentionTokens } from '../../src/analysis/retention.ts';
import type { CodeSymbol, FunctionCall } from '../../src/scan/languages/symbols.ts';

function field(name: string, type: string, line: number, owner = 'Holder'): CodeSymbol {
  return { name, kind: 'field', visibility: 'private', owner, type, mutable: true, line };
}

function method(name: string, line: number, owner = 'Holder'): CodeSymbol {
  return { name, kind: 'method', visibility: 'private', owner, line };
}

function type(name: string, line: number): CodeSymbol {
  return { name, kind: 'type', visibility: 'private', owner: '', line };
}

function call(
  method_: string,
  callee: string,
  line: number,
  owner = 'Holder',
  receiver?: string,
): FunctionCall {
  return {
    callee,
    owner,
    method: method_,
    kind: receiver ? 'type-qualified' : 'bare',
    ...(receiver ? { receiver } : {}),
    line,
  };
}

test('a held engine with no release is reported retained, with its declaration as evidence', () => {
  const report = buildRetention(
    'Engine.kt',
    [
      type('Factory', 3),
      field('cached', 'CachedEngine?', 4, 'Factory'),
      type('CachedEngine', 8),
      field('engine', 'Engine', 8, 'CachedEngine'),
      method('getEngine', 12, 'Factory'),
    ],
    [call('getEngine', 'Engine', 13, 'Factory', 'CachedEngine')],
  );

  const held = report.facts.find((fact) => fact.symbol === 'cached');
  assert.ok(held, 'the holder field is a fact');
  assert.equal(held.kind, 'engine');
  assert.match(held.evidence, /CachedEngine/);

  const kinds = report.signals.map((signal) => signal.kind);
  assert.ok(kinds.includes('field-retained-resource'));
  assert.ok(kinds.includes('no-release-path'), 'nothing releases `cached`');
});

test('a holder with an opaque name reaches the heavy field it declares in the same file', () => {
  const report = buildRetention('Engine.kt', [
    type('Factory', 3),
    field('blob', 'Container?', 4, 'Factory'),
    type('Container', 8),
    field('inner', 'Engine', 9, 'Container'),
  ]);

  const held = report.facts.find((fact) => fact.symbol === 'blob');
  assert.ok(held);
  assert.equal(held.kind, 'engine');
  assert.match(held.evidence, /holds `Engine` \(declared in this file\)/);
});

test('a validation method that reaches a load is an eager-load signal', () => {
  const report = buildRetention(
    'Engine.kt',
    [type('Factory', 3), method('getModelValidationError', 20, 'Factory'), method('getEngine', 30, 'Factory')],
    [call('getModelValidationError', 'getEngine', 21, 'Factory', 'Factory')],
  );

  const signal = report.signals.find((entry) => entry.kind === 'eager-load-on-validation');
  assert.ok(signal);
  assert.equal(signal.line, 21);
  assert.equal(signal.symbol, 'getModelValidationError');
});

test('a collection that is added to and never evicted trips; one with a cap does not', () => {
  const unbounded = buildRetention(
    'Cache.kt',
    [type('Cache', 1), field('entries', 'MutableList<String>', 2, 'Cache')],
    [call('put', 'add', 5, 'Cache', 'entries')],
  );
  assert.deepEqual(
    unbounded.signals.filter((signal) => signal.kind === 'unbounded-collection').length,
    1,
  );

  const bounded = buildRetention(
    'Cache.kt',
    [type('Cache', 1), field('entries', 'MutableList<String>', 2, 'Cache')],
    [
      call('put', 'add', 5, 'Cache', 'entries'),
      call('put', 'removeAt', 6, 'Cache', 'entries'),
    ],
  );
  assert.equal(bounded.signals.filter((signal) => signal.kind === 'unbounded-collection').length, 0);
});

test('a whole-file read copied into a second buffer on one line is reported', () => {
  const report = buildRetention(
    'Load.kt',
    [type('Loader', 1), field('bytes', 'ByteArray', 2, 'Loader')],
    [
      call('load', 'readBytes', 10, 'Loader', 'assets'),
      call('load', 'allocateDirect', 10, 'Loader'),
    ],
  );

  assert.equal(report.signals.filter((signal) => signal.kind === 'double-materialisation').length, 1);
});

test('a listener held without a removal is a signal', () => {
  const report = buildRetention(
    'View.kt',
    [type('View', 1), field('onTick', 'OnTickListener', 2, 'View')],
    [call('start', 'registerListener', 4, 'View', 'onTick')],
  );

  const signal = report.signals.find((entry) => entry.kind === 'listener-without-removal');
  assert.ok(signal);
  assert.equal(signal.symbol, 'onTick');
});

test('a release on the field records the site, so no release signal is raised', () => {
  const report = buildRetention(
    'Engine.kt',
    [type('Factory', 3), field('engine', 'Engine', 4, 'Factory'), method('shutdown', 9, 'Factory')],
    [call('shutdown', 'close', 10, 'Factory', 'engine')],
  );

  assert.deepEqual(report.facts[0]?.releaseCalls, ['close']);
  assert.equal(report.signals.filter((signal) => signal.kind === 'no-release-path').length, 0);
});

test('a field with no recorded type is not guessed at, and the limits are named', () => {
  const report = buildRetention('Bare.kt', [
    { name: 'thing', kind: 'field', visibility: 'private', owner: 'Bare', line: 2 },
  ]);

  assert.deepEqual(report.facts, []);
  assert.deepEqual(report.signals, []);
  assert.ok(report.unavailable.length > 0, 'the reading names what it cannot see');
  assert.match(report.unavailable.join(' '), /process lifetime is not recorded/);
});

test('tokens split on case and punctuation so a holder reaches what it wraps', () => {
  assert.deepEqual(retentionTokens('CachedEngine?'), ['cached', 'engine']);
  assert.deepEqual(retentionTokens('MutableList<Word>'), ['mutable', 'list', 'word']);
});

test('a field whose type is not declared here is not attributed to a local type that shares a token', () => {
  // The false positive the token reach produced on a real file: `drag: GlimDrag` was reported
  // as holding an `Engine` because the same file declares `GlimRig`, which holds one.
  const report = buildRetention('Rig.kt', [
    type('GlimRig', 3),
    field('engine', 'Engine', 24, 'GlimRig'),
    field('drag', 'GlimDrag', 26, 'GlimRig'),
  ]);

  assert.deepEqual(report.facts.map((fact) => fact.symbol), ['engine']);
});

test('the simple name drops generic arguments and qualifiers', () => {
  assert.equal(declaredTypeName('CachedEngine?'), 'CachedEngine');
  assert.equal(declaredTypeName('MutableList<Word>'), 'MutableList');
  assert.equal(declaredTypeName('com.acme.GenerativeModel'), 'GenerativeModel');
});

test('a value holder the file declares is read from its fields, not from its name', () => {
  // The shape that produced a false ranking: `LocalModel` is download metadata, not a model,
  // and two members of the file declared it. Nothing to release, nothing held.
  const report = buildRetention('Model.kt', [
    type('LocalModel', 3),
    field('url', 'String', 4, 'LocalModel'),
    field('sizeBytes', 'Long', 5, 'LocalModel'),
    field('model', 'LocalModel', 9, 'DownloadState.Running'),
    field('model', 'LocalModel', 12, 'DownloadState.Failed'),
  ]);

  assert.deepEqual(report.facts, []);
  assert.deepEqual(report.signals, []);
});

test('a declared holder whose own recorded field is heavy is still reported', () => {
  const report = buildRetention('Wrapper.kt', [
    type('LocalModel', 3),
    field('url', 'String', 4, 'LocalModel'),
    type('Wrapper', 8),
    field('inner', 'Engine', 9, 'Wrapper'),
    field('wrapped', 'Wrapper', 12, 'Holder'),
  ]);

  const held = report.facts.find((fact) => fact.symbol === 'wrapped');
  assert.ok(held, 'the holder is a fact');
  assert.equal(held.kind, 'engine');
  assert.match(held.evidence, /holds `Engine` \(declared in this file\)/);
});

test('the reading names the value-holder and unresolved-field limits', () => {
  const report = buildRetention('Model.kt', [
    type('LocalModel', 3),
    field('url', 'String', 4, 'LocalModel'),
    field('model', 'LocalModel', 9, 'DownloadState.Running'),
  ]);
  const limits = report.unavailable.join(' ');

  assert.match(limits, /value holder whose name matches a resource family/);
  assert.match(limits, /no declared type is read only when the extractor resolves its initializer/);
});
