export default {
  import: ['test/acceptance/support/**/*.mjs', 'test/acceptance/steps/**/*.mjs'],
  paths: ['test/acceptance/features/**/*.feature'],
  // @wip specs are captured but not yet executable; keep the run green until implemented.
  tags: 'not @wip',
  format: ['progress', 'summary', 'html:test/acceptance/reports/acceptance.html'],
  formatOptions: { snippetInterface: 'async-await' },
  parallel: 1,
};
