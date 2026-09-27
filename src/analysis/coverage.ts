import type { Graph } from '../types.ts';
import { buildAdjacency } from './analysis.ts';

export interface TestReachResult {
  testFiles: string[];
  reached: string[];
  unreachedWithDependents: string[];
}

interface TestClosure {
  testFiles: string[];
  reached: Set<string>;
  forward: Map<string, string[]>;
  backward: Map<string, string[]>;
}

// A graph is built once by the scan and never mutated afterwards, and the graph cache reuses
// the same object across requests. Reachability is therefore a per-graph constant, cached by
// identity: the closure (one BFS) is shared by both public functions, and the per-test map
// (one BFS per test) is not recomputed on every request that opens a file or a summary. A
// revision graph or a test-local graph gets its own entry and is collected with the graph.
const closureCache = new WeakMap<Graph, TestClosure>();
const byFileCache = new WeakMap<Graph, Map<string, string[]>>();

/**
 * The forward closure from every test file: the adjacency, the test set, and every file a
 * test reaches (test files included).
 *
 * One traversal shared by {@link computeCoverage} and {@link computeTestReachByFile}, so the
 * boolean reach and the per-file test list can never disagree about the same file.
 */
function closureFromTests(graph: Graph): TestClosure {
  const cached = closureCache.get(graph);
  if (cached) {
    return cached;
  }
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
  const closure = { testFiles, reached, forward, backward };
  closureCache.set(graph, closure);
  return closure;
}

/**
 * Follow forward edges from files identified as tests and highlight modules with no
 * known path from a test.
 *
 * This measures graph reachability, not executed line or branch coverage.
 */
export function computeCoverage(graph: Graph): TestReachResult {
  const { testFiles, reached, backward } = closureFromTests(graph);
  const testSet = new Set(testFiles);
  // Modules that something depends on but that no test reaches: used-but-untested code.
  // An unreached module with no dependents is an orphan, not an untested dependency.
  //
  // With no test file at all, "unreached" cannot be derived: every used file would qualify,
  // which would dash the whole map as if it were the finding. Callers report the missing
  // tests separately, so the list is empty rather than a blanket verdict.
  const unreachedWithDependents =
    testFiles.length === 0
      ? []
      : graph.nodes
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
 * Every file a test reaches, test files included: the membership set the map and the
 * summaries check. Defined once so the union cannot drift between call sites.
 */
export function reachedFiles(result: TestReachResult): Set<string> {
  return new Set([...result.reached, ...result.testFiles]);
}

/**
 * Map each file to the test files whose forward closure reaches it: the tests to run.
 *
 * The same reachability as `computeCoverage`, kept per test so a change can name the tests
 * that cover it rather than a boolean. A test file maps to itself, so changing a test lists it.
 */
export function computeTestReachByFile(graph: Graph): Map<string, string[]> {
  const cached = byFileCache.get(graph);
  if (cached) {
    // Shared read-only: callers must not mutate the map or its arrays. Every caller only
    // reads `get`/`has`, so one copy suffices for the whole graph's lifetime.
    return cached;
  }
  const { testFiles, forward } = closureFromTests(graph);
  const byFile = new Map<string, string[]>();

  for (const testFile of testFiles) {
    const seen = new Set<string>([testFile]);
    const stack = [testFile];
    while (stack.length > 0) {
      const next = stack.pop() as string;
      // `next` is popped at most once per test (the `seen` guard admits each dependency
      // once), so this test is never already listed against this file: a membership scan
      // would be dead work, and the old `list.includes` made this O(tests x files).
      const list = byFile.get(next);
      if (list) {
        list.push(testFile);
      } else {
        byFile.set(next, [testFile]);
      }
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
  byFileCache.set(graph, byFile);
  return byFile;
}
