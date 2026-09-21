import assert from 'node:assert/strict';
import { test } from 'node:test';

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;

globalThis.document = window.document;
globalThis.window = window;
globalThis.HTMLElement = window.HTMLElement;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

const { renderWorkspace, renderWorkspaceTools } = await import('../../ui/strabo-panels.js');
const { compatRows, databaseRows, liveDriftRows, preflightRows, probeConsent, resultCaption } = await import(
  '../../ui/strabo-workspace.js'
);

const compat = {
  reports: [
    {
      repository: 'db',
      base: 'HEAD',
      head: 'working tree',
      summary: { breaking: 1, conditional: 0, safe: 1 },
      changes: [
        {
          subject: 'schema',
          id: 'users',
          target: 'column',
          name: 'legacy',
          change: 'removed',
          compatibility: 'breaking',
          before: 'text',
          reason: 'Queries that read or write this column fail, and its data is gone.',
          file: 'V2__drop.sql',
          line: 1,
          references: [{ repository: 'api', file: 'src/a.ts', line: 3 }],
        },
        { subject: 'schema', id: 'tenants', target: 'table', change: 'added', compatibility: 'safe', reason: 'A new table.' },
      ],
    },
    {
      repository: 'gone',
      base: 'nope',
      head: 'working tree',
      summary: { breaking: 0, conditional: 0, safe: 0 },
      changes: [],
      unavailable: 'The revision "nope" does not exist in gone.',
    },
  ],
};

const preflight = {
  reports: [
    {
      repository: 'db',
      base: 'HEAD',
      head: 'working tree',
      dialect: 'postgres',
      checks: [
        {
          id: 'a',
          description: 'Make users.email NOT NULL.',
          severity: 'blocks',
          failsWhen: 'rows hold NULL in the column.',
          sql: 'SELECT COUNT(*) AS violations FROM users WHERE email IS NULL',
          result: { status: 'violations', violations: 7, database: 'prod', ranAt: 'x' },
        },
        {
          id: 'b',
          description: 'Drop users.legacy.',
          severity: 'data-loss',
          failsWhen: 'rows hold a value.',
          sql: 'SELECT COUNT(legacy) AS violations FROM users',
          references: [{ file: 'src/a.ts', line: 3 }],
        },
        {
          id: 'c',
          description: 'Add unique.',
          severity: 'blocks',
          failsWhen: 'duplicates.',
          sql: 'SELECT 1',
          result: { status: 'error', error: 'timeout', database: 'prod', ranAt: 'x' },
        },
      ],
      skipped: [{ table: 't', column: 'a', operation: 'convert type', reason: 'needs a trial cast' }],
    },
  ],
};

test('compat rows carry the verdict word, the evidence, and say when a revision was not compared', () => {
  const groups = compatRows(compat);
  assert.equal(groups[0].caption, '1 breaking · 0 conditional · 1 safe (HEAD → working tree)');
  assert.deepEqual(groups[0].rows[0].detail, ['text → —', 'V2__drop.sql:1', 'still used at src/a.ts:3']);
  assert.equal(groups[0].rows[0].badge, 'breaking');
  assert.equal(groups[1].caption, 'Not compared: The revision "nope" does not exist in gone.');
  assert.equal(
    compatRows({ reports: [{ repository: 'x', base: 'A', head: 'B', summary: {}, changes: [] }] })[0].caption,
    'No contract or schema differences recorded between A and B.',
  );
});

test('a preflight result is never drawn as a pass unless it ran and found nothing', () => {
  const [group] = preflightRows(preflight);
  assert.deepEqual(
    group.checks.map((check) => check.result),
    ['7 rows would make it fail', 'not run', 'could not check: timeout'],
  );
  assert.equal(group.caption, '3 data checks · postgres');
  assert.deepEqual(
    group.skipped.map((entry) => [entry.label, entry.reason]),
    [['t.a — convert type', 'needs a trial cast']],
  );
  assert.equal(resultCaption({ severity: 'blocks', result: { status: 'ok', violations: 0 } }), 'ok — no row would make it fail');
  assert.equal(resultCaption({ severity: 'data-loss', result: { status: 'violations', violations: 1 } }), '1 row would lose data');
  assert.equal(
    preflightRows({ reports: [{ repository: 'x', base: 'A', head: 'B', dialect: 'postgres', checks: [], skipped: [] }] })[0].caption,
    'No migration operation between A and B needs a data check.',
  );
});

