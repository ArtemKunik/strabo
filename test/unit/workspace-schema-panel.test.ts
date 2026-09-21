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

const { renderWorkspace } = await import('../../ui/strabo-panels.js');
const { schemaDriftRows, schemaGapRows, schemaRows, usageCaption, usageFindingRows, workspaceSummary } =
  await import('../../ui/strabo-workspace.js');

const report = {
  name: 'shop',
  repositories: [],
  flows: [],
  serviceEndpoints: [],
  serviceFlows: [],
  contracts: [],
  drift: [],
  schemas: [
    {
      repository: 'db',
      origin: 'migrations',
      files: ['V1__init.sql'],
      tables: [
        {
          name: 'users',
          columns: [{ name: 'id' }, { name: 'email' }],
          constraints: [
            { kind: 'primary-key', columns: ['id'] },
            { kind: 'foreign-key', columns: ['org_id'], references: { table: 'orgs', columns: ['id'] } },
          ],
          indexes: [],
          declared: { file: 'V1__init.sql', line: 3 },
        },
        { name: 'audit', columns: [{ name: 'x' }], constraints: [], indexes: [], declared: { file: 'V1__init.sql', line: 9 } },
      ],
      gaps: [{ file: 'V2__x.sql', line: 4, statement: 'ALTER TABLE users', reason: 'the action "ADD EXCLUDE" is not recorded' }],
    },
  ],
  usage: {
    checked: true,
    uses: [{}, {}, {}],
    findings: [
      { kind: 'unknown-column', repository: 'api', file: 'src/a.ts', line: 7, table: 'users', column: 'nick', evidence: 'string-literal SQL (SELECT)', confidence: 'weak' },
      { kind: 'unknown-table', repository: 'api', file: 'src/b.ts', line: 2, table: 'ghosts', evidence: 'ORM annotation (@Table)', confidence: 'strong' },
    ],
    drift: [
      { table: 'users', repositories: ['api', 'db'], deviations: [{ column: 'email', issue: 'nullable' }] },
      { table: 'orgs', repositories: ['api', 'db'], deviations: [] },
    ],
  },
  summary: { repositories: 1, flows: 0, serviceFlows: 0, contracts: 0, drifting: 0, tables: 2 },
};

test('workspaceSummary adds the table count only when there are tables', () => {
  assert.match(workspaceSummary(report), / · 2 tables$/);
  assert.doesNotMatch(
    workspaceSummary({ summary: { repositories: 1, flows: 0, contracts: 0, drifting: 0, tables: 0 } }),
    /tables/,
  );
});

test('schema rows name the key, the foreign keys, and where each table was declared', () => {
  assert.deepEqual(
    schemaRows(report).map((row) => [row.label, row.detail]),
    [
      ['users — db', '2 columns · key (id) · 1 foreign key · V1__init.sql:3'],
      ['audit — db', '1 column · no primary key · V1__init.sql:9'],
    ],
  );
  assert.deepEqual(schemaRows({}), []);
  assert.deepEqual(schemaGapRows(report).map((row) => [row.label, row.reason]), [
    ['ALTER TABLE users — V2__x.sql:4', 'the action "ADD EXCLUDE" is not recorded'],
  ]);
});

test('usage findings distinguish a table from a column and mark weak evidence', () => {
  assert.deepEqual(
    usageFindingRows(report).map((row) => [row.label, row.detail, row.weak]),
    [
      ['users.nick is not a column of a declared table', 'api · src/a.ts:7 · string-literal SQL (SELECT) · weak evidence', true],
      ['ghosts is not a declared table', 'api · src/b.ts:2 · ORM annotation (@Table)', false],
    ],
  );
  assert.equal(usageCaption(report), '2 of 3 recorded table uses name something no SQL file declares.');
  assert.equal(usageCaption({ usage: { checked: false, uses: [], findings: [], drift: [] } }), 'No SQL schema is declared, so there is nothing to check code against.');
  assert.equal(usageCaption({ usage: { checked: true, uses: [{}], findings: [], drift: [] } }), '1 table use recorded in code; each names a declared table and column.');
  assert.equal(usageCaption(null), 'Code usage not recorded.');
});

test('table drift rows name the deviations or state that the declarations match', () => {
  assert.deepEqual(
    schemaDriftRows(report).map((row) => [row.label, row.clean, row.deviations]),
    [
      ['users — api, db', false, ['email: nullable']],
      ['orgs — api, db', true, []],
    ],
  );
});

test('renderWorkspace draws the schema, its gaps, table drift, and the code findings', () => {
  const target = document.createElement('div');
  renderWorkspace(target, report, {});
  const text = target.textContent;
  assert.match(text, /Database schema \(2\)/);
  assert.match(text, /users — db/);
  assert.match(text, /key \(id\)/);
  assert.match(text, /Schema gaps \(1\)/);
  assert.match(text, /not applied: the action "ADD EXCLUDE" is not recorded/);
  assert.match(text, /Table drift \(2\)/);
  assert.match(text, /clean — declarations match/);
  assert.match(text, /Code against schema \(2\)/);
  assert.match(text, /users\.nick is not a column of a declared table/);
  assert.equal(target.querySelectorAll('.workspace-usage li').length, 2);
});

test('an older report with no schema still renders, and each empty section says so', () => {
  const target = document.createElement('div');
  renderWorkspace(target, { name: 'old', repositories: [], flows: [], contracts: [], drift: [], summary: { repositories: 0, flows: 0, contracts: 0, drifting: 0 } }, {});
  assert.match(target.textContent, /No SQL schema recorded\./);
  assert.match(target.textContent, /Code usage not recorded\./);
  assert.equal(target.querySelector('.workspace-schema-gaps'), null);
  assert.equal(target.querySelector('.workspace-table-drift'), null);
});
