import assert from 'node:assert/strict';
import test from 'node:test';

import { applyLabelBudget, chooseLabels, setLabelsForceAll, setLabelsVisible } from '../../ui/strabo-labels.js';

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

/** A fake graph carrying only what the label budget reads from Cytoscape. */
function fakeGraph(kinds: string[] = ['file', 'file']) {
  const scratch = new Map<string, unknown>();
  const nodes = kinds.map((kind, index) => {
    const classes = new Set<string>();
    const data: Record<string, unknown> = { hub: false, kind, diameter: 30, label: `node${index}.ts` };
    return {
      id: () => `node${index}`,
      data: (key: string) => data[key],
      selected: () => false,
      visible: () => true,
      renderedPosition: () => ({ x: index * 400, y: 0 }),
      toggleClass: (name: string, on: boolean) => {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      hasClass: (name: string) => classes.has(name),
    };
  });
  const collection = (list: typeof nodes) => ({
    filter: (fn: (candidate: (typeof nodes)[number]) => boolean) => collection(list.filter(fn)),
    toArray: () => list,
    forEach: (fn: (candidate: (typeof nodes)[number]) => void) => list.forEach(fn),
  });
  return {
    nodes,
    cy: {
      zoom: () => 0.4,
      scratch: (key: string, value?: unknown) => {
        if (value === undefined) return scratch.get(key);
        scratch.set(key, value);
        return value;
      },
      nodes: () => collection(nodes),
      batch: (fn: () => void) => fn(),
      style: () => ({ update: () => {} }),
    },
  };
}

test('forcing labels shows ordinary nodes the detail zoom would hide', () => {
  const { cy, nodes } = fakeGraph();
  setLabelsVisible(cy, true);
  setLabelsForceAll(cy, false);
  applyLabelBudget(cy, true);
  assert.ok(nodes.every((candidate) => candidate.hasClass('label-hidden')));

  setLabelsForceAll(cy, true);
  assert.ok(nodes.every((candidate) => !candidate.hasClass('label-hidden')));

  setLabelsForceAll(cy, false);
});

test('forcing labels still leaves unit and shelf nodes unlabeled', () => {
  const { cy, nodes } = fakeGraph(['unit', 'file']);
  setLabelsVisible(cy, true);
  setLabelsForceAll(cy, true);
  assert.ok(nodes[0].hasClass('label-hidden'));
  assert.ok(!nodes[1].hasClass('label-hidden'));

  setLabelsForceAll(cy, false);
});
