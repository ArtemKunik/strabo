import type { Graph, StraboIntegrations, Unavailable } from '../types.ts';

export type LineageResponse =
  | { available: true; pack: string; graph: Graph }
  | Unavailable;

/**
 * Build a domain graph from an explicitly supplied lineage pack and its declared
 * repositories.
 *
 * Generic package startup must never activate domain documentation or scan sibling
 * projects. No pack means no domain lineage assertion.
 */
export async function getLineage(
  integrations: StraboIntegrations,
  graphs: Map<string, Graph>,
  serverLog?: (message: string, error?: unknown) => void,
): Promise<LineageResponse> {
  const pack = integrations.lineagePack;
  if (!pack) {
    return { available: false, reason: 'no-domain-pack' };
  }
  try {
    const graph = await pack.build(graphs);
    return { available: true, pack: pack.name, graph };
  } catch (error) {
    serverLog?.('lineage pack failed', error);
    return { available: false, reason: 'provider-error' };
  }
}
