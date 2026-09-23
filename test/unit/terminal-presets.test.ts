import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { listPresets } from '../../src/terminal/presets.ts';

const created: string[] = [];

after(() => {
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-presets-'));
  created.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const absolute = path.join(root, name);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents, 'utf8');
  }
  return root;
}

test('derives npm, make, cargo, python and go presets with stable ids', () => {
  const root = makeRepo({
    'package.json': JSON.stringify({
      scripts: {
        build: 'tsc',
        test: 'node --test',
        pretest: 'npm run typecheck',
        posttest: 'echo done',
        prepare: 'npm run build',
        prepublish: 'echo no',
        deploy: 'node deploy.mjs',
      },
    }),
    Makefile: ['build:', '\tgo build', 'test:', '\tgo test', '.PHONY: build test', 'CFLAGS = -O2'].join('\n'),
    'Cargo.toml': '[package]\nname = "demo"\n',
    'pyproject.toml': '[project]\nname = "demo"\n',
    'requirements.txt': 'pytest\n',
    'go.mod': 'module example.com/demo\n',
    'tests/test_demo.py': 'def test_x():\n    assert True\n',
  });

  const presets = listPresets(root);
  const ids = presets.map((preset) => preset.id);

  // npm: real scripts survive, lifecycle hooks around a real script do not.
  assert.ok(ids.includes('pkg:build'));
  assert.ok(ids.includes('pkg:test'));
  assert.ok(ids.includes('pkg:deploy'));
  assert.ok(!ids.includes('pkg:pretest'));
  assert.ok(!ids.includes('pkg:posttest'));
  assert.ok(!ids.includes('pkg:prepare'));
  assert.ok(!ids.includes('pkg:prepublish'));

  assert.ok(ids.includes('make:build'));
  assert.ok(ids.includes('make:test'));
  assert.ok(!ids.includes('make:.PHONY'));

  assert.ok(ids.includes('cargo:build'));
  assert.ok(ids.includes('cargo:test'));
  assert.ok(ids.includes('py:pytest'));
  assert.ok(ids.includes('go:build'));
  assert.ok(ids.includes('go:test'));

  const byId = new Map(presets.map((preset) => [preset.id, preset]));
  assert.deepEqual(byId.get('pkg:build')?.argv, ['npm', 'run', 'build']);
  assert.equal(byId.get('pkg:build')?.source, 'package.json');
  assert.equal(byId.get('make:build')?.source, 'Makefile');
  assert.deepEqual(byId.get('cargo:build')?.argv, ['cargo', 'build']);
  assert.deepEqual(byId.get('go:test')?.argv, ['go', 'test', './...']);
  assert.equal(byId.get('py:pytest')?.source, 'pyproject.toml');
});

test('a pre/post script with no counterpart is a real script and is kept', () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ scripts: { preview: 'vite preview', postinstall: 'node setup.mjs', precommit: 'lint-staged' } }),
  });
  const ids = listPresets(root).map((preset) => preset.id);
  assert.ok(ids.includes('pkg:preview'));
  assert.ok(ids.includes('pkg:precommit'));
  assert.ok(!ids.includes('pkg:postinstall'));
});

test('pytest is not offered without a test layout', () => {
  const root = makeRepo({ 'requirements.txt': 'flask\n' });
  assert.deepEqual(listPresets(root).map((preset) => preset.id), []);
});

test('missing manifests yield an empty list', () => {
  const root = makeRepo({ 'readme.md': '# hi\n' });
  assert.deepEqual(listPresets(root), []);
});

test('a corrupt package.json never throws and yields no npm presets', () => {
  const root = makeRepo({ 'package.json': '{ not json', 'go.mod': 'module x\n' });
  const presets = listPresets(root);
  assert.deepEqual(presets.map((preset) => preset.id), ['go:build', 'go:test']);
});

test('the list is capped at 40 presets', () => {
  const scripts: Record<string, string> = {};
  for (let index = 0; index < 60; index += 1) {
    scripts[`task${index}`] = 'echo hi';
  }
  const root = makeRepo({ 'package.json': JSON.stringify({ scripts }) });
  assert.equal(listPresets(root).length, 40);
});
