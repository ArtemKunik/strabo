import assert from 'node:assert/strict';
import { test } from 'node:test';

const { overlayFor, smellsOverlay } = await import('../../ui/strabo-overlays.js');

const report = {
  repository: 'demo',
  files: [
    { file: 'a.ts', smells: [{ rule: 'cyclic', detail: 'sits in a cycle', inputs: {} }] },
    {
      file: 'b.ts',
      smells: [
        { rule: 'dead', detail: 'nothing imports it', inputs: { directImporters: 0 } },
        { rule: 'tier-leak', detail: 'depends on a higher tier', inputs: { tier: 'data' } },
      ],
    },
  ],
  summary: { cyclic: 1, dead: 1, 'tier-leak': 1, 'god-module': 0 },
};

test('smellsOverlay maps files to a class and summarises the rules', () => {
  const result = smellsOverlay(report);

  assert.equal(result.classes.get('a.ts'), 'ov-smell');
  assert.equal(result.classes.get('b.ts'), 'ov-smell');
  assert.match(result.summary, /2 file\(s\) with a smell/);
  assert.match(result.summary, /1 cyclic/);
  assert.doesNotMatch(result.summary, /god-module/);
  assert.match(result.items[1], /b\.ts · dead, tier-leak/);
});

test('overlayFor routes smells and ignores an unknown kind', () => {
  assert.equal(overlayFor('smells', report).classes.size, 2);
  assert.equal(overlayFor('unknown', report).classes.size, 0);
  assert.deepEqual(smellsOverlay(null).classes.size, 0);
});
