import type { Graph } from '../types.ts';
import { detectCommunities } from './system-communities.ts';
import { aggregateEdges } from './system-edges.ts';
import { assignLayers } from './system-layers.ts';
import type {
  SystemCommunity,
  SystemEdge,
  SystemLayer,
  SystemNode,
  SystemPeriphery,
  SystemReport,
} from './system-types.ts';
import {
  applyDeclaredGroups,
  classifyPeriphery,
  detectUnits,
  readDeclaredGroups,
} from './units.ts';

export type {
  SystemReport,
  SystemNode,
  SystemEdge,
  SystemLayer,
  SystemCommunity,
  SystemPeriphery,
} from './system-types.ts';

/**
 * Roll a file graph up into build units and the layers inside them.
 *
 * Nothing here is inferred from names or proximity: a unit exists because a manifest
 * declared one, a layer because the recorded imports point one way, and a community because
 * the recorded edges are denser inside it than across it. Files the scanner marked as
 * support (tests, scripts, generated, fixtures) fold into a shelf instead of becoming
 * components.
 */
export function buildSystemReport(root: string, repositoryName: string, graph: Graph): SystemReport {
  const files = graph.nodes.map((node) => node.id);
  const derived = detectUnits(root, files, repositoryName);
  const { units, assignment } = applyDeclaredGroups(derived, files, readDeclaredGroups(root));
  const kindOf = new Map(graph.nodes.map((node) => [node.id, node.kind]));

  const periphery: SystemPeriphery[] = [];
  const componentFiles = new Map<string, string[]>(units.map((unit) => [unit.id, []]));
  for (const file of files) {
    const unit = assignment.get(file) ?? '.';
    const classified = classifyPeriphery(file, kindOf.get(file) ?? 'module');
    if (classified) {
      periphery.push({ ...classified, unit });
      continue;
    }
    componentFiles.get(unit)?.push(file);
  }

  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const nodes: SystemNode[] = units.map((unit) => ({
    id: unit.id,
    name: unit.name,
    ecosystem: unit.ecosystem,
    manifest: unit.manifest,
    parent: unit.parent,
    why: unit.why,
    files: componentFiles.get(unit.id)?.length ?? 0,
    periphery: periphery.filter((entry) => assignment.get(entry.file) === unit.id).length,
    declared: unit.declared,
    overrides: unit.overrides,
  }));

  const edges = aggregateEdges(graph, assignment, unitById, componentFiles);

  const layers: SystemLayer[] = [];
  const communities: SystemCommunity[] = [];
  for (const unit of units) {
    const members = componentFiles.get(unit.id) ?? [];
    if (members.length === 0) {
      continue;
    }
    const unitLayers = assignLayers(unit, members, graph);
    layers.push(...unitLayers);
    for (const layer of unitLayers) {
      communities.push(...detectCommunities(unit.id, layer, graph));
    }
  }

  return {
    units: nodes,
    edges,
    layers: layers.sort((a, b) => a.unit.localeCompare(b.unit) || a.order - b.order || a.name.localeCompare(b.name)),
    communities,
    periphery: periphery.sort((a, b) => a.file.localeCompare(b.file)),
    summary: {
      units: nodes.length,
      edges: edges.length,
      layers: layers.length,
      communities: communities.length,
      periphery: periphery.length,
    },
  };
}
