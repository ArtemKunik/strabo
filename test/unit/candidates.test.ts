import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { rankCandidates, type FileReading } from '../../src/analysis/candidates.ts';
import { BUILT_IN_ISSUES, findIssue, readDeclaredIssues, resolveIssues } from '../../src/analysis/issues.ts';

function reading(file: string, lines: number, signals: FileReading['signals'], recorded = 0): FileReading {
  return { file, lines, signals, recorded };
}

const crashMemory = findIssue(resolveIssues(path.join(os.tmpdir(), 'strabo-no-such-root')), 'crash-memory');

test('crash-memory ranks the retained resource above a large data table, and says why it is not the table', () => {
  assert.ok(crashMemory);
  const ranking = rankCandidates(crashMemory, [
    reading('app/GlimQuips.kt', 688, [], 0),
    reading('app/LiteRtEngineFactory.kt', 109, [
      { kind: 'no-release-path', line: 22, detail: 'no recorded release call for `cached` in this file' },
      { kind: 'field-retained-resource', line: 22, detail: 'native-model `CachedEngine?` held in `cached`' },
    ], 1),
  ]);

  assert.equal(ranking.candidates.length, 1);
  assert.equal(ranking.candidates[0]?.file, 'app/LiteRtEngineFactory.kt');
  assert.equal(ranking.candidates[0]?.rank, 1);
  assert.ok(ranking.candidates[0]?.reasons.some((reason) => reason.includes('no-release-path')));

  assert.equal(ranking.notRanked.length, 1);
  assert.equal(ranking.notRanked[0]?.file, 'app/GlimQuips.kt');
  assert.match(ranking.notRanked[0]?.reason ?? '', /no recorded retention signal/);
});

test('a signal the class weights higher outranks one it weights lower', () => {
  assert.ok(crashMemory);
  const ranking = rankCandidates(crashMemory, [
    reading('a.kt', 10, [{ kind: 'eager-load-on-validation', line: 3, detail: 'validate calls load' }]),
    reading('b.kt', 10, [{ kind: 'no-release-path', line: 4, detail: 'nothing releases it' }]),
  ]);

  assert.deepEqual(ranking.candidates.map((candidate) => candidate.file), ['b.kt', 'a.kt']);
});

test('a class whose reading recorded nothing returns unavailable with the reason, not a ranking', () => {
  assert.ok(crashMemory);
  const ranking = rankCandidates(crashMemory, []);

  assert.deepEqual(ranking.candidates, []);
  assert.match(ranking.unavailable.join(' '), /no file was read for this class/);
});

test('the declared issue classes are the built-ins when no file is present', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-issues-'));
  try {
    assert.deepEqual(readDeclaredIssues(root), []);
    assert.deepEqual(
      resolveIssues(root).map((issue) => issue.name),
      [...BUILT_IN_ISSUES].map((issue) => issue.name).sort(),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a declared class replaces its built-in and a new one is appended; malformed entries are skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-issues-'));
  try {
    fs.writeFileSync(
      path.join(root, 'strabo.groups.yml'),
      [
        'issues:',
        '  - name: crash-memory',
        '    symptom: "the app dies on startup"',
        '    ranksBy: retention',
        '    signals: [no-release-path]',
        '  - name: ui-jank',
        '    ranksBy: compute',
        '    signals: [nested-loops, long-function]',
        '  - name: broken-entry',
        '    ranksBy: not-a-reading',
        '',
      ].join('\n'),
      'utf8',
    );

    const issues = resolveIssues(root);
    assert.equal(findIssue(issues, 'crash-memory')?.symptom, 'the app dies on startup');
    assert.deepEqual(findIssue(issues, 'crash-memory')?.signals, ['no-release-path']);
    assert.equal(findIssue(issues, 'ui-jank')?.ranksBy, 'compute');
    assert.equal(findIssue(issues, 'broken-entry'), undefined, 'an unknown reading is skipped');

    const jank = findIssue(issues, 'ui-jank');
    assert.ok(jank);
    const ranking = rankCandidates(jank, [
      reading('x.kt', 20, [
        { kind: 'long-function', line: 1, detail: '80 lines' },
        { kind: 'nested-loops', line: 1, detail: 'loop nesting 2' },
      ]),
    ]);
    assert.equal(ranking.candidates[0]?.score, 3, 'nested-loops weighs 2, long-function 1');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
