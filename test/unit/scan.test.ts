import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { scanRepository } from '../../src/index.ts';
import { classifyExclusion } from '../../src/scan/exclusions.ts';
import { countLines } from '../../src/scan/scan.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '..', 'fixtures', 'sample-repo');

test('scanRepository emits one node per retained source file', async () => {
  const report = await scanRepository(fixture);
  const ids = report.graph.nodes.map((node) => node.id);

  assert.ok(ids.includes('src/index.ts'));
  assert.ok(ids.includes('src/util.ts'));
  assert.equal(report.graph.nodes.find((node) => node.id === 'src/feature.test.ts')?.kind, 'test');
  assert.equal(report.graph.nodes.find((node) => node.id === 'src/util.ts')?.kind, 'module');
});

test('scanRepository records each file line count on its node', async () => {
  const report = await scanRepository(fixture);
  assert.equal(report.graph.nodes.find((node) => node.id === 'src/util.ts')?.lines, 3);
});

test('countLines numbers lines the way an editor does', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('one'), 1);
  assert.equal(countLines('one\n'), 1);
  assert.equal(countLines('one\ntwo'), 2);
  assert.equal(countLines('one\r\ntwo\r\n'), 2);
  assert.equal(countLines('\n\n'), 2);
});

test('scanRepository resolves internal JS/TS edges', async () => {
  const report = await scanRepository(fixture);
  const pairs = report.graph.edges.map((edge) => `${edge.source}->${edge.target}`);

  assert.ok(pairs.includes('src/index.ts->src/util.ts'));
  assert.ok(pairs.includes('src/index.ts->src/polyfill.ts'));
  assert.ok(pairs.includes('src/feature.ts->src/util.ts'));
  assert.ok(pairs.includes('src/feature.test.ts->src/feature.ts'));
});

test('scanRepository reports unresolved relative references as diagnostics', async () => {
  const report = await scanRepository(fixture);
  const diagnostic = report.graph.diagnostics.find(
    (item) => item.file === 'src/dangling.ts' && item.kind === 'unresolved',
  );

  assert.ok(diagnostic);
  assert.equal(diagnostic.specifier, './does-not-exist.ts');
  assert.equal(diagnostic.severity, 'warning');
});

test('bare package specifiers are external: no edge and no diagnostic', async () => {
  const report = await scanRepository(fixture);
  const hasEdge = report.graph.edges.some((edge) => edge.target.includes('some-external-package'));
  const hasDiagnostic = report.graph.diagnostics.some(
    (item) => item.specifier === 'some-external-package',
  );

  assert.equal(hasEdge, false);
  assert.equal(hasDiagnostic, false);
});

test('references into generated output are out of scope, not unresolved', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-generated-'));
  try {
    fs.mkdirSync(path.join(root, 'bin'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'bin', 'strabo.js'), "import '../dist/cli.js';\n");
    fs.writeFileSync(path.join(root, 'src', 'cli.ts'), 'export const cli = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'dangling.ts'), "import './missing.ts';\n");

    const report = await scanRepository(root);
    const buildOutput = report.graph.diagnostics.find((item) => item.specifier === '../dist/cli.js');
    const missing = report.graph.diagnostics.find((item) => item.specifier === './missing.ts');

    assert.equal(buildOutput, undefined);
    assert.ok(missing, 'a genuinely missing authored file still reports unresolved');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('asset imports are out of scope and are not reported as unresolved', async () => {
  const report = await scanRepository(fixture);
  const asset = report.graph.diagnostics.find((item) => item.specifier === './styles.css');

  assert.equal(asset, undefined);
});

test('scanRepository excludes generated and vendored directories', async () => {
  const report = await scanRepository(fixture);
  const ids = report.graph.nodes.map((node) => node.id);

  assert.ok(!ids.some((id) => id.startsWith('node_modules/')));
  assert.ok(
    report.graph.excluded.some(
      (exclusion) => exclusion.reason === 'generated' && exclusion.path.startsWith('node_modules/'),
    ),
  );
});

test('a built bundle and its source map are classified generated', () => {
  assert.deepEqual(classifyExclusion('public/strabo.bundle.js'), {
    path: 'public/strabo.bundle.js',
    reason: 'generated',
    detail: '.bundle.js',
  });
  assert.deepEqual(classifyExclusion('public/strabo.bundle.js.map'), {
    path: 'public/strabo.bundle.js.map',
    reason: 'generated',
    detail: '.bundle.js.map',
  });
  assert.equal(classifyExclusion('src/index.ts'), null);
});
