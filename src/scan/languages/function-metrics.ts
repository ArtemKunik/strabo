import type { Node } from 'web-tree-sitter';

import type { CodeSymbol, FunctionCall, FunctionMetrics } from './symbols.ts';

/**
 * Language-specific node rules used to measure one function body.
 *
 * Grammar node names differ per language, so each extractor supplies its own rule pack,
 * exactly as it supplies `AccessRules` for field references. Every metric is a deterministic
 * count over the parse tree, not an estimate from source text.
 */
export interface FunctionRules {
  /** Block constructs that nest the body; used only for `maxNestingDepth`. */
  controlFlowTypes: Set<string>;
  /** Loop constructs; a subset of `controlFlowTypes`. */
  loopTypes: Set<string>;
  /** Each node type here adds one decision point. */
  decisionNodeTypes: Set<string>;
  /** Binary operators that branch (`&&`, `||`, `??`). */
  decisionOperators: Set<string>;
  /** Nodes counted as one body statement. */
  statementTypes: Set<string>;
  /** Call node types, used to spot work performed inside a loop. */
  callTypes: Set<string>;
  /** The simple callee name of a call node, or null when it has none. */
  callTargetName: (node: Node) => string | null;
  /** Lower-cased callee names that are linear scans (`includes`, `indexof`, `contains`). */
  linearScanCalls: Set<string>;
  /** Lower-cased callee names that sort (`sort`, `sorted`, `orderby`). */
  sortCalls: Set<string>;
  /**
   * Nested function-like nodes whose bodies are measured as their own function.
   *
   * The walk does not descend into these, so an inline callback does not inflate the
   * enclosing function's metrics; when the extractor emits the nested function as its own
   * symbol, it is measured there instead.
   */
  nestedFunctionTypes: Set<string>;
}

/**
 * Measure one function body from its parse tree.
 *
 * `decisionPoints` is a cyclomatic-complexity proxy: it starts at 1 and adds one per
 * branching construct, so a straight-line function scores 1. `statementCount` is a
 * language-specific approximation of body statements, not a token count. `lines` spans the
 * declaration line through the end of the body.
 */
export function collectFunctionMetrics(
  body: Node,
  startLine: number,
  rules: FunctionRules,
): FunctionMetrics {
  let statementCount = 0;
  let decisionPoints = 1;
  let maxNestingDepth = 0;
  let loopNestingDepth = 0;
  let loops = 0;
  const loopScans = new Set<string>();
  const loopSorts = new Set<string>();

  const visit = (node: Node, depth: number, loopDepth: number): void => {
    if (rules.nestedFunctionTypes.has(node.type)) {
      return;
    }
    const control = rules.controlFlowTypes.has(node.type);
    const nextDepth = control ? depth + 1 : depth;
    if (control) {
      maxNestingDepth = Math.max(maxNestingDepth, nextDepth);
    }
    const loop = rules.loopTypes.has(node.type);
    const nextLoopDepth = loop ? loopDepth + 1 : loopDepth;
    if (loop) {
      loops += 1;
      loopNestingDepth = Math.max(loopNestingDepth, nextLoopDepth);
    }
    if (rules.decisionNodeTypes.has(node.type)) {
      decisionPoints += 1;
    }
    if (rules.statementTypes.has(node.type)) {
      statementCount += 1;
    }
    if (hasDecisionOperator(node, rules)) {
      decisionPoints += 1;
    }
    if (loopDepth >= 1 && rules.callTypes.has(node.type)) {
      const name = rules.callTargetName(node);
      if (name) {
        const lower = name.toLowerCase();
        if (rules.linearScanCalls.has(lower)) {
          loopScans.add(name);
        } else if (rules.sortCalls.has(lower)) {
          loopSorts.add(name);
        }
      }
    }
    for (const child of node.namedChildren) {
      visit(child, nextDepth, nextLoopDepth);
    }
  };

  // Start at the body's own children so the body node is not itself counted as a construct.
  for (const child of body.namedChildren) {
    visit(child, 0, 0);
  }

  const endLine = body.endPosition.row + 1;
  return {
    endLine,
    lines: Math.max(1, endLine - startLine + 1),
    statementCount,
    decisionPoints,
    maxNestingDepth,
    loopNestingDepth,
    loops,
    loopScans: [...loopScans].sort(),
    loopSorts: [...loopSorts].sort(),
    recursive: false,
  };
}

/** A syntactic hint that a receiver names a type rather than a value (leading capital). */
export function looksLikeTypeName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/** True when a recorded call is the function calling itself. */
export function isRecursiveCall(call: FunctionCall): boolean {
  if (call.callee !== call.method) {
    return false;
  }
  return call.kind === 'bare' || call.targetOwner === call.owner;
}

/** Set `metrics.recursive` on each function whose body calls itself. */
export function markRecursive(symbols: CodeSymbol[], calls: FunctionCall[]): void {
  for (const call of calls) {
    if (!isRecursiveCall(call)) {
      continue;
    }
    const symbol = symbols.find(
      (candidate) =>
        candidate.kind === 'method' &&
        candidate.owner === call.owner &&
        candidate.name === call.method,
    );
    if (symbol?.metrics) {
      symbol.metrics.recursive = true;
    }
  }
}

/** True when a node carries a branching binary operator as a direct token. */
function hasDecisionOperator(node: Node, rules: FunctionRules): boolean {
  if (rules.decisionOperators.size === 0) {
    return false;
  }
  const operator = node.childForFieldName('operator');
  if (operator && rules.decisionOperators.has(operator.text)) {
    return true;
  }
  return node.children.some((child) => !child.isNamed && rules.decisionOperators.has(child.type));
}
