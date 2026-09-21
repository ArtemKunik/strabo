import type { ApiDispatch, DispatchResult } from '../api/dispatch.ts';
import type { GraphEdge } from '../types.ts';

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

/** Items a list returns by default before it is paged. */
export const MCP_DEFAULT_PAGE = 50;
/** The largest page a caller may ask for, so a result stays bounded. */
export const MCP_MAX_PAGE = 500;
/** The serialized ceiling; a body past it is replaced by a truncation marker, never handed over whole. */
export const MCP_MAX_RESULT_CHARS = 200_000;
/** Most truncation notes kept; a long result can truncate many lists. */
const MAX_TRUNCATION_NOTES = 50;

const EVIDENCE_UNAVAILABLE =
  'no recorded graph export was available, so edge evidence was not attached';

const REPOSITORY_SCHEMA = {
  type: 'string',
  description: 'Repository name or path inside the scan ceiling; defaults to the configured root.',
};

const LIMIT_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: MCP_MAX_PAGE,
  description: `Maximum items per list in the result (default ${MCP_DEFAULT_PAGE}).`,
};

const OFFSET_SCHEMA = {
  type: 'integer',
  minimum: 0,
  description: 'Items to skip from the start of each truncated list (default 0).',
};

/** Aliases share the target tool's call function, so an alias cannot drift from its target. */
const TOOL_ALIASES: ReadonlyArray<{ name: string; target: string }> = [
  { name: 'strabo_passport', target: 'get_overview' },
  { name: 'strabo_file', target: 'get_context' },
  { name: 'strabo_impact', target: 'get_impact' },
  { name: 'strabo_review', target: 'get_change_risk' },
  { name: 'strabo_path', target: 'get_dependency_path' },
];

interface PageOptions {
  limit: number;
  offset: number;
}

