import type { Diagnostic, Exclusion, Graph, GraphEdge, GraphNode } from '../types.ts';

export const GRAPH_EXPORT_VERSION = 'strabo-export-1';

export type GraphExportFormat = 'json' | 'dot' | 'mermaid';

export interface GraphExportOptions {
  format: GraphExportFormat;
  fingerprint?: string | null;
  revision?: string | null;
  generatedAt?: string;
  includeDeclare?: boolean;
}

export interface GraphExportEnvelope {
  version: string;
  format: 'json';
  fingerprint: string | null;
  revision: string | null;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
  excluded: Exclusion[];
}

export function exportGraph(graph: Graph, options: GraphExportOptions): string {
  const nodes = orderedNodes(graph.nodes);
  const edges = orderedEdges(graph.edges, options.includeDeclare === true);
  if (options.format === 'json') {
    return JSON.stringify(toEnvelope(graph, nodes, edges, options), null, 2);
  }
  if (options.format === 'dot') {
    return toDot(nodes, edges);
  }
  return toMermaid(nodes, edges);
}

function orderedNodes(nodes: GraphNode[]): GraphNode[] {
  return [...nodes].sort((a, b) => a.id.localeCompare(b.id));
}

function orderedEdges(edges: GraphEdge[], includeDeclare: boolean): GraphEdge[] {
  return edges
    .filter((edge) => includeDeclare || edge.role !== 'declare')
    .slice()
    .sort(
      (a, b) =>
        a.source.localeCompare(b.source) ||
        a.target.localeCompare(b.target) ||
        a.kind.localeCompare(b.kind) ||
        a.evidence.line - b.evidence.line ||
        a.evidence.specifier.localeCompare(b.evidence.specifier),
    );
}

function toEnvelope(
  graph: Graph,
  nodes: GraphNode[],
  edges: GraphEdge[],
  options: GraphExportOptions,
): GraphExportEnvelope {
  return {
    version: GRAPH_EXPORT_VERSION,
    format: 'json',
    fingerprint: options.fingerprint ?? null,
    revision: options.revision ?? null,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    nodes,
    edges,
    diagnostics: [...graph.diagnostics].sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.message.localeCompare(b.message),
    ),
    excluded: [...graph.excluded].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function labelOf(node: GraphNode): string {
  if (node.label) {
    return node.label;
  }
  const slash = node.id.lastIndexOf('/');
  return slash === -1 ? node.id : node.id.slice(slash + 1);
}

function escapeDot(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
}

function escapeMermaid(value: string): string {
  return value.replace(/"/g, '&quot;').replace(/\r?\n/g, ' ');
}

function toDot(nodes: GraphNode[], edges: GraphEdge[]): string {
  const lines: string[] = ['digraph strabo {', '  rankdir=LR;', '  node [shape=box];'];
  for (const node of nodes) {
    lines.push(`  "${escapeDot(node.id)}" [label="${escapeDot(labelOf(node))}"];`);
  }
  for (const edge of edges) {
    const style = edge.role === 'declare' ? ' [style=dashed]' : '';
    lines.push(`  "${escapeDot(edge.source)}" -> "${escapeDot(edge.target)}"${style};`);
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function toMermaid(nodes: GraphNode[], edges: GraphEdge[]): string {
  const lines: string[] = ['graph TD'];
  for (const node of nodes) {
    lines.push(`  "${escapeMermaid(node.id)}"["${escapeMermaid(labelOf(node))}"]`);
  }
  for (const edge of edges) {
    const arrow = edge.role === 'declare' ? '-.->' : '-->';
    lines.push(`  "${escapeMermaid(edge.source)}" ${arrow} "${escapeMermaid(edge.target)}"`);
  }
  return `${lines.join('\n')}\n`;
}
