import type { ViewModel, ViewNode } from '../types.ts';

export interface SvgExportOptions {
  title?: string;
  width?: number;
  height?: number;
  maxNodes?: number;
  generatedAt?: string;
}

const PADDING = 48;
const CAPTION_HEIGHT = 56;
const NODE_RADIUS = 7;

const KIND_COLOURS: Record<string, string> = {
  module: '#4c9aff',
  test: '#6bd08b',
  entry: '#f2b04c',
  unit: '#b98bff',
  shelf: '#8b93a7',
};

export function renderViewModelSvg(model: ViewModel, options: SvgExportOptions = {}): string {
  const width = options.width ?? 1600;
  const height = options.height ?? 1000;
  const maxNodes = options.maxNodes ?? 400;
  const positions = new Map(model.positions.map((position) => [position.id, position]));
  const ordered = [...model.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const drawn = ordered.filter((node) => positions.has(node.id)).slice(0, maxNodes);
  const drawnIds = new Set(drawn.map((node) => node.id));

  const xs = drawn.map((node) => positions.get(node.id)?.x ?? 0);
  const ys = drawn.map((node) => positions.get(node.id)?.y ?? 0);
  const minX = xs.length > 0 ? Math.min(...xs) : 0;
  const maxX = xs.length > 0 ? Math.max(...xs) : 0;
  const minY = ys.length > 0 ? Math.min(...ys) : 0;
  const maxY = ys.length > 0 ? Math.max(...ys) : 0;

  const plotWidth = Math.max(1, width - PADDING * 2);
  const plotHeight = Math.max(1, height - CAPTION_HEIGHT - PADDING * 2);
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const scale = Math.min(plotWidth / spanX, plotHeight / spanY);

  const project = (id: string): { x: number; y: number } | null => {
    const position = positions.get(id);
    if (!position) {
      return null;
    }
    return {
      x: PADDING + (position.x - minX) * scale,
      y: PADDING + (maxY - position.y) * scale,
    };
  };

  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(options.title ?? model.repository.name)}">`,
  );
  lines.push(`<rect width="${width}" height="${height}" fill="#0c1016"/>`);

  lines.push('<g stroke="#2b3444" stroke-width="1">');
  for (const edge of model.edges) {
    if (!drawnIds.has(edge.source) || !drawnIds.has(edge.target)) {
      continue;
    }
    const from = project(edge.source);
    const to = project(edge.target);
    if (!from || !to) {
      continue;
    }
    const dash = edge.role === 'declare' ? ' stroke-dasharray="4 3"' : '';
    lines.push(
      `<line x1="${round(from.x)}" y1="${round(from.y)}" x2="${round(to.x)}" y2="${round(to.y)}"${dash}/>`,
    );
  }
  lines.push('</g>');

  for (const node of drawn) {
    const point = project(node.id);
    if (!point) {
      continue;
    }
    lines.push(
      `<circle cx="${round(point.x)}" cy="${round(point.y)}" r="${NODE_RADIUS}" fill="${KIND_COLOURS[node.kind] ?? KIND_COLOURS.module}"/>`,
    );
  }

  lines.push('<g fill="#c8d2e0" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11">');
  for (const node of drawn) {
    const point = project(node.id);
    if (!point) {
      continue;
    }
    lines.push(
      `<text x="${round(point.x)}" y="${round(point.y + NODE_RADIUS + 12)}" text-anchor="middle">${escapeXml(labelOf(node))}</text>`,
    );
  }
  lines.push('</g>');

  const truncated = ordered.filter((node) => positions.has(node.id)).length - drawn.length;
  lines.push(renderLegend(width, height));
  lines.push(renderCaption(model, width, height, truncated, options));
  lines.push('</svg>');
  return lines.join('\n');
}

function renderLegend(width: number, height: number): string {
  const entries: Array<[string, string]> = [
    ['module', KIND_COLOURS.module as string],
    ['test', KIND_COLOURS.test as string],
    ['entry', KIND_COLOURS.entry as string],
    ['unit', KIND_COLOURS.unit as string],
  ];
  const baseY = height - CAPTION_HEIGHT - 18;
  const parts = ['<g font-family="ui-sans-serif, system-ui, sans-serif" font-size="11" fill="#8b93a7">'];
  let x = PADDING;
  for (const [label, colour] of entries) {
    parts.push(`<circle cx="${x}" cy="${baseY}" r="5" fill="${colour}"/>`);
    parts.push(`<text x="${x + 10}" y="${baseY + 4}">${escapeXml(label)}</text>`);
    x += 74;
  }
  parts.push('</g>');
  return parts.join('\n');
}

function renderCaption(
  model: ViewModel,
  width: number,
  height: number,
  truncated: number,
  options: SvgExportOptions,
): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const fingerprint = model.cache.fingerprint ?? 'no revision';
  const revision = fingerprint.split(':')[0] ?? fingerprint;
  const truncatedNote = truncated > 0 ? ` · ${truncated} more nodes not drawn` : '';
  const text = `${options.title ?? model.repository.name} · ${model.nodes.length} nodes, ${model.edges.length} edges · indexed at ${revision} · generated ${generatedAt}${truncatedNote}`;
  return `<text x="${PADDING}" y="${height - 24}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" fill="#8b93a7">${escapeXml(text)}</text>`;
}

function labelOf(node: ViewNode): string {
  if (node.label) {
    return node.label;
  }
  const slash = node.id.lastIndexOf('/');
  return slash === -1 ? node.id : node.id.slice(slash + 1);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
