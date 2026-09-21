import readline from 'node:readline';

import { createApiDispatch } from '../api/dispatch.ts';
import type { StraboConfig } from '../types.ts';
import { createTools, type McpTool } from './tools.ts';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const MCP_SERVER_NAME = 'strabo';

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface McpHandler {
  handle: (message: unknown) => Promise<unknown | null>;
}

export function createMcpHandler(config: StraboConfig, tools?: McpTool[]): McpHandler {
  const registry = tools ?? createTools(createApiDispatch(config));
  const byName = new Map(registry.map((tool) => [tool.name, tool]));

  return {
    async handle(message: unknown): Promise<unknown | null> {
      if (typeof message !== 'object' || message === null) {
        return errorResponse(null, -32600, 'Invalid Request');
      }
      const request = message as JsonRpcRequest;
      const id = request.id ?? null;
      if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        return errorResponse(id, -32600, 'Invalid Request');
      }
      const params = (typeof request.params === 'object' && request.params !== null
        ? request.params
        : {}) as Record<string, unknown>;

      switch (request.method) {
        case 'initialize':
          return resultResponse(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: MCP_SERVER_NAME, version: '0.0.0' },
          });
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null;
        case 'ping':
          return resultResponse(id, {});
        case 'tools/list':
          return resultResponse(id, {
            tools: registry.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          });
        case 'tools/call':
          return callTool(id, params, byName);
        default:
          return errorResponse(id, -32601, `Method not found: ${request.method}`);
      }
    },
  };
}

async function callTool(
  id: unknown,
  params: Record<string, unknown>,
  byName: Map<string, McpTool>,
): Promise<unknown> {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = byName.get(name);
  if (!tool) {
    return errorResponse(id, -32602, `Unknown tool: ${name || '(missing name)'}`);
  }
  const args = (typeof params.arguments === 'object' && params.arguments !== null
    ? params.arguments
    : {}) as Record<string, unknown>;
  try {
    const result = await tool.call(args);
    return resultResponse(id, result);
  } catch (error) {
    return resultResponse(id, {
      content: [{ type: 'text', text: error instanceof Error ? error.message : 'Tool failed.' }],
      isError: true,
    });
  }
}

function resultResponse(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function startMcpServer(config: StraboConfig): void {
  const handler = createMcpHandler(config);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  input.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      process.stderr.write('[strabo] mcp: ignoring a line that is not JSON\n');
      return;
    }
    void handler
      .handle(message)
      .then((response) => {
        if (response !== null) {
          process.stdout.write(`${JSON.stringify(response)}\n`);
        }
      })
      .catch((error: unknown) => {
        process.stderr.write(
          `[strabo] mcp: ${error instanceof Error ? error.message : 'request failed'}\n`,
        );
      });
  });
}
