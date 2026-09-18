import type { CatalogueFetcher, RepositoryDescriptor, StraboIntegrations } from '../types.ts';

/**
 * Enrich the repository catalogue.
 *
 * When absent, the local configured catalogue stays usable. A fetcher is never an
 * implicit default.
 */
export async function loadCatalogue(
  integrations: StraboIntegrations,
  root: string,
  serverLog?: (message: string, error?: unknown) => void,
): Promise<RepositoryDescriptor[]> {
  const local: RepositoryDescriptor[] = [
    { name: root.split(/[\\/]/).pop() ?? root, root, head: null, dirty: false, gitUrl: null },
  ];
  const fetcher: CatalogueFetcher | undefined = integrations.catalogueFetcher;
  if (!fetcher) {
    return local;
  }
  try {
    const remote = await fetcher(root);
    return merge(local, remote);
  } catch (error) {
    serverLog?.('catalogue fetch failed; using local catalogue only', error);
    return local;
  }
}

function merge(
  local: RepositoryDescriptor[],
  remote: RepositoryDescriptor[],
): RepositoryDescriptor[] {
  const byRoot = new Map(local.map((entry) => [entry.root, entry]));
  for (const entry of remote) {
    byRoot.set(entry.root, entry);
  }
  return [...byRoot.values()];
}
