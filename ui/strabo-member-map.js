/**
 * Member map for one file: the walkthrough steps, field and method cards, wiring
 * clusters, the bipartite data-flow graph and its layout, and member ordering. Everything
 * is derived from recorded members and wiring; absent evidence is named, not filled in.
 *
 * Pure functions only: no DOM, no fetch.
 */

/* ------------------------------------------------------------------ Member map */

function totalMembers(memberMap, key) {
  return (memberMap?.types ?? []).reduce((sum, type) => sum + (type[key] ?? []).length, 0);
}

/**
 * The five-step flow walkthrough for a member map.
 *
 * Each caption is derived from recorded data. Steps whose evidence is missing say so
 * rather than inventing a story, matching the "no wiring recorded" state in the design.
 * `context.consumers` is the number of repository files that import this one, or null
 * when the caller has no graph for the file.
 */
export function memberMapSteps(memberMap, context = {}) {
  const types = memberMap?.types ?? [];
  const primary = types[0] ?? null;
  const fields = totalMembers(memberMap, 'fields');
  const methods = totalMembers(memberMap, 'methods');
  const reExports = memberMap?.reExports ?? [];
  const flow = memberMap?.dataFlow;
  const consumers = context.consumers ?? null;

  // One type is named; several are attributed to the file, because the totals span every
  // type and naming only the first would claim its siblings' members (a real miscount).
  const subject =
    types.length > 1
      ? `This file (${types.length} types) contains`
      : `${primary?.name ?? 'This file'} contains`;
  // A barrel declares nothing, so its re-exports are the whole fingerprint; naming them
  // keeps "0 field(s) and 0 behavior(s)" from reading as an empty file.
  const reExportModules = new Set(reExports.map((entry) => entry.from)).size;
  const barrel = fields === 0 && methods === 0 && reExports.length > 0;
  const fingerprint = barrel
    ? `This file re-exports ${reExports.length} name(s) from ${reExportModules} module(s).`
    : `${subject} ${fields} field(s) and ${methods} behavior(s).`;
  const membersCaption = barrel
    ? `${reExports.length} re-export(s) and no declared members.`
    : `${fields} field(s) and ${methods} method(s) recorded.`;

  const wiring =
    flow?.available === false
      ? 'No field-to-behavior wiring was recorded in the scan.'
      : `${(flow?.transforms ?? []).length} transform(s) read and write state across ${(flow?.resources ?? []).length} shared field(s).`;

  return [
    {
      key: 'fingerprint',
      label: 'fingerprint',
      caption: fingerprint,
    },
    {
      key: 'members',
      label: 'members',
      caption: membersCaption,
    },
    { key: 'wiring', label: 'wiring', caption: wiring },
    {
      key: 'data-flow',
      label: 'data flow',
      caption: `Inputs: ${(flow?.sources ?? []).length} · resources: ${(flow?.resources ?? []).length} · transforms: ${(flow?.transforms ?? []).length} · sinks: ${(flow?.sinks ?? []).length}.`,
    },
    {
      key: 'consumption',
      label: 'consumption',
      caption:
        consumers === null
          ? 'Repository consumers were not recorded for this file.'
          : `${consumers} repository consumer(s) import this file.`,
    },
  ];
}

/** The eyebrow, signature, tag, and metrics line for one field card. */
export function fieldCard(field) {
  const connected = field.reads > 0 || field.writes > 0;
  return {
    eyebrow: `FIELD · ${String(field.visibility ?? 'unknown').toUpperCase()} · ${field.mutable === false ? 'READONLY' : 'MUTABLE'}`,
    signature: `${field.name}: ${field.type ?? 'unrecorded type'}`,
    tag: connected ? `${field.reads} read · ${field.writes} write` : 'unconnected',
    metrics: `public data · local reads ${field.reads} · local writes ${field.writes}`,
  };
}

/** The line under one method card. */
export function methodCard(method) {
  const wired = method.reads.length > 0 || method.writes.length > 0;
  const params = method.parameters ?? 0;
  return {
    eyebrow: `METHOD · ${String(method.visibility ?? 'unknown').toUpperCase()}`,
    signature: `${method.name}(${params})${method.type ? `: ${method.type}` : ''}`,
    tag: wired ? 'wired' : 'unconnected',
    metrics: `reads ${method.reads.join(', ') || 'none'} · writes ${method.writes.join(', ') || 'none'}`,
  };
}

/**
 * Cluster members by the wiring the scan recorded: a method joins every field it reads or
 * writes, and each connected component is a cluster. Members with no wiring are singleton
 * clusters, which is why a type with no recorded wiring shows one cluster per member.
 */