test('databases, live drift and the consent text are stated plainly', () => {
  assert.deepEqual(databaseRows({ databases: [{ name: 'prod', dialect: 'postgres', urlEnv: 'DB', configured: false }] }), [
    { name: 'prod', label: 'prod (postgres)', configured: false, note: 'set DB to enable' },
  ]);
  assert.deepEqual(
    liveDriftRows({
      drift: [
        { repository: 'db', table: 'users', column: 'age', kind: 'column-not-in-live', declared: 'integer' },
        { repository: 'db', table: 'audit', kind: 'table-not-in-repository' },
        { repository: 'db', table: 'users', column: 'email', kind: 'type', live: 'text', declared: 'varchar(255)' },
      ],
    }).map((row) => [row.label, row.text]),
    [
      ['users.age', 'declared as integer, missing in the database'],
      ['audit', 'in the database, declared by no repository'],
      ['users.email', 'database text, migrations varchar(255) (type)'],
    ],
  );
  assert.match(probeConsent('prod', 3), /3 read-only count queries/);
  assert.match(probeConsent('prod', 1), /1 read-only count query,/);
  assert.match(probeConsent('prod', 1), /No table row is read/);
});

test('the tools render the verdicts, gate the run behind a confirmation, and report a working state', () => {
  const calls = [];
  const handlers = {
    onBase: (value) => calls.push(['base', value]),
    onCompat: () => calls.push(['compat']),
    onPreflight: () => calls.push(['preflight']),
    onConfirmRun: (name) => calls.push(['confirm', name]),
    onRun: (name) => calls.push(['run', name]),
    onCancelRun: () => calls.push(['cancel']),
    onLive: (name) => calls.push(['live', name]),
  };
  const tools = {
    base: 'main',
    busy: '',
    error: '',
    compat,
    preflight,
    databases: {
      databases: [
        { name: 'prod', dialect: 'postgres', urlEnv: 'STRABO_DB_PROD', configured: true },
        { name: 'stage', dialect: 'postgres', urlEnv: 'STRABO_DB_STAGE', configured: false },
      ],
      runs: [{ at: 't', database: 'prod', kind: 'preflight', checks: 3, violations: 1, errors: 1 }],
    },
    live: { database: 'prod', capturedAt: 't', tables: 2, drift: [] },
    confirming: null,
    scriptHref: '/api/strabo/workspace/preflight?base=main&format=sql',
  };
  const target = document.createElement('div');
  renderWorkspaceTools(target, tools, handlers);

  assert.equal(target.querySelector('#workspace-base').value, 'main');
  assert.equal(target.querySelectorAll('.compat-breaking').length, 1);
  assert.equal(target.querySelectorAll('.workspace-preflight details').length, 3);
  assert.match(target.textContent, /Not compared: The revision "nope"/);
  assert.match(target.textContent, /Live database \(2\)/);
  assert.match(target.textContent, /set STRABO_DB_STAGE to enable/);
  assert.match(target.textContent, /The live database and the migrations agree\./);
  assert.match(target.textContent, /prod · preflight · 3 checks, 1 with violations, 1 errors/);
  assert.equal(target.querySelector('.workspace-script-link').getAttribute('href'), tools.scriptHref);

  const runButtons = [...target.querySelectorAll('[data-action="run-preflight"]')];
  assert.deepEqual(
    runButtons.map((button) => button.disabled),
    [false, true],
    'a database with no connection string cannot be run',
  );
  runButtons[0].click();
  assert.deepEqual(calls.pop(), ['confirm', 'prod']);
  assert.equal(target.querySelector('[data-action="confirm-run"]'), null, 'nothing runs before the confirmation is shown');

  const input = target.querySelector('#workspace-base');
  input.value = 'v1.0';
  input.dispatchEvent(new window.Event('input'));
  assert.deepEqual(calls.pop(), ['base', 'v1.0']);

  const confirming = document.createElement('div');
  renderWorkspaceTools(confirming, { ...tools, confirming: 'prod' }, handlers);
  assert.match(confirming.textContent, /3 read-only count queries/);
  confirming.querySelector('[data-action="confirm-run"]').click();
  assert.deepEqual(calls.pop(), ['run', 'prod']);
  confirming.querySelector('[data-action="cancel-run"]').click();
  assert.deepEqual(calls.pop(), ['cancel']);

  const busy = document.createElement('div');
  renderWorkspaceTools(busy, { ...tools, busy: 'running read-only checks', error: 'boom' }, handlers);
  assert.match(busy.textContent, /Working: running read-only checks…/);
  assert.match(busy.querySelector('.workspace-error').textContent, /boom/);
  assert.ok([...busy.querySelectorAll('button')].every((button) => button.disabled));
});

test('renderWorkspace adds the tools only when the host provides them', () => {
  const report = { name: 'x', repositories: [], flows: [], contracts: [], drift: [], summary: { repositories: 0, flows: 0, contracts: 0, drifting: 0 } };
  const without = document.createElement('div');
  renderWorkspace(without, report, {});
  assert.equal(without.querySelector('.workspace-tools'), null);
  const withTools = document.createElement('div');
  renderWorkspace(withTools, report, { tools: { base: 'HEAD', databases: { databases: [], runs: [] } } });
  assert.match(withTools.textContent, /Compatibility and migrations/);
  assert.match(withTools.textContent, /No database is declared/);
});
