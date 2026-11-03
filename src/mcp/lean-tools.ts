/**
 * The lean tool list: the everyday tools, plus one tool that reaches all the others.
 *
 * A client sends every listed tool's description and schema to the model on every turn, whether
 * or not the tool is used, so a long list is paid for up front. Lean mode keeps that cost small
 * without taking anything away: `strabo_more` lists, describes, and runs the rest on demand, and
 * every tool still runs through the implementation the full list uses.
 */
import { TOOL_ALIASES, type McpTool, type McpToolResult } from './tools.ts';

export type McpToolExposure = 'full' | 'lean';

export const MCP_GATEWAY_TOOL = 'strabo_more';

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

/** Narrow the full list. `all` is what `createTools` returns; each listed tool keeps its own `call`. */
export function createLeanTools(all: readonly McpTool[]): McpTool[] {
  const byName = new Map(all.map((tool) => [tool.name, tool]));
  const listed = LEAN_DESCRIPTIONS.map(({ name, description }): McpTool => {
    const tool = byName.get(name);
    if (!tool) {
      throw new Error(`Lean MCP tool "${name}" names an unknown tool.`);
    }
    return { ...tool, description, inputSchema: withoutDescriptions(tool.inputSchema) };
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
        return textResult(
          others.map((tool) => ({ name: tool.name, summary: firstSentence(tool.description) })),
        );
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
      return tool.call(
        typeof toolArguments === 'object' && toolArguments !== null
          ? (toolArguments as Record<string, unknown>)
          : {},
      );
    },
  };
  return [...listed, gateway];
}
