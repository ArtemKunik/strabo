# Browser acceptance

Browser acceptance is specified in `.feature` files using user-observable
Given/When/Then steps. Step definitions drive a real Chromium browser via Playwright and
assert only published API and UI behaviour.

## Running

```sh
npm run acceptance:install   # once: download the Chromium build
npm run acceptance           # build, start the server on the fixture, run the features
```

The runner writes an HTML report with screenshots to
`test/acceptance/reports/acceptance.html`. Every scenario attaches a screenshot, and the
suite fails when screenshot evidence is missing. The server runs against
`test/fixtures/block-repo` on port 3131 with an isolated cache directory.

## How steps drive the UI

Cucumber + Playwright, one browser per scenario. Nodes are drawn on a Cytoscape canvas
rather than in the DOM, so step definitions ask the page for a node's rendered centre and
then send a real mouse click or double-click. The page exposes a small hook
(`window.straboTest`) only when it is opened with `window.STRABO_TEST`; it exposes the
Cytoscape instance and current model for measurement, not for skipping user interaction.

## Adding scenarios

Add to `features/`, then implement the steps in `steps/`. Keep steps phrased in terms of
what a user observes (status line, breadcrumb, inspector, panel) rather than internal
functions.
