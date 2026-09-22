import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderMarkdown, type ReportDocument } from '../../src/cli/report.ts';

function document(overrides: Partial<ReportDocument> = {}): ReportDocument {
  return {
    repository: 'fixture',
    root: '/fixture',
    base: 'HEAD~1',
    baseRevision: 'abc',
    head: 'def',
    fingerprint: 'abc:deadbeef',
    scanTime: '2026-01-01T00:00:00.000Z',
    stale: false,
    generatedAt: '2026-01-01T00:00:00.000Z',
    changedFiles: [],
    reach: { changed: [], affected: [], outsideGraph: [] },
    untestedReach: [],
    hotspotsTouched: [],
    warnings: [],
    structural: {
      available: true,
      base: 'HEAD~1',
      baseRevision: 'abc',
      headRevision: 'def',
      cached: false,
      diff: {
        edgesAdded: [],
        edgesRemoved: [],
        cyclesIntroduced: [],
        cyclesResolved: [],
        tierEdgesAdded: [],
        entryPointsAdded: [],
        newlyUnreached: [],
        counts: {
          edgesAdded: 0,
          edgesRemoved: 0,
          cyclesIntroduced: 0,
          cyclesResolved: 0,
          tierEdgesAdded: 0,
          entryPointsAdded: 0,
          newlyUnreached: 0,
        },
      },
    },
    ...overrides,
  };
}

test('renderMarkdown names an introduced cycle and its members', () => {
  const markdown = renderMarkdown(
    document({
      structural: {
        available: true,
        base: 'HEAD~1',
        baseRevision: 'abc',
        headRevision: 'def',
        cached: false,
        diff: {
          edgesAdded: [{ source: 'src/b.ts', target: 'src/a.ts', kind: 'import' }],
          edgesRemoved: [],
          cyclesIntroduced: [{ id: 'src/a.ts', members: ['src/a.ts', 'src/b.ts'] }],
          cyclesResolved: [],
          tierEdgesAdded: [],
          entryPointsAdded: [],
          newlyUnreached: [],
          counts: {
            edgesAdded: 1,
            edgesRemoved: 0,
            cyclesIntroduced: 1,
            cyclesResolved: 0,
            tierEdgesAdded: 0,
            entryPointsAdded: 0,
            newlyUnreached: 0,
          },
        },
      },
    }),
  );

  assert.match(markdown, /### Cycles introduced \(1\)/);
  assert.match(markdown, /`src\/a\.ts` → `src\/b\.ts`/);
});

test('renderMarkdown marks an unreadable base unavailable rather than empty', () => {
  const markdown = renderMarkdown(
    document({ structural: { available: false, reason: 'unknown-revision', detail: 'Unknown revision "x".' } }),
  );

  assert.match(markdown, /unavailable: unknown-revision/);
  assert.doesNotMatch(markdown, /no structural change/);
});

test('renderMarkdown says so when nothing structural changed', () => {
  const markdown = renderMarkdown(document());
  assert.match(markdown, /no structural change/);
});

test('renderMarkdown names the graph fingerprint, scan time, and staleness', () => {
  const markdown = renderMarkdown(
    document({ fingerprint: 'abc123:deadbeef', scanTime: '2026-02-02T00:00:00.000Z', stale: true }),
  );
  assert.match(markdown, /abc123:deadbeef/);
  assert.match(markdown, /scanned 2026-02-02T00:00:00\.000Z/);
  assert.match(markdown, /stale: older than the working tree/);
});
