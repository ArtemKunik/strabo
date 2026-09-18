import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Graph } from '../types.ts';
import { buildAdjacency } from './analysis.ts';

const run = promisify(execFile);

export interface ChangedFile {
  path: string;
  status: string;
}

export interface ImpactResult {
  changed: ChangedFile[];
  affected: Array<{ id: string; distance: number }>;
  outsideGraph: string[];
}

/** Read local changes, and optionally a base-ref diff, from Git. */
export async function getChangedFiles(root: string, baseRef?: string): Promise<ChangedFile[]> {
  const args = baseRef
    ? ['diff', '--name-status', baseRef]
    : ['status', '--porcelain'];
  try {
    const { stdout } = await run('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [status = '?', ...rest] = line.split(/\s+/);
        return { status, path: rest.join(' ') };
      });
  } catch {
    return [];
  }
}

/**
 * Combine Git changes with reverse dependency traversal and report affected files and
 * their distance from the change. This is potential impact, not proof of breakage.
 */
export async function computeImpact(
  root: string,
  graph: Graph,
  baseRef?: string,
): Promise<ImpactResult> {
  const changed = await getChangedFiles(root, baseRef);
  const { affected, outsideGraph } = impactFromPaths(
    graph,
    changed.map((change) => change.path),
  );
  return { changed, affected, outsideGraph };
}

/**
 * Reverse-reachability impact for an explicit set of changed paths.
 *
 * Kept separate from Git so the review workflow can reuse the exact traversal the
 * change-impact overlay uses, rather than reimplementing distance semantics.
 */
export function impactFromPaths(
  graph: Graph,
  paths: readonly string[],
): Pick<ImpactResult, 'affected' | 'outsideGraph'> {
  const { backward } = buildAdjacency(graph);
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const affected = new Map<string, number>();
  const outsideGraph: string[] = [];

  for (const path of paths) {
    if (nodeIds.has(path)) {
      affected.set(path, 0);
    } else {
      outsideGraph.push(path);
    }
  }

  let frontier = [...affected.keys()];
  let distance = 0;
  while (frontier.length > 0 && distance < 50) {
    distance += 1;
    const next: string[] = [];
    for (const id of frontier) {
      for (const dependent of backward.get(id) ?? []) {
        if (!affected.has(dependent)) {
          affected.set(dependent, distance);
          next.push(dependent);
        }
      }
    }
    frontier = next;
  }

  return {
    affected: [...affected.entries()]
      .map(([id, hop]) => ({ id, distance: hop }))
      .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id)),
    outsideGraph: [...new Set(outsideGraph)].sort(),
  };
}
