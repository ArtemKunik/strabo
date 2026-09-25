import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CORPUS_LANGUAGES,
  allocateFiles,
  createRng,
  manifestFor,
  planCorpus,
  renderCorpus,
  summarise,
} from '../../scripts/bench-corpus.mjs';

const SMALL = { files: 400, seed: 1234 };

test('the corpus generator is deterministic for a seed', () => {
  const first = renderCorpus(planCorpus(SMALL));
  const second = renderCorpus(planCorpus(SMALL));

  assert.deepEqual([...first.keys()], [...second.keys()]);
  for (const [file, content] of first) {
    assert.equal(second.get(file), content, `content drifted for ${file}`);
  }
});

test('the corpus generator changes with the seed', () => {
  const first = renderCorpus(planCorpus(SMALL));
  const second = renderCorpus(planCorpus({ files: SMALL.files, seed: 1235 }));

  assert.deepEqual([...first.keys()], [...second.keys()]);
  const changed = [...first].some(([file, content]) => second.get(file) !== content);
  assert.ok(changed, 'a different seed must change the generated content');
});

test('file allocation sums to the requested total', () => {
  const allocation = allocateFiles(20000);
  const total = [...allocation.values()].reduce((sum, value) => sum + value, 0);
  assert.equal(total, 20000);
  for (const entry of CORPUS_LANGUAGES) {
    assert.ok((allocation.get(entry.language) ?? 0) > 0, `${entry.language} must be generated`);
  }
});

test('the generated manifest names the corpus, its languages, and how to regenerate it', () => {
  const plan = planCorpus(SMALL);
  const rendered = renderCorpus(plan);
  const summary = summarise(rendered);
  const manifest = manifestFor(plan, rendered, 'node scripts/bench-corpus.mjs --out X --files 400 --seed 1234');

  assert.equal(manifest.kind, 'synthetic');
  assert.equal(manifest.seed, 1234);
  assert.equal(manifest.requestedFiles, 400);
  assert.ok(manifest.generatedFiles >= 400);
  assert.equal(manifest.generatedFiles, summary.total);
  assert.equal(manifest.extensions['.ts'], summary.extensions['.ts']);
  assert.match(manifest.regenerate, /bench-corpus\.mjs/);
  for (const language of ['typescript', 'python', 'java', 'csharp', 'rust', 'cpp', 'kotlin', 'sql']) {
    assert.ok((manifest.languages[language] ?? 0) > 0, `${language} must appear in the manifest`);
  }
});

test('the random stream is stable and bounded', () => {
  const a = createRng(99);
  const b = createRng(99);
  for (let index = 0; index < 10; index += 1) {
    assert.equal(a(), b());
  }
  const value = createRng(1)();
  assert.ok(value >= 0 && value < 1);
});
