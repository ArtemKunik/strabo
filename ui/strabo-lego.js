/**
 * Lego-style brick assembly for the current map.
 *
 * A **brick** is one recorded node — a file, a directory, or a build unit — and a **snap** is
 * one recorded dependency edge. Bricks stack by dependency depth: a brick rests on the bricks
 * it imports, so the foundation (layer 0) is the most depended-upon and the top is what
 * nothing rests on. Studs on a brick's top face are the recorded dependents that snap onto
 * it. Nothing here is invented: a brick with no recorded edge in either direction is named
 * `detached`, and a pair that import each other is a `tangled` cycle the stack cannot hold.
 *
 * Pure functions only: no DOM, no fetch. `strabo-panel-blocks.js` draws the result, and
 * `test/unit/lego.test.ts` covers the arithmetic from Node.
 */

/** A brick never grows wider than this many stud-units, so a large unit stays readable. */
export const MAX_FOOTPRINT = 8;
/** A brick never carries more drawn studs than this, so a hub does not become a comb. */
export const MAX_STUDS = 8;

/** The last path segment, the label a node falls back to when it carries none. */
function labelOf(node) {
  if (node.label) {
    return node.label;
  }
  const id = String(node.id ?? '');
  const slash = Math.max(id.lastIndexOf('/'), id.lastIndexOf('\\'));
  return slash === -1 ? id : id.slice(slash + 1) || id;
}

/** The mass a brick's footprint is derived from: files, then size, then lines, then one. */
function massOf(node) {
  for (const key of ['files', 'size', 'loc', 'lines']) {
    const value = Number(node[key]);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return 1;
}

/**
 * Strongly connected components (Tarjan). A component of two or more ids is a dependency
 * cycle; every id in it is `tangled`. Recursive, which is fine for the map sizes the UI draws.
 */
function stronglyConnected(ids, adjacency) {
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;

  const walk = (id) => {
    index.set(id, counter);
    low.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!index.has(next)) {
        walk(next);
        low.set(id, Math.min(low.get(id), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(id, Math.min(low.get(id), index.get(next)));
      }
    }
    if (low.get(id) === index.get(id)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== id);
      components.push(component);
    }
  };

  for (const id of ids) {
    if (!index.has(id)) {
      walk(id);
    }
  }
  return components;
}

/**
 * Build the assembly from the current view's nodes and edges.
 *
 * `nodes` are `ViewNode`s (only `id`, `label`, and a mass field are read); `edges` are
 * `ViewEdge`s, where `source` imports `target`, so `source` rests on `target`. The result is
 * deterministic: equal inputs give an identical brick list, layer rows, and snap list.
 */
