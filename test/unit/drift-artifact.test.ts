import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DriftReport } from '../../src/analysis/drift.ts';
import {
  buildDriftChart,
  driftSeriesColour,
  recordedDriftSeries,
  renderDriftArtifact,
} from '../../src/export/drift-artifact.ts';

const DATE = '2026-06-01T00:00:00.000Z';

function report(): DriftReport {
  return {
    available: true,
    repository: 'demo',
    base: null,
    points: [
      { revision: 'ccc3333', short: 'ccc3333', date: '2026-03-03T00:00:00Z', subject: 'newest', measures: [] },
      { revision: 'bbb2222', short: 'bbb2222', date: '2026-02-02T00:00:00Z', subject: 'middle', measures: [] },
      { revision: 'aaa1111', short: 'aaa1111', date: '2026-01-01T00:00:00Z', subject: 'oldest', measures: [] },
    ],
    series: [
      {
        key: 'cycles',
        label: 'Cycles',
        points: [
          { revision: 'ccc3333', value: 1 },
          { revision: 'bbb2222', value: null },
          { revision: 'aaa1111', value: 0 },
        ],
      },
      {
        key: 'modules',
        label: 'Modules',
        points: [
          { revision: 'ccc3333', value: 3 },
          { revision: 'bbb2222', value: 3 },
          { revision: 'aaa1111', value: 2 },
        ],
      },
      {
        key: 'hidden-coupling-share',
        label: 'Hidden coupling share',
        points: [
          { revision: 'ccc3333', value: null },
          { revision: 'bbb2222', value: null },
          { revision: 'aaa1111', value: null },
        ],
      },
    ],
  };
}

test('buildDriftChart plots recorded measures oldest-first and breaks the line at a gap', () => {
  const chart = buildDriftChart(report());

  assert.equal(chart.count, 3);
  assert.deepEqual(
    chart.series.map((series) => series.key),
    ['cycles', 'modules'],
  );

  const cycles = chart.series[0];
  assert.equal(cycles?.segments.length, 2);
  assert.equal(cycles?.segments.flat().length, 2);
  // Oldest value 0 sits on the baseline; newest value 1 sits at the top.
  assert.equal(cycles?.segments[0]?.[0]?.y, chart.height - chart.padding);
  assert.equal(cycles?.segments[1]?.[0]?.y, chart.padding);

  const modules = chart.series[1];
  assert.equal(modules?.segments.length, 1);
  assert.equal(modules?.segments[0]?.length, 3);
  // Two files at the leftmost and middle points, three at the right.
  assert.equal(modules?.first, 2);
  assert.equal(modules?.last, 3);

  assert.deepEqual(
    recordedDriftSeries(report()).map((series) => series.key),
    ['cycles', 'modules'],
  );
  assert.equal(driftSeriesColour(0), '#3987e5');
  assert.equal(driftSeriesColour(2), '#199e70');
  assert.equal(driftSeriesColour(3), '#8da0b5');
});

test('renderDriftArtifact is byte-identical for the same input and stamps revision and date', () => {
  const first = renderDriftArtifact(report(), { revision: 'ccc3333', generatedAt: DATE });
  const second = renderDriftArtifact(report(), { revision: 'ccc3333', generatedAt: DATE });

  assert.equal(first, second);
  assert.match(first, /data-revision="ccc3333"/);
  assert.match(first, /data-generated-at="2026-06-01T00:00:00\.000Z"/);
  assert.match(first, /revision <code>ccc3333<\/code>/);
  assert.match(first, /data-role="drift-chart"/);
  // The always-null measure is named as not recorded, never drawn as zero.
  assert.match(first, /data-role="drift-missing"/);
  assert.match(first, /Hidden coupling share/);
});

test('the build date is the only field that differs between two runs on one revision', () => {
  const earlier = renderDriftArtifact(report(), { revision: 'ccc3333', generatedAt: DATE });
  const laterDate = '2026-07-09T12:34:56.000Z';
  const later = renderDriftArtifact(report(), { revision: 'ccc3333', generatedAt: laterDate });

  assert.notEqual(earlier, later);
  assert.equal(
    earlier.split(DATE).join('<date>'),
    later.split(laterDate).join('<date>'),
  );
});

test('an unavailable report renders the reason and the stamp rather than an empty chart', () => {
  const html = renderDriftArtifact(
    {
      available: false,
      reason: 'not-a-git-repository',
      repository: 'demo',
      base: null,
      points: [],
      series: [],
    },
    { revision: null, generatedAt: DATE },
  );

  assert.match(html, /data-role="drift-unavailable"/);
  assert.match(html, /not-a-git-repository/);
  assert.match(html, /data-revision="unavailable"/);
  assert.match(html, /data-generated-at="2026-06-01T00:00:00\.000Z"/);
  assert.doesNotMatch(html, /data-role="drift-chart"/);

  const noReport = renderDriftArtifact(null, {
    revision: null,
    generatedAt: DATE,
    reason: 'not-a-repository-root',
  });
  assert.match(noReport, /not-a-repository-root/);
});

test('the artifact escapes the repository name and revision', () => {
  const html = renderDriftArtifact(report(), {
    repository: '<img src=x onerror=alert(1)>',
    revision: 'ccc3333',
    generatedAt: DATE,
  });

  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;img src=x/);
});
