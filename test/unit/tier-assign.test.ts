import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { assignDeclaredTier, readDeclaredTiers } from '../../src/analysis/tiers/declared.ts';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-tier-assign-'));
}

test('assignDeclaredTier creates strabo.groups.yml with a header and the one entry', () => {
  const root = tempRoot();
  const result = assignDeclaredTier(root, 'domain', 'src/core/**');
  assert.deepEqual(result, { ok: true, file: 'strabo.groups.yml', tier: 'domain', glob: 'src/core/**', created: true });
  const text = fs.readFileSync(path.join(root, 'strabo.groups.yml'), 'utf8');
  assert.match(text, /^# Tier declarations/);
  assert.deepEqual(readDeclaredTiers(root), [{ tier: 'domain', globs: ['src/core/**'] }]);
});

test('assignDeclaredTier puts a new entry first, joins a same-tier first entry, and keeps comments', () => {
  const root = tempRoot();
  fs.writeFileSync(
    path.join(root, 'strabo.groups.yml'),
    '# keep me\ngroups: []\ntiers:\n  - tier: frontend\n    globs:\n      - "ui/**"\n',
  );
  assignDeclaredTier(root, 'data', 'ui/store.js');
  assignDeclaredTier(root, 'data', 'src/db.ts');
  assignDeclaredTier(root, 'data', 'src/db.ts');
  const text = fs.readFileSync(path.join(root, 'strabo.groups.yml'), 'utf8');
  assert.match(text, /# keep me/);
  assert.match(text, /groups: \[\]/);
  assert.deepEqual(readDeclaredTiers(root), [
    { tier: 'data', globs: ['ui/store.js', 'src/db.ts'] },
    { tier: 'frontend', globs: ['ui/**'] },
  ]);
});

test('assignDeclaredTier refuses an unknown tier, a path outside the repository, and a broken file', () => {
  const root = tempRoot();
  assert.equal(assignDeclaredTier(root, 'unclassified', 'a.ts').ok, false);
  assert.equal(assignDeclaredTier(root, 'nope', 'a.ts').ok, false);
  assert.equal(assignDeclaredTier(root, 'data', '../outside.ts').ok, false);
  assert.equal(assignDeclaredTier(root, 'data', '/etc/passwd').ok, false);
  assert.equal(assignDeclaredTier(root, 'data', 'C:/x.ts').ok, false);
  assert.equal(assignDeclaredTier(root, 'data', 'a.ts\ntier: api').ok, false);
  assert.equal(fs.existsSync(path.join(root, 'strabo.groups.yml')), false);

  fs.writeFileSync(path.join(root, 'strabo.groups.yml'), 'tiers: [\n');
  const broken = assignDeclaredTier(root, 'data', 'a.ts');
  assert.equal(broken.ok, false);
  assert.equal(fs.readFileSync(path.join(root, 'strabo.groups.yml'), 'utf8'), 'tiers: [\n');
});