export function buildBrickAssembly(nodes = [], edges = []) {
  const present = (nodes ?? []).filter((node) => node && node.id !== undefined);
  const ids = present.map((node) => String(node.id));
  const idSet = new Set(ids);
  const byId = new Map(present.map((node) => [String(node.id), node]));

  // A self-edge is not a snap (a brick cannot rest on itself), and an edge to a node the map
  // did not draw is dropped, so the assembly never shows a snap to a missing brick.
  const snaps = [];
  const snapIndex = new Map();
  for (const edge of edges ?? []) {
    const from = String(edge?.source);
    const to = String(edge?.target);
    if (from === to || !idSet.has(from) || !idSet.has(to)) {
      continue;
    }
    const weight = Number(edge.weight) > 1 ? Number(edge.weight) : 1;
    const key = `${from}\u0000${to}`;
    if (snapIndex.has(key)) {
      // The same pair can be recorded more than once; keep the strongest roll-up.
      const existing = snaps[snapIndex.get(key)];
      existing.weight = Math.max(existing.weight, weight);
      continue;
    }
    snapIndex.set(key, snaps.length);
    snaps.push({ from, to, weight });
  }

  const restsOn = new Map(ids.map((id) => [id, new Set()]));
  const carried = new Map(ids.map((id) => [id, new Set()]));
  for (const snap of snaps) {
    restsOn.get(snap.from).add(snap.to);
    carried.get(snap.to).add(snap.from);
  }

  const components = stronglyConnected(ids, restsOn);
  const componentOf = new Map();
  components.forEach((members, position) => {
    for (const id of members) {
      componentOf.set(id, position);
    }
  });
  const cyclic = new Set(
    components.filter((members) => members.length > 1).flatMap((members) => members),
  );

  // Condense the cycles so layering is a longest-path walk over a DAG: a component that rests
  // on another sits one row higher. A cycle is one node, so it cannot lift itself forever.
  const down = components.map(() => new Set());
  for (const snap of snaps) {
    const from = componentOf.get(snap.from);
    const to = componentOf.get(snap.to);
    if (from !== to) {
      down[from].add(to);
    }
  }
  const depthMemo = new Map();
  const depth = (component) => {
    if (depthMemo.has(component)) {
      return depthMemo.get(component);
    }
    let best = 0;
    for (const next of down[component]) {
      best = Math.max(best, depth(next) + 1);
    }
    depthMemo.set(component, best);
    return best;
  };

  const topples = (id) => {
    const seenIds = new Set();
    const queue = [...carried.get(id)];
    while (queue.length > 0) {
      const current = queue.shift();
      if (seenIds.has(current)) {
        continue;
      }
      seenIds.add(current);
      for (const next of carried.get(current) ?? []) {
        queue.push(next);
      }
    }
    return seenIds.size;
  };

  const bricks = ids.map((id) => {
    const node = byId.get(id);
    const mass = massOf(node);
    const studs = Math.min(MAX_STUDS, carried.get(id).size);
    return {
      id,
      label: labelOf(node),
      kind: node.kind ?? 'module',
      layer: depth(componentOf.get(id)),
      footprint: Math.min(MAX_FOOTPRINT, Math.max(1, Math.round(Math.sqrt(mass)))),
      studs,
      restsOn: restsOn.get(id).size,
      carried: carried.get(id).size,
      topples: topples(id),
      cyclic: cyclic.has(id),
      detached: restsOn.get(id).size === 0 && carried.get(id).size === 0,
      dependencies: [...restsOn.get(id)].sort(),
      dependents: [...carried.get(id)].sort(),
    };
  });

  const loadThreshold = Math.max(3, Math.ceil((bricks.length - 1) / 2));
  const maxTopples = bricks.reduce((max, brick) => Math.max(max, brick.topples), 0);
  for (const brick of bricks) {
    brick.status = brick.cyclic
      ? 'tangled'
      : brick.detached
        ? 'detached'
        : brick.topples === maxTopples && brick.topples >= loadThreshold
          ? 'keystone'
          : 'plain';
  }

  const maxLayer = bricks.reduce((max, brick) => Math.max(max, brick.layer), 0);
  const layers = [];
  for (let layer = 0; layer <= maxLayer; layer += 1) {
    layers.push(
      bricks
        .filter((brick) => brick.layer === layer)
        .map((brick) => brick.id)
        .sort(),
    );
  }

  return {
    available: bricks.length > 0,
    bricks,
    snaps,
    layers,
    suggestions: assemblySuggestions(bricks, snaps, components),
    stats: {
      bricks: bricks.length,
      snaps: snaps.length,
      studs: bricks.reduce((total, brick) => total + brick.studs, 0),
      cycles: components.filter((members) => members.length > 1).length,
      detached: bricks.filter((brick) => brick.detached).length,
      maxLayer,
    },
  };
}

/**
 * The assembly problems worth an operator's eye, each naming the recorded edges it read.
 * Tangled cycles come first (they stop the stack), then the load-bearing brick, then the
 * bricks that touch nothing. Nothing speculative: each row is a fact about recorded edges.
 */