export function memberClusters(memberMap) {
  const adjacency = new Map();
  const ensure = (name) => {
    if (!adjacency.has(name)) {
      adjacency.set(name, new Set());
    }
    return adjacency.get(name);
  };

  for (const type of memberMap?.types ?? []) {
    for (const field of type.fields) ensure(field.name);
    for (const method of type.methods) {
      ensure(method.name);
      for (const field of [...method.reads, ...method.writes]) {
        if (!adjacency.has(field)) {
          continue;
        }
        adjacency.get(field).add(method.name);
        adjacency.get(method.name).add(field);
      }
    }
  }

  const clusterOf = new Map();
  const clusters = [];
  for (const name of adjacency.keys()) {
    if (clusterOf.has(name)) {
      continue;
    }
    const index = clusters.length + 1;
    const members = [];
    const queue = [name];
    clusterOf.set(name, index);
    while (queue.length > 0) {
      const currentMember = queue.shift();
      members.push(currentMember);
      for (const neighbour of adjacency.get(currentMember) ?? []) {
        if (!clusterOf.has(neighbour)) {
          clusterOf.set(neighbour, index);
          queue.push(neighbour);
        }
      }
    }
    clusters.push({ index, members: members.sort() });
  }

  return { clusters, clusterOf };
}

/**
 * The categorical class for a member cluster.
 *
 * Clusters are the one genuine categorical set in the UI, and their cards sit adjacent, so
 * the set is capped at three hues plus one neutral rather than cycled: the fourth cluster
 * and later share `series-other`. There is deliberately no modulo, which would map
 * unrelated clusters onto the same hue where the eye cannot tell them apart.
 */
export function clusterSeriesClass(index) {
  return index >= 1 && index <= 3 ? `series-${index}` : 'series-other';
}

/**
 * Bipartite data-flow graph from recorded wiring only: fields on the left,
 * methods on the right. A read is an edge field → method, a write is an edge
 * method → field. References to undeclared members are dropped so the diagram
 * never draws dangling arrows; use the panels when you need the raw lists.
 */
export function flowGraph(memberMap) {
  const nodes = [];
  const seen = new Set();
  const edges = [];
  const edgeKeys = new Set();

  const addNode = (id, kind, label) => {
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push({ id, kind, label });
    }
  };
  const addEdge = (from, to, kind) => {
    const key = `${from}→${to}:${kind}`;
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push({ from, to, kind });
    }
  };

  for (const type of memberMap?.types ?? []) {
    for (const field of type.fields ?? []) {
      addNode(`field:${field.name}`, 'field', field.name);
    }
    for (const method of type.methods ?? []) {
      const methodId = `method:${method.name}`;
      addNode(methodId, 'method', method.name);
      for (const name of method.reads ?? []) {
        addEdge(`field:${name}`, methodId, 'read');
      }
      for (const name of method.writes ?? []) {
        addEdge(methodId, `field:${name}`, 'write');
      }
    }
  }

  const known = new Set(nodes.map((node) => node.id));
  return { nodes, edges: edges.filter((edge) => known.has(edge.from) && known.has(edge.to)) };
}

/**
 * Deterministic two-column layout for a flow graph: fields left, methods
 * right, rows in declaration order. Pure positions, no simulation, so the
 * diagram is stable across renders.
 */
export function layoutFlowGraph(graph, { width = 680, nodeWidth = 170, nodeHeight = 30, gap = 12 } = {}) {
  const place = (kind, x) =>
    graph.nodes
      .filter((node) => node.kind === kind)
      .map((node, index) => ({ ...node, x, y: index * (nodeHeight + gap), w: nodeWidth, h: nodeHeight }));
  const placed = [...place('field', 0), ...place('method', Math.max(0, width - nodeWidth))];
  const rows = Math.max(
    graph.nodes.filter((node) => node.kind === 'field').length,
    graph.nodes.filter((node) => node.kind === 'method').length,
    1,
  );
  return { nodes: placed, edges: graph.edges, width, height: rows * (nodeHeight + gap) - gap };
}

/** A one-sentence explanation of the class, from recorded members and wiring only. */
export function explainClass(memberMap) {
  const type = (memberMap?.types ?? [])[0];
  if (!type) {
    const reExports = memberMap?.reExports ?? [];
    if (reExports.length > 0) {
      const modules = new Set(reExports.map((entry) => entry.from)).size;
      return `This file declares no members; it re-exports ${reExports.length} name(s) from ${modules} module(s).`;
    }
    return 'No type was recorded for this file.';
  }
  const flow = memberMap.dataFlow;
  const wiring =
    flow?.available === false
      ? 'No field-to-behavior wiring was recorded in the scan.'
      : `${flow.transforms.length} method(s) read and write state across ${flow.resources.length} shared field(s).`;
  return `${type.name} declares ${type.fields.length} field(s) and ${type.methods.length} method(s). ${wiring}`;
}

/** Sort a member list for the Order control. Returns a new array. */
export function orderMembers(members, order) {
  const copy = [...members];
  if (order === 'name') {
    return copy.sort((a, b) => a.name.localeCompare(b.name));
  }
  if (order === 'visibility') {
    return copy.sort(
      (a, b) => String(a.visibility).localeCompare(String(b.visibility)) || a.name.localeCompare(b.name),
    );
  }
  return copy.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

/** A member is "wired" when the scan recorded it touching state. */
export function isWiredField(field) {
  return field.reads > 0 || field.writes > 0;
}

export function isWiredMethod(method) {
  return method.reads.length > 0 || method.writes.length > 0;
}
