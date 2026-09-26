import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { runCoverageCommand } from '../../src/index.ts';
import { fixtures } from './support/interop.ts';

const coverageRoot = path.join(fixtures, 'coverage-repo');

async function run(
  args: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCoverageCommand(args, {
    write: (text) => out.push(text),
    writeError: (text) => err.push(text),
  });
  return { code, out: out.join(''), err: err.join('') };
}

test('strabo coverage reports the project scope as JSON', async () => {
  const { code, out } = await run([coverageRoot, '--format=json']);
  assert.equal(code, 0);
  const body = JSON.parse(out) as {
    scope: string;
    repository: string;
    totals: { value: number | null; filesMeasured: number };
    provenance: { available: boolean };
  };
  assert.equal(body.scope, 'project');
  assert.ok(body.repository.length > 0);
  assert.equal(body.provenance.available, true);
  assert.equal(body.totals.value, 50);
  assert.equal(body.totals.filesMeasured, 2);
});

test('strabo coverage --file names the tests that reach the file', async () => {
  const { code, out } = await run([coverageRoot, '--file=src/half.ts', '--format=json']);
  assert.equal(code, 0);
  const body = JSON.parse(out) as {
    scope: string;
    file: { value: number | null; tests: string[] };
  };
  assert.equal(body.scope, 'file');
  assert.equal(body.file.value, 75);
  assert.deepEqual(body.file.tests, ['src/half.test.ts']);
});

test('strabo coverage --folder rolls up the subtree', async () => {
  const { code, out } = await run([coverageRoot, '--folder=src', '--format=json']);
  assert.equal(code, 0);
  const body = JSON.parse(out) as { scope: string; subject: string; totals: { value: number | null } };
  assert.equal(body.scope, 'folder');
  assert.equal(body.subject, 'src');
  assert.equal(body.totals.value, 50);
});

test('strabo coverage prints a human report by default', async () => {
  const { code, out } = await run([coverageRoot, '--folder=src']);
  assert.equal(code, 0);
  assert.match(out, /strabo coverage · .* · folder src/);
  assert.match(out, /basis measured/);
  assert.match(out, /files:/);
});

test('strabo coverage refuses both scopes and reports an unknown file', async () => {
  const both = await run([coverageRoot, '--file=src/half.ts', '--folder=src']);
  assert.equal(both.code, 2);
  assert.match(both.err, /not both/);

  const unknown = await run([coverageRoot, '--file=src/missing.ts']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /not a scanned file/);
});
