import type { Graph } from '../types.ts';
import { buildAdjacency } from './analysis.ts';

export interface TestReachDetail {
  test: string;
  depth: number;
  path: string[];
  direct: boolean;
}

export interface TestReachResult {
  testFiles: string[];
  reached: string[];
  unreachedWithDependents: string[];
  /** Non-test files directly imported by at least one test. */
  direct: string[];
  /** Non-test files reached only transitively (depth >= 2, no test directly imports). */
  transitive: string[];
  /** Non-test files reached only through 3 or more hops. */
  deepTransitive: string[];
  /** Minimum hop distance from any test (0 for test itself, 1 for direct, 2+ for transitive). */
  minDepthByFile: Record<string, number>;
  /** Shortest path from a test to each reached file. */
  shortestPaths: Record<string, string[]>;
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
const byFileDetailedCache = new WeakMap<Graph, Map<string, TestReachDetail[]>>();
const coverageResultCache = new WeakMap<Graph, TestReachResult>();

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
 * Map each file to detailed reach information from tests: hop depth, shortest path, and
 * directness.
 *
 * Direct tests (depth 1) come first, followed by ascending hop depth, with test name as
 * the deterministic tie-breaker.
 */
export function computeDetailedTestReachByFile(graph: Graph): Map<string, TestReachDetail[]> {
  const cached = byFileDetailedCache.get(graph);
  if (cached) {
    return cached;
  }
  const { testFiles, forward } = closureFromTests(graph);
  const byFileDetailed = new Map<string, TestReachDetail[]>();

  for (const testFile of testFiles) {
    const seen = new Set<string>([testFile]);
    const queue: Array<{ node: string; path: string[] }> = [{ node: testFile, path: [testFile] }];
    let head = 0;
    while (head < queue.length) {
      const current = queue[head++]!;
      const depth = current.path.length - 1;
      const isDirect = depth === 1 || (depth === 0 && current.node === testFile);
      const detail: TestReachDetail = {
        test: testFile,
        depth,
        path: current.path,
        direct: isDirect,
      };
      const list = byFileDetailed.get(current.node);
      if (list) {
        list.push(detail);
      } else {
        byFileDetailed.set(current.node, [detail]);
      }
      for (const dep of forward.get(current.node) ?? []) {
        if (!seen.has(dep)) {
          seen.add(dep);
          queue.push({ node: dep, path: [...current.path, dep] });
        }
      }
    }
  }

  for (const list of byFileDetailed.values()) {
    list.sort((a, b) => {
      if (a.direct !== b.direct) {
        return a.direct ? -1 : 1;
      }
      if (a.depth !== b.depth) {
        return a.depth - b.depth;
      }
      return a.test.localeCompare(b.test);
    });
  }

  byFileDetailedCache.set(graph, byFileDetailed);
  return byFileDetailed;
}

/**
 * Follow forward edges from files identified as tests and highlight modules with no
 * known path from a test.
 *
 * This measures graph reachability, recording depth (direct vs transitive) and shortest
 * paths.
 */
export function computeCoverage(graph: Graph): TestReachResult {
  const cached = coverageResultCache.get(graph);
  if (cached) {
    return cached;
  }
  const { testFiles, reached, backward } = closureFromTests(graph);
  const testSet = new Set(testFiles);
  const detailed = computeDetailedTestReachByFile(graph);

  const direct: string[] = [];
  const transitive: string[] = [];
  const deepTransitive: string[] = [];
  const minDepthByFile: Record<string, number> = {};
  const shortestPaths: Record<string, string[]> = {};

  for (const file of reached) {
    if (testSet.has(file)) {
      continue;
    }
    const details = detailed.get(file) ?? [];
    const minDepth = details.length > 0 ? details[0]!.depth : 0;
    minDepthByFile[file] = minDepth;
    shortestPaths[file] = details.length > 0 ? details[0]!.path : [file];

    const hasDirect = details.some((d) => d.depth === 1);
    if (hasDirect) {
      direct.push(file);
    } else {
      transitive.push(file);
    }
    if (minDepth >= 3) {
      deepTransitive.push(file);
    }
  }

  direct.sort();
  transitive.sort();
  deepTransitive.sort();

  // Modules that something depends on but that no test reaches: used-but-untested code.
  // An unreached module with no dependents is an orphan, not an untested dependency.
  const unreachedWithDependents =
    testFiles.length === 0
      ? []
      : graph.nodes
          .filter((node) => !testSet.has(node.id) && !reached.has(node.id))
          .filter((node) => (backward.get(node.id) ?? []).length > 0)
          .map((node) => node.id)
          .sort();

  const result: TestReachResult = {
    testFiles: [...testFiles].sort(),
    reached: [...reached].filter((id) => !testSet.has(id)).sort(),
    unreachedWithDependents,
    direct,
    transitive,
    deepTransitive,
    minDepthByFile,
    shortestPaths,
  };

  coverageResultCache.set(graph, result);
  return result;
}

/**
 * Every file a test reaches, test files included: the membership set the map and the
 * summaries check. Defined once so the union cannot drift between call sites.
 */
export function reachedFiles(result: Pick<TestReachResult, 'testFiles' | 'reached'>): Set<string> {
  return new Set([...result.reached, ...result.testFiles]);
}

/**
 * Map each file to the test files whose forward closure reaches it: the tests to run.
 *
 * Ordered direct tests first, then by ascending hop distance, with alphabetical tie-breaker.
 * A test file maps to itself, so changing a test lists it.
 */
export function computeTestReachByFile(graph: Graph): Map<string, string[]> {
  const cached = byFileCache.get(graph);
  if (cached) {
    // Shared read-only: callers must not mutate the map or its arrays. Every caller only
    // reads `get`/`has`, so one copy suffices for the whole graph's lifetime.
    return cached;
  }
  const detailed = computeDetailedTestReachByFile(graph);
  const byFile = new Map<string, string[]>();
  for (const [file, details] of detailed) {
    byFile.set(file, details.map((d) => d.test));
  }
  byFileCache.set(graph, byFile);
  return byFile;
}
