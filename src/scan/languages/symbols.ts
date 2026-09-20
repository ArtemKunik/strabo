import type { Node } from 'web-tree-sitter';

import type { Diagnostic } from '../../types.ts';

/**
 * A declared member of a file, in the common shape every language extractor produces.
 *
 * `visibility` is the language's effective default when no modifier is present (Java
 * `package`, Rust `private`, C# `private`, Kotlin `public`).
 */
export type CodeSymbolKind = 'field' | 'method' | 'property' | 'type';

export interface CodeSymbol {
  name: string;
  kind: CodeSymbolKind;
  visibility: string;
  /** Enclosing type (`Outer.Inner`), or empty for a top-level member. */
  owner: string;
  type?: string;
  mutable?: boolean;
  parameters?: number;
  line: number;
  /** Body measurements for a function or method; absent for data members and signatures. */
  metrics?: FunctionMetrics;
}

/**
 * Deterministic measurements of one function body, counted from the parse tree.
 *
 * These are signals, not verdicts: `decisionPoints` is a cyclomatic-complexity proxy and
 * `statementCount` a language-specific approximation. A function whose body the extractor
 * could not read carries no `metrics` rather than a fabricated zero.
 */
export interface FunctionMetrics {
  /** 1-based line of the end of the body. */
  endLine: number;
  /** Declaration line through the end of the body, inclusive. */
  lines: number;
  /** Named body statements; an approximation, not a token count. */
  statementCount: number;
  /** Cyclomatic-complexity proxy: starts at 1 and adds one per branching site. */
  decisionPoints: number;
  /** Deepest nesting of block control-flow constructs inside the body. */
  maxNestingDepth: number;
  /** Loop constructs in the body. */
  loops: number;
}

/**
 * A recorded call from inside a function body.
 *
 * Only calls the scan can prove are recorded: an intra-file `this.x()` / `self.x()` /
 * `Type.x()` or a bare `x()` whose name resolves to a function declared in the same file.
 * Cross-file and dynamic calls are not claimed.
 */
export interface FunctionCall {
  /** The called name as authored. */
  callee: string;
  /** Enclosing type of the caller, or empty for a module function. */
  owner: string;
  /** Name of the calling function. */
  method: string;
  kind: 'bare' | 'self' | 'type-qualified';
  line: number;
}

/**
 * A reference to a field from inside a method body.
 *
 * Only references the scan can prove are recorded: an explicit `this.x` / `self.x`, or a
 * bare name that matches a field of the same type and is not shadowed by a parameter or
 * local. `qualified` distinguishes the two so callers can weigh the evidence.
 */
export interface MemberAccess {
  field: string;
  owner: string;
  method: string;
  mode: 'read' | 'write';
  qualified: boolean;
  line: number;
}

export interface SymbolExtraction {
  symbols: CodeSymbol[];
  diagnostics: Diagnostic[];
  /** Field references recorded in method bodies; empty when the language records none. */
  accesses?: MemberAccess[];
  /** Intra-file calls recorded in method bodies; empty when the language records none. */
  calls?: FunctionCall[];
}

/** Language-specific node rules used to find field references in a method body. */
export interface AccessRules {
  /** Node types that carry a bare identifier (e.g. `identifier`, `simple_identifier`). */
  identifierTypes: Set<string>;
  /** Assignment and increment node types that make a reference a write. */
  assignmentTypes: Set<string>;
  /** Detect an explicit `this.x` / `self.x`, returning the field name and its node. */
  selfAccess: (node: Node) => { field: string; fieldNode: Node } | null;
  /** Names declared inside the body (parameters, locals) that shadow a field. */
  declaredNames: (body: Node) => Set<string>;
}

export function sortSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
  return symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

/** Depth-first walk over named children, including `node`. */
export function walkNodes(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const child of node.namedChildren) {
    walkNodes(child, visit);
  }
}

/**
 * Collect the field references inside one method body.
 *
 * A field is recorded once per mode, so a method that reads and writes the same field
 * reports both. Bare references are dropped when a parameter or local shadows the name
 * (parameters live outside the body, so `scope` - the whole method - is searched for
 * declarations), and the field identifier of a `this.x` access is not double-counted.
 */
export function collectMemberAccesses(
  body: Node,
  fields: Set<string>,
  owner: string,
  method: string,
  rules: AccessRules,
  scope: Node = body,
): MemberAccess[] {
  if (fields.size === 0) {
    return [];
  }
  const declared = rules.declaredNames(scope);
  const accesses: MemberAccess[] = [];
  const seen = new Set<string>();

  const record = (field: string, node: Node, qualified: boolean): void => {
    const mode: MemberAccess['mode'] = isWriteTarget(node, body, rules.assignmentTypes)
      ? 'write'
      : 'read';
    const key = `${field}\u0000${mode}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    accesses.push({ field, owner, method, mode, qualified, line: node.startPosition.row + 1 });
  };

  walkNodes(body, (node) => {
    const self = rules.selfAccess(node);
    if (self && fields.has(self.field)) {
      record(self.field, self.fieldNode, true);
    }
    if (!rules.identifierTypes.has(node.type) || !fields.has(node.text) || declared.has(node.text)) {
      return;
    }
    const parentSelf = node.parent ? rules.selfAccess(node.parent) : null;
    if (parentSelf && parentSelf.fieldNode.startIndex === node.startIndex) {
      return;
    }
    record(node.text, node, false);
  });

  return accesses;
}

/**
 * Whether a field reference sits on the receiving side of an assignment or increment.
 *
 * Walks up to the method body; an assignment only counts when the reference is inside its
 * `left` (or `argument`, for `x++`) subtree, so `x = y` writes `x` and reads `y`.
 */
function isWriteTarget(node: Node, body: Node, assignmentTypes: Set<string>): boolean {
  let current: Node | null = node;
  while (current && current.id !== body.id) {
    if (assignmentTypes.has(current.type)) {
      const target =
        current.childForFieldName('left') ??
        current.childForFieldName('argument') ??
        current.namedChildren[0];
      if (target && node.startIndex >= target.startIndex && node.endIndex <= target.endIndex) {
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

/** Collect the identifier names bound by a list of declaration nodes. */
export function collectDeclaredIdentifiers(
  body: Node,
  isDeclaration: (node: Node) => string | null,
): Set<string> {
  const names = new Set<string>();
  walkNodes(body, (node) => {
    const name = isDeclaration(node);
    if (name) {
      names.add(name);
    }
  });
  return names;
}