function assemblySuggestions(bricks, snaps, components) {
  const byId = new Map(bricks.map((brick) => [brick.id, brick]));
  const nameOf = (id) => byId.get(id)?.label ?? id;
  const suggestions = [];

  for (const members of components) {
    if (members.length < 2) {
      continue;
    }
    const inside = new Set(members);
    const edgeCount = snaps.filter((snap) => inside.has(snap.from) && inside.has(snap.to)).length;
    const names = members.map(nameOf).sort();
    suggestions.push({
      kind: 'tangled',
      bricks: members.slice().sort(),
      title: `Untangle ${members.length} bricks`,
      detail: `${listNames(names)} import each other (${edgeCount} recorded edge${edgeCount === 1 ? '' : 's'}); the stack cannot hold a cycle.`,
    });
  }

  const keystones = bricks.filter((brick) => brick.status === 'keystone');
  if (keystones.length > 0) {
    const lead = keystones.reduce((worst, brick) => (brick.topples > worst.topples ? brick : worst));
    suggestions.push({
      kind: 'keystone',
      bricks: keystones.map((brick) => brick.id),
      title: `Protect ${lead.label}`,
      detail: `${listNames(keystones.map((brick) => brick.label).sort())} carry the most load; removing ${lead.label} topples ${lead.topples} brick${lead.topples === 1 ? '' : 's'}.`,
    });
  }

  const detached = bricks.filter((brick) => brick.detached);
  if (detached.length > 0) {
    suggestions.push({
      kind: 'detached',
      bricks: detached.map((brick) => brick.id),
      title: `${detached.length} detached brick${detached.length === 1 ? '' : 's'}`,
      detail: `${listNames(detached.map((brick) => brick.label).sort())} have no recorded import in either direction.`,
    });
  }

  return suggestions;
}

/** Join names for prose: `a`, `a and b`, `a, b and c`. */
function listNames(names) {
  if (names.length <= 1) {
    return names[0] ?? '';
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Place the bricks on a plane: foundation at the bottom, each snap a line from an upper
 * brick's underside to the top of the brick it rests on. Pure and deterministic, so the
 * assembly does not reshuffle between renders. Rows are centred against the widest row.
 */
export function layoutAssembly(assembly, options = {}) {
  const {
    brickWidth = 26,
    brickHeight = 16,
    studHeight = 6,
    gapX = 8,
    gapY = 18,
    padding = 18,
  } = options;
  const rowHeight = brickHeight + studHeight + gapY;
  const brickById = new Map((assembly?.bricks ?? []).map((brick) => [brick.id, brick]));
  const layers = assembly?.layers ?? [];
  const maxLayer = Math.max(0, layers.length - 1);

  const rowWidths = layers.map(
    (row) =>
      row.reduce((total, id) => total + (brickById.get(id)?.footprint ?? 1) * brickWidth + gapX, 0) -
      (row.length > 0 ? gapX : 0),
  );
  const widest = Math.max(0, ...rowWidths);

  const placed = [];
  layers.forEach((row, layer) => {
    const y = padding + (maxLayer - layer) * rowHeight;
    let x = padding + Math.max(0, (widest - rowWidths[layer]) / 2);
    for (const id of row) {
      const brick = brickById.get(id);
      if (!brick) {
        continue;
      }
      const w = brick.footprint * brickWidth;
      placed.push({ ...brick, x, y, w, h: brickHeight, studHeight });
      x += w + gapX;
    }
  });

  const byId = new Map(placed.map((brick) => [brick.id, brick]));
  const snaps = (assembly?.snaps ?? [])
    .map((snap) => {
      const from = byId.get(snap.from);
      const to = byId.get(snap.to);
      if (!from || !to) {
        return null;
      }
      return {
        ...snap,
        x1: from.x + from.w / 2,
        y1: from.y + from.h,
        x2: to.x + to.w / 2,
        y2: to.y,
      };
    })
    .filter(Boolean);

  const width = padding * 2 + widest;
  const height = padding * 2 + Math.max(1, layers.length) * rowHeight - gapY;
  return { bricks: placed, snaps, width, height };
}

/** One line for the panel header: the assembly's size, then its problems. */
export function assemblySummary(assembly) {
  if (!assembly?.available) {
    return 'No bricks to assemble.';
  }
  const { bricks, snaps, cycles, detached } = assembly.stats;
  const parts = [`${bricks} brick${bricks === 1 ? '' : 's'}`, `${snaps} snap${snaps === 1 ? '' : 's'}`];
  parts.push(cycles === 0 ? 'no cycles' : `${cycles} cycle${cycles === 1 ? '' : 's'}`);
  if (detached > 0) {
    parts.push(`${detached} detached`);
  }
  return parts.join(' · ');
}
