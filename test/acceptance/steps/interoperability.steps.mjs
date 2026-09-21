import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { Then, When } from '@cucumber/cucumber';

import { ACCEPTANCE_FIXTURES, ACCEPTANCE_ROOT } from '../support/server.mjs';

const STATE_DIR = path.resolve('test/acceptance/reports/state');
const CACHE_DIR = path.resolve('test/acceptance/reports/cache');
const CYCLE_ROOT = path.join(ACCEPTANCE_FIXTURES, 'sample-repo');

When('I request the graph export as {string}', async function (format) {
  const response = await fetch(`${this.baseUrl}/api/strabo/export?format=${format}`);
  assert.equal(response.ok, true, `export ${format} should respond`);
  this.exportBody = await response.text();
});

Then('the export envelope names the format {string}', function (format) {
  const parsed = JSON.parse(this.exportBody);
  assert.equal(parsed.format, format);
  assert.equal(parsed.version, 'strabo-export-1');
});

Then('the export names the revision it was indexed at', function () {
  const parsed = JSON.parse(this.exportBody);
  assert.ok('revision' in parsed, 'the envelope should carry a revision field');
  assert.ok('fingerprint' in parsed, 'the envelope should carry a fingerprint field');
});

Then('the export begins with {string}', function (prefix) {
  assert.ok(
    this.exportBody.startsWith(prefix),
    `expected the export to begin with "${prefix}"`,
  );
});

When('I request the freshness status', async function () {
  const response = await fetch(`${this.baseUrl}/api/strabo/status`);
  assert.equal(response.ok, true, 'status should respond');
  this.statusBody = await response.json();
});

Then('the status names the indexed revision and whether it is stale', function () {
  assert.ok(this.statusBody.indexed, 'the status should carry an indexed side');
  assert.ok('revision' in this.statusBody.indexed);
  assert.equal(typeof this.statusBody.stale, 'boolean');
});

When('I run the check command with {string}', async function (flags) {
  if (!this.checkBaseline) {
    this.checkBaseline = path.join(
      STATE_DIR,
      `interop-check-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
  }
  const args = [
    'bin/strabo.js',
    'check',
    CYCLE_ROOT,
    `--baseline=${this.checkBaseline}`,
    ...flags.split(' ').filter(Boolean),
  ];
  this.checkResult = await runCli(args);
});

Then('the check exits with code {int}', function (code) {
  assert.equal(
    this.checkResult.code,
    code,
    `check exited ${this.checkResult.code}: ${this.checkResult.stdout}${this.checkResult.stderr}`,
  );
});

Then('the check reports a cycle finding', function () {
  assert.match(this.checkResult.stdout, /\[cycles\]/);
});

Then('the check reports no new findings', function () {
  assert.match(this.checkResult.stdout, /PASS/);
});

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        STRABO_ROOT: CYCLE_ROOT,
        STRABO_SCAN_CEILING: ACCEPTANCE_FIXTURES,
        STRABO_STATE_DIR: STATE_DIR,
        STRABO_CACHE_DIR: CACHE_DIR,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
