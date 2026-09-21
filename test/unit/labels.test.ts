import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseLabels } from '../../ui/strabo-labels.js';

/** The slice of a Cytoscape node `chooseLabels` reads. */
function node(id: string, x: number, y: number, options: { hub?: boolean; selected?: boolean; diameter?: number; label?: string } = {}) {
  const data: Record<string, unknown> = {
    hub: options.hub ?? true,
    diameter: options.diameter ?? 30,
    label: options.label ?? 'types.rs',
  };
  return {
    id: () => id,
    data: (key: string) => data[key],
    selected: () => options.selected ?? false,
    renderedPosition: () => ({ x, y }),
  };
}

test('chooseLabels keeps the larger of two labels that would overlap', () => {
  const shown = chooseLabels([node('small', 100, 100, { diameter: 22 }), node('big', 110, 100, { diameter: 60 })], 0.4);
  assert.deepEqual([...shown], ['big']);
});

test('chooseLabels keeps labels that are far enough apart', () => {
  const shown = chooseLabels([node('a', 0, 0), node('b', 300, 0)], 0.4);
  assert.deepEqual([...shown].sort(), ['a', 'b']);
});

test('chooseLabels never drops a selected node, even over a bigger neighbour', () => {
  const shown = chooseLabels(
    [node('hub', 100, 100, { diameter: 62 }), node('picked', 105, 100, { diameter: 22, selected: true })],
    0.4,
  );
  assert.ok(shown.has('picked'));
});
