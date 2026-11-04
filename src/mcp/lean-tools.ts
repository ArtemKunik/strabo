/**
 * The lean tool list: the everyday tools, plus one tool that reaches all the others.
 *
 * A client sends every listed tool's description and schema to the model on every turn, whether
 * or not the tool is used, so a long list is paid for up front. Lean mode keeps that cost small
 * without taking anything away: `strabo_more` lists, describes, and runs the rest on demand, and
 * every tool still runs through the implementation the full list uses.
 *
 * What a tool returns is paid for too, and stays in the context for the rest of the session, so
 * lean results are compact JSON with smaller pages. A list that gets cut still says so, and
 * `limit` and `offset` reach the rest.
 */
import { TOOL_ALIASES, type McpTool, type McpToolResult } from './tools.ts';

export type McpToolExposure = 'full' | 'lean';

export const MCP_GATEWAY_TOOL = 'strabo_more';

/** Items per list unless a call asks otherwise; the full list's 50 costs too much per call. */
export const LEAN_DEFAULT_PAGE = 20;

/** Longest summary in the `strabo_more` catalog, which is read once but stays in the context. */
const CATALOG_SUMMARY_CHARS = 160;

/** Arguments every tool shares, which the catalog leaves out. */
const SHARED_ARGUMENTS = new Set(['repository', 'limit', 'offset']);

/** The listed tools. A shorter description here; `strabo_more` serves the full one and schema. */
const LEAN_DESCRIPTIONS: ReadonlyArray<{ name: string; description: string }> = [
  { name: 'strabo_passport', description: 'Repository overview: languages, size, entry points, hubs, cycles, untested modules.' },
  { name: 'strabo_file', description: 'One file: importers, imports with evidence lines, complexity, signals, tier, unit.' },
  { name: 'strabo_impact', description: 'Who the pending change, or the revision `base`, affects, with tier and unit per file.' },
  { name: 'strabo_review', description: 'The pending change set, one risk row per file. `paths` narrows it; `detail: "full"` expands it.' },
  { name: 'strabo_path', description: 'The shortest recorded import path between two files, hop by hop.' },
];

/** `lean`, `full`, or nothing for the default, which is lean; null for anything else. */
export function parseToolExposure(value: string | undefined): McpToolExposure | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'lean') return 'lean';
  return normalized === 'full' ? 'full' : null;
}

/** The schema without its prose. Names, types, enums, and required fields stay, so calls still validate. */
function withoutDescriptions(schema: Record<string, unknown>): Record<string, unknown> {
  const { description: _description, ...rest } = schema;
  const lean: Record<string, unknown> = { ...rest };
  if (typeof rest.properties === 'object' && rest.properties !== null) {
    lean.properties = Object.fromEntries(
      Object.entries(rest.properties as Record<string, Record<string, unknown>>).map(([name, property]) => [
        name,
        withoutDescriptions(property),
      ]),
    );
  }
  if (typeof rest.items === 'object' && rest.items !== null) {
    lean.items = withoutDescriptions(rest.items as Record<string, unknown>);
  }
  return lean;
}

function textResult(value: unknown, isError = false): McpToolResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function firstSentence(text: string): string {
  return /^.*?[.:](?=\s|$)/.exec(text)?.[0] ?? text;
}

function summaryOf(tool: McpTool): string {
  const sentence = firstSentence(tool.description);
  if (sentence.length <= CATALOG_SUMMARY_CHARS) {
    return sentence;
  }
  const cut = sentence.slice(0, CATALOG_SUMMARY_CHARS - 1);
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

/** What each tool does and takes, so most calls need no `describe` first. */
function catalogEntry(tool: McpTool): Record<string, unknown> {
  const required = (tool.inputSchema.required ?? []) as string[];
  const optional = Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>).filter(
    (name) => !SHARED_ARGUMENTS.has(name) && !required.includes(name),
  );
  return {
    name: tool.name,
    summary: summaryOf(tool),
    ...(required.length > 0 ? { required } : {}),
    ...(optional.length > 0 ? { optional } : {}),
  };
}

function compactText(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

/** Run a tool the lean way: the smaller page unless the call names one, and compact JSON back. */
async function callLean(tool: McpTool, args: Record<string, unknown>): Promise<McpToolResult> {
  const result = await tool.call({ limit: LEAN_DEFAULT_PAGE, ...args });
  return {
    ...result,
    content: result.content.map((part) => ({ ...part, text: compactText(part.text) })),
  };
}

/** Narrow the full list. `all` is what `createTools` returns; each listed tool keeps its own `call`. */
export function createLeanTools(all: readonly McpTool[]): McpTool[] {
  const byName = new Map(all.map((tool) => [tool.name, tool]));
  const listed = LEAN_DESCRIPTIONS.map(({ name, description }): McpTool => {
    const tool = byName.get(name);
    if (!tool) {
      throw new Error(`Lean MCP tool "${name}" names an unknown tool.`);
    }
    return {
      ...tool,
      description,
      inputSchema: withoutDescriptions(tool.inputSchema),
      call: (args) => callLean(tool, args),
    };
  });

  // An alias repeats its target, and the targets of the listed aliases are already reachable.
  const leanNames = new Set(listed.map((tool) => tool.name));
  const covered = new Set(TOOL_ALIASES.filter(({ name }) => leanNames.has(name)).map(({ target }) => target));
  const aliasNames = new Set(TOOL_ALIASES.map(({ name }) => name));
  const others = all.filter((tool) => !aliasNames.has(tool.name) && !covered.has(tool.name));

  const gateway: McpTool = {
    name: MCP_GATEWAY_TOOL,
    description:
      `Strabo's other tools. No arguments: what each one does. \`describe\`: one tool's full description and schema. \`tool\` with \`arguments\`: run it. Tools: ${others.map((tool) => tool.name).join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string' },
        arguments: { type: 'object' },
        describe: { type: 'string' },
      },
      additionalProperties: false,
    },
    call: async (args) => {
      const requested = args.describe ?? args.tool;
      if (requested === undefined) {
        return textResult(others.map(catalogEntry));
      }
      const tool = typeof requested === 'string' ? byName.get(requested) : undefined;
      if (!tool) {
        return textResult(
          `Unknown tool: ${String(requested)}. Call ${MCP_GATEWAY_TOOL} with no arguments to list them.`,
          true,
        );
      }
      if (args.describe !== undefined) {
        return textResult({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
      }
      const toolArguments = args.arguments;
      return callLean(
        tool,
        typeof toolArguments === 'object' && toolArguments !== null
          ? (toolArguments as Record<string, unknown>)
          : {},
      );
    },
  };
  return [...listed, gateway];
}