interface TruncationNote {
  path: string;
  shown: number;
  total: number;
  omitted: number;
  nextOffset: number;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function baseQuery(args: Record<string, unknown>): Record<string, string> {
  const query: Record<string, string> = {};
  const repository = stringArg(args, 'repository');
  if (repository) {
    query.repository = repository;
  }
  return query;
}

function requiredArg(args: Record<string, unknown>, key: string): string {
  const value = stringArg(args, key);
  if (!value) {
    throw new Error(`"${key}" is required.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function intArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), minimum), maximum);
}

function pageOptions(args: Record<string, unknown>): PageOptions {
  return {
    limit: intArg(args, 'limit', MCP_DEFAULT_PAGE, 1, MCP_MAX_PAGE),
    offset: intArg(args, 'offset', 0, 0, Number.MAX_SAFE_INTEGER),
  };
}

/**
 * Cap every list at the page size and record what was cut, so a bounded result says so
 * instead of looking complete. A list at or below the page size is untouched.
 */
function boundLists(
  value: unknown,
  page: PageOptions,
  path: string,
  notes: TruncationNote[],
  truncated: { count: number },
): unknown {
  if (Array.isArray(value)) {
    let list = value;
    if (value.length > page.limit) {
      list = value.slice(page.offset, page.offset + page.limit);
      truncated.count += 1;
      if (notes.length < MAX_TRUNCATION_NOTES) {
        const omitted = value.length - list.length;
        notes.push({
          path,
          shown: list.length,
          total: value.length,
          omitted,
          nextOffset: page.offset + page.limit,
        });
      }
    }
    return list.map((item, index) =>
      boundLists(item, page, `${path}[${index}]`, notes, truncated),
    );
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = boundLists(nested, page, path === '$' ? key : `${path}.${key}`, notes, truncated);
    }
    return result;
  }
  return value;
}

/** Serialize a tool body, paged and capped, with a positive truncation marker when it was cut. */
function boundedText(body: unknown, args: Record<string, unknown>): string {
  const page = pageOptions(args);
  const notes: TruncationNote[] = [];
  const truncated = { count: 0 };
  const bounded = boundLists(body, page, '$', notes, truncated);

  let value: unknown = bounded;
  if (truncated.count > 0) {
    const marker = {
      truncated: true,
      listsTruncated: truncated.count,
      page: { limit: page.limit, offset: page.offset },
      truncation: notes,
    };
    value = isRecord(bounded) ? { ...bounded, ...marker } : { ...marker, value: bounded };
  }

  const text = JSON.stringify(value, null, 2);
  if (text.length <= MCP_MAX_RESULT_CHARS) {
    return text;
  }
  return JSON.stringify(
    {
      truncated: true,
      reason: `the serialized result is ${text.length} characters, over the ${MCP_MAX_RESULT_CHARS}-character MCP cap`,
      page: { limit: page.limit, offset: page.offset },
      listsTruncated: truncated.count,
      truncation: notes,
      detail:
        'The body was omitted rather than handed over unbounded; re-call with a smaller limit/offset or a narrower query.',
    },
    null,
    2,
  );
}

function toResult(result: DispatchResult, args: Record<string, unknown> = {}): McpToolResult {
  if (result.status >= 200 && result.status < 300) {
    return { content: [{ type: 'text', text: boundedText(result.body, args) }] };
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          { unavailable: true, status: result.status, detail: result.body },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

async function getRaw(
  dispatch: ApiDispatch,
  path: string,
  args: Record<string, unknown>,
  extra: Record<string, string | undefined> = {},
): Promise<DispatchResult> {
  const query = baseQuery(args);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) {
      query[key] = value;
    }
  }
  const suffix = new URLSearchParams(query).toString();
  return dispatch('GET', suffix ? `${path}?${suffix}` : path);
}

function get(
  dispatch: ApiDispatch,
  path: string,
  args: Record<string, unknown>,
  extra: Record<string, string | undefined> = {},
): Promise<McpToolResult> {
  return getRaw(dispatch, path, args, extra).then((result) => toResult(result, args));
}

interface EdgeIndex {
  /** The first recorded edge per source→target pair, deterministically chosen. */
  byPair: Map<string, GraphEdge>;
  incoming: Map<string, GraphEdge[]>;
  outgoing: Map<string, GraphEdge[]>;
}

function pairKey(source: string, target: string): string {
  return `${source}\u0000${target}`;
}

/** Import-family edges read as the dependency's reason before a call or a table link does. */
const EDGE_KIND_RANK: Record<string, number> = {
  import: 0,
  require: 1,
  'dynamic-import': 2,
  're-export': 3,
  package: 4,
  namespace: 5,
  call: 6,
  table: 7,
  program: 8,
  copybook: 9,
  propath: 10,
};

function compareEdges(a: GraphEdge, b: GraphEdge): number {
  const rank = (EDGE_KIND_RANK[a.kind] ?? 99) - (EDGE_KIND_RANK[b.kind] ?? 99);
  if (rank !== 0) return rank;
  if (a.evidence.line !== b.evidence.line) return a.evidence.line - b.evidence.line;
  return a.evidence.specifier.localeCompare(b.evidence.specifier);
}

function pushEdge(map: Map<string, GraphEdge[]>, key: string, edge: GraphEdge): void {
  const list = map.get(key);
  if (list) {
    list.push(edge);
  } else {
    map.set(key, [edge]);
  }
}

/**
 * Index the recorded graph edges so a tool can attach the import line and specifier behind
 * each edge it returns. `declare` edges are left out, matching the analysis adjacency.
 */
function buildEdgeIndex(edges: readonly GraphEdge[]): EdgeIndex {
  const byPair = new Map<string, GraphEdge>();
  const incoming = new Map<string, GraphEdge[]>();
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    if (edge.role === 'declare') {
      continue;
    }
    const key = pairKey(edge.source, edge.target);
    const existing = byPair.get(key);
    if (!existing || compareEdges(edge, existing) < 0) {
      byPair.set(key, edge);
    }
    pushEdge(outgoing, edge.source, edge);
    pushEdge(incoming, edge.target, edge);
  }
  for (const list of [...incoming.values(), ...outgoing.values()]) {
    list.sort(compareEdges);
  }
  return { byPair, incoming, outgoing };
}

function parseEnvelope(body: unknown): { edges: GraphEdge[] } | null {
  try {
    const parsed = typeof body === 'string' ? (JSON.parse(body) as unknown) : body;
    if (isRecord(parsed) && Array.isArray(parsed.edges)) {
      return { edges: parsed.edges as GraphEdge[] };
    }
  } catch {
    // An unparseable export is treated as no evidence rather than guessed at.
  }
  return null;
}

/** Read the portable graph so edge evidence travels with a file-level tool result. */
async function fetchEdgeIndex(
  dispatch: ApiDispatch,
  args: Record<string, unknown>,
): Promise<EdgeIndex | null> {
  const query: Record<string, string> = { ...baseQuery(args), format: 'json' };
  const result = await dispatch('GET', `/export?${new URLSearchParams(query).toString()}`);
  if (result.status < 200 || result.status >= 300) {
    return null;
  }
  const envelope = parseEnvelope(result.body);
  return envelope ? buildEdgeIndex(envelope.edges) : null;
}

async function getWithEvidence(
  dispatch: ApiDispatch,
  args: Record<string, unknown>,
  path: string,
  extra: Record<string, string | undefined>,
  augment: (body: unknown, index: EdgeIndex | null) => unknown,
): Promise<McpToolResult> {
  const result = await getRaw(dispatch, path, args, extra);
  if (result.status < 200 || result.status >= 300) {
    return toResult(result, args);
  }
  const index = await fetchEdgeIndex(dispatch, args);
  return toResult({ status: result.status, body: augment(result.body, index) }, args);
}

/** A path hop carries the recorded import line and specifier behind it, not just the target. */
function attachPathEvidence(body: unknown, index: EdgeIndex | null): unknown {
  if (!isRecord(body)) {
    return body;
  }
  const path = Array.isArray(body.path)
    ? body.path.filter((id): id is string => typeof id === 'string')
    : [];
  if (body.found !== true || path.length < 2) {
    return { ...body, edges: [] };
  }
  if (!index) {
    return { ...body, edges: [], evidenceUnavailable: EVIDENCE_UNAVAILABLE };
  }
  const edges: GraphEdge[] = [];
  for (let i = 0; i + 1 < path.length; i += 1) {
    const source = path[i];
    const target = path[i + 1];
    if (source === undefined || target === undefined) {
      continue;
    }
    const edge = index.byPair.get(pairKey(source, target));
    if (edge) {
      edges.push(edge);
    }
  }
  return { ...body, edges };
}

/** A file passport carries the recorded edges into and out of the file, evidence included. */
function attachFileEvidence(body: unknown, index: EdgeIndex | null, file: string): unknown {
  if (!isRecord(body)) {
    return body;
  }
  if (!index) {
    return { ...body, imports: [], importers: [], evidenceUnavailable: EVIDENCE_UNAVAILABLE };
  }
  return {
    ...body,
    imports: [...(index.outgoing.get(file) ?? [])],
    importers: [...(index.incoming.get(file) ?? [])],
  };
}

/** Each affected file names the recorded edge that reached it from one hop closer. */
function attachImpactEvidence(body: unknown, index: EdgeIndex | null): unknown {
  if (!isRecord(body)) {
    return body;
  }
  if (!index) {
    return { ...body, edges: [], evidenceUnavailable: EVIDENCE_UNAVAILABLE };
  }
  const distance = new Map<string, number>();
  for (const entry of Array.isArray(body.affected) ? body.affected : []) {
    if (isRecord(entry) && typeof entry.id === 'string' && typeof entry.distance === 'number') {
      distance.set(entry.id, entry.distance);
    }
  }
  const edges: GraphEdge[] = [];
  for (const [id, hop] of [...distance.entries()].sort(
    (a, b) => a[1] - b[1] || a[0].localeCompare(b[0]),
  )) {
    if (hop === 0) {
      continue;
    }
    const candidate = (index.outgoing.get(id) ?? []).find(
      (edge) => distance.get(edge.target) === hop - 1,
    );
    if (candidate) {
      edges.push(candidate);
    }
  }
  return { ...body, edges };
}

function buildCanonicalTools(dispatch: ApiDispatch): McpTool[] {
  return [
    {
      name: 'get_overview',
      description:
        'The repository passport: languages, size, entry points, layers, top files by fan-in, cycles, and modules no test reaches.',
      inputSchema: {
        type: 'object',
        properties: { repository: REPOSITORY_SCHEMA, limit: LIMIT_SCHEMA, offset: OFFSET_SCHEMA },
        additionalProperties: false,
      },
      call: (args) => get(dispatch, '/analysis/passport', args),
    },
    {
      name: 'get_context',
      description:
        'The change-impact passport for one file: current-graph snapshot, complexity, signals, and pending-change deltas, with the recorded import edges and their evidence.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          repository: REPOSITORY_SCHEMA,
          limit: LIMIT_SCHEMA,
          offset: OFFSET_SCHEMA,
        },
        required: ['file'],
        additionalProperties: false,
      },
      call: (args) => {
        const file = requiredArg(args, 'file');
        return getWithEvidence(
          dispatch,
          args,
          '/analysis/impact-passport',
          { file },
          (body, index) => attachFileEvidence(body, index, file),
        );
      },
    },
    {
      name: 'get_dependency_path',
      description:
        'The shortest recorded dependency path from one file to another, or an explicit no-path answer, with the import line and specifier behind every hop.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          repository: REPOSITORY_SCHEMA,
          limit: LIMIT_SCHEMA,
          offset: OFFSET_SCHEMA,
        },
        required: ['from', 'to'],
        additionalProperties: false,
      },
      call: (args) => {
        const from = requiredArg(args, 'from');
        const to = requiredArg(args, 'to');
        return getWithEvidence(
          dispatch,
          args,
          '/analysis/dependency-path',
          { from, to },
          attachPathEvidence,
        );
      },
    },
    {
      name: 'get_impact',
      description:
        'Reverse-dependency impact of the pending change set, or of one revision against its first parent, with the recorded edge that reached each affected file.',
      inputSchema: {
        type: 'object',
        properties: {
          base: { type: 'string' },
          repository: REPOSITORY_SCHEMA,
          limit: LIMIT_SCHEMA,
          offset: OFFSET_SCHEMA,
        },
        additionalProperties: false,
      },
      call: (args) =>
        getWithEvidence(
          dispatch,
          args,
          '/analysis/impact',
          { base: stringArg(args, 'base') },
          attachImpactEvidence,
        ),
    },
    {
      name: 'get_risk',
      description:
        'The bounded risk reading for one file: complexity, blast radius, test reach, and the risk band.',
      inputSchema: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          repository: REPOSITORY_SCHEMA,
          limit: LIMIT_SCHEMA,
          offset: OFFSET_SCHEMA,
        },
        required: ['file'],
        additionalProperties: false,
      },
      call: (args) => get(dispatch, '/analysis/impact-passport', args, { file: requiredArg(args, 'file') }),
    },
    {
      name: 'get_change_risk',
      description:
        'The pending working-tree change set: its files, tiered impact, and rolled-up risk passports.',
      inputSchema: {
        type: 'object',
        properties: { repository: REPOSITORY_SCHEMA, limit: LIMIT_SCHEMA, offset: OFFSET_SCHEMA },
        additionalProperties: false,
      },
      call: (args) => get(dispatch, '/analysis/review', args),
    },
    {
      name: 'get_cycles',
      description: 'The strongly connected components of the resolved dependency graph.',
      inputSchema: {
        type: 'object',
        properties: { repository: REPOSITORY_SCHEMA, limit: LIMIT_SCHEMA, offset: OFFSET_SCHEMA },
        additionalProperties: false,
      },
      call: (args) => get(dispatch, '/analysis/cycles', args),
    },
    {
      name: 'get_smells',
      description: 'Repository-wide module smells, each with the measures that tripped it.',
      inputSchema: {
        type: 'object',
        properties: { repository: REPOSITORY_SCHEMA, limit: LIMIT_SCHEMA, offset: OFFSET_SCHEMA },
        additionalProperties: false,
      },
      call: (args) => get(dispatch, '/analysis/smells', args),
    },
    {
      name: 'get_tier',
      description:
        'The tier lens: each file and unit role, the tier matrix, and recorded dependencies that run the wrong way.',
      inputSchema: {
        type: 'object',
        properties: { repository: REPOSITORY_SCHEMA, limit: LIMIT_SCHEMA, offset: OFFSET_SCHEMA },
        additionalProperties: false,
      },
      call: (args) => get(dispatch, '/analysis/tiers', args),
    },
    {
      name: 'get_dead_code',
      description: 'Files nothing imports, and that are neither entry points nor tests.',
      inputSchema: {
        type: 'object',
        properties: { repository: REPOSITORY_SCHEMA, limit: LIMIT_SCHEMA, offset: OFFSET_SCHEMA },
        additionalProperties: false,
      },
      call: async (args) => {
        const result = await get(dispatch, '/analysis/smells', args);
        if (result.isError) {
          return result;
        }
        const parsed = JSON.parse(result.content[0]?.text ?? '{}') as {
          repository?: string;
          files?: Array<{ file: string; smells: Array<{ rule: string; detail: string }> }>;
          truncated?: boolean;
          truncation?: unknown;
        };
        const files = (parsed.files ?? [])
          .map((entry) => ({
            file: entry.file,
            smells: entry.smells.filter((smell) => smell.rule === 'dead'),
          }))
          .filter((entry) => entry.smells.length > 0);
        const body = {
          repository: parsed.repository,
          files,
          ...(parsed.truncated ? { truncated: true, truncation: parsed.truncation } : {}),
        };
        return { content: [{ type: 'text', text: boundedText(body, args) }] };
      },
    },
  ];
}

export function createTools(dispatch: ApiDispatch): McpTool[] {
  const canonical = buildCanonicalTools(dispatch);
  const byName = new Map(canonical.map((tool) => [tool.name, tool]));
  const aliases = TOOL_ALIASES.map(({ name, target }): McpTool => {
    const tool = byName.get(target);
    if (!tool) {
      throw new Error(`MCP alias "${name}" names unknown tool "${target}".`);
    }
    return {
      name,
      description: `Alias of ${target}. ${tool.description}`,
      inputSchema: tool.inputSchema,
      call: tool.call,
    };
  });
  return [...canonical, ...aliases];
}
