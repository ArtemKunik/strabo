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

/**
 * Map each file to the test files whose forward closure reaches it: the tests to run.
 *
 * The same reachability as `computeCoverage`, kept per test so a change can name the tests
 * that cover it rather than a boolean. A test file maps to itself, so changing a test lists it.
 */
export function computeTestReachByFile(graph: Graph): Map<string, string[]> {
  const { forward } = buildAdjacency(graph);
  const testFiles = graph.nodes.filter((node) => node.kind === 'test').map((node) => node.id);
  const byFile = new Map<string, string[]>();

  for (const testFile of testFiles) {
    const seen = new Set<string>([testFile]);
    const stack = [testFile];
    while (stack.length > 0) {
      const next = stack.pop() as string;
      const list = byFile.get(next) ?? [];
      if (!list.includes(testFile)) {
        list.push(testFile);
      }
      byFile.set(next, list);
      for (const dependency of forward.get(next) ?? []) {
        if (!seen.has(dependency)) {
          seen.add(dependency);
          stack.push(dependency);
        }
      }
    }
  }

  for (const list of byFile.values()) {
    list.sort();
  }
  return byFile;
}
