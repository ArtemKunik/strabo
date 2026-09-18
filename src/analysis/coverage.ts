import type { Graph } from '../types.ts';
import { buildAdjacency } from './analysis.ts';

export interface TestReachResult {
  testFiles: string[];
  reached: string[];
  unreachedWithDependents: string[];
}

/**
 * Follow forward edges from files identified as tests and highlight modules with no
 * known path from a test.
 *
 * This measures graph reachability, not executed line or branch coverage.
 */
export function computeCoverage(graph: Graph): TestReachResult {
  const { forward, backward } = buildAdjacency(graph);
  const testFiles = graph.nodes.filter((node) => node.kind === 'test').map((node) => node.id);
  const reached = new Set<string>();
  const stack = [...testFiles];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (reached.has(next)) {
      continue;
    }
    reached.add(next);
    for (const dependency of forward.get(next) ?? []) {
      if (!reached.has(dependency)) {
        stack.push(dependency);
      }
    }
  }

  const testSet = new Set(testFiles);
  // Modules that something depends on but that no test reaches: used-but-untested code.
  // An unreached module with no dependents is an orphan, not an untested dependency.
  const unreachedWithDependents = graph.nodes
    .filter((node) => !testSet.has(node.id) && !reached.has(node.id))
    .filter((node) => (backward.get(node.id) ?? []).length > 0)
    .map((node) => node.id)
    .sort();

  return {
    testFiles: [...testFiles].sort(),
    reached: [...reached].filter((id) => !testSet.has(id)).sort(),
    unreachedWithDependents,
  };
}
