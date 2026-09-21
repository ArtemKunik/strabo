export default {
  import: [
    'test/acceptance/support/**/*.mjs',
    'test/acceptance/steps/system.steps.mjs',
    'test/acceptance/steps/repository-map.steps.mjs',
  ],
  paths: ['test/acceptance/features/system-view.feature'],
  tags: 'not @wip',
  format: ['progress', 'summary'],
  parallel: 1,
};
