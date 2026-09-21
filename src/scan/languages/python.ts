import type { Node } from 'web-tree-sitter';

import type { Diagnostic, EdgeEvidence, GraphEdge } from '../../types.ts';
import { collectFunctionMetrics, markRecursive, type FunctionRules } from './function-metrics.ts';
import { addNamespacePrefixes, looksInternal } from './namespace.ts';
import type { GrammarLanguage } from './parser-runtime.ts';
import { withParser } from './parser-runtime.ts';
import {
  type AccessRules,
  type CallRules,
  type CodeSymbol,
  type MemberAccess,
  type SymbolExtraction,
  collectDeclaredIdentifiers,
  collectFunctionCalls,
  collectMemberAccesses,
  sortSymbols,
} from './symbols.ts';

export const PYTHON_LANGUAGE: GrammarLanguage = 'python';

/** One `import` or `from ... import ...` statement. */
export interface PythonImport {
  /**
   * The module path as authored, without leading dots. Empty for `from . import x`, where
   * the package itself is the module.
   */
  module: string;
  /** Names taken from the module (`from x import a, b`); empty for a plain `import x`. */
  names: string[];
  wildcard: boolean;
  /** Leading-dot count of a relative import; 0 when the import is absolute. */
  relativeDepth: number;
  /** The statement as authored, used as edge evidence. */
  specifier: string;
  line: number;
}

export interface PythonFileFacts {
  file: string;
  imports: PythonImport[];
}

export interface PythonExtraction {
  facts: PythonFileFacts;
  diagnostics: Diagnostic[];
}

export interface PythonResolution {
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

/** Parse one Python file into the imports it declares. */
export async function extractPythonFacts(
  file: string,
  content: string,
): Promise<PythonExtraction> {
  return withParser(PYTHON_LANGUAGE, (parser) => {
    const diagnostics: Diagnostic[] = [];
    const facts: PythonFileFacts = { file, imports: [] };

    const tree = parser.parse(content);
    if (!tree) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'error',
        kind: 'parse-failure',
        message: 'Python parser returned no tree for this file.',
      });
      return { facts, diagnostics };
    }

    // Imports are collected from the whole tree, not just the module body: Python allows a
    // deferred import inside a function or an `if TYPE_CHECKING:` block, and those are real
    // dependencies.
    collectImports(tree.rootNode, facts.imports);

    if (tree.rootNode.hasError) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'warning',
        kind: 'parse-failure',
        message: 'Python source contains syntax errors; extracted facts may be incomplete.',
      });
    }

    return { facts, diagnostics };
  });
}

function collectImports(node: Node, imports: PythonImport[]): void {
  if (node.type === 'import_statement') {
    for (const child of node.namedChildren) {
      const module = importedModuleName(child);
      if (module) {
        imports.push({
          module,
          names: [],
          wildcard: false,
          relativeDepth: 0,
          specifier: module,
          line: node.startPosition.row + 1,
        });
      }
    }
    return;
  }

  if (node.type === 'import_from_statement') {
    collectFromImport(node, imports);
    return;
  }

  for (const child of node.namedChildren) {
    collectImports(child, imports);
  }
}

function collectFromImport(node: Node, imports: PythonImport[]): void {
  const source = node.childForFieldName('module_name');
  if (!source) {
    return;
  }

  let module = '';
  let relativeDepth = 0;
  if (source.type === 'relative_import') {
    // `import_prefix` is the run of dots; `..pkg` is depth 2 with module `pkg`.
    relativeDepth = source.namedChildren.find((child) => child.type === 'import_prefix')?.text.length ?? 0;
    module = source.namedChildren.find((child) => child.type === 'dotted_name')?.text ?? '';
  } else {
    module = source.text;
  }

  const names: string[] = [];
  let wildcard = false;
  for (const child of node.namedChildren) {
    // Compare by position: every node accessor returns a fresh wrapper, so `child === source`
    // would never match and the module would be collected as one of its own imported names.
    if (child.startIndex === source.startIndex) {
      continue;
    }
    if (child.type === 'wildcard_import') {
      wildcard = true;
      continue;
    }
    const name = importedModuleName(child);
    if (name) {
      names.push(name);
    }
  }

  imports.push({
    module,
    names,
    wildcard,
    relativeDepth,
    specifier: `${'.'.repeat(relativeDepth)}${module}`,
    line: node.startPosition.row + 1,
  });
}

/** The module path of an `import` clause, unwrapping `x as y` to `x`. */
function importedModuleName(node: Node): string | null {
  if (node.type === 'dotted_name') {
    return node.text;
  }
  if (node.type === 'aliased_import') {
    return node.childForFieldName('name')?.text ?? null;
  }
  if (node.type === 'identifier') {
    return node.text;
  }
  return null;
}

/**
 * Resolve Python imports to repository files.
 *
 * Python names a module by its path relative to a source root, so resolution needs the
 * roots before it needs the imports. A directory holding `__init__.py` is a package, and
 * the first directory above a package chain that is *not* itself a package is a source
 * root — which is how the interpreter reads the same tree. The repository root is always a
 * candidate too, so a flat script directory still resolves.
 *
 * A file therefore has one name per root it sits under (`src/app/db.py` is both
 * `app.db` and `src.app.db`), and every one of them is indexed: the import decides which
 * spelling is in use. Two different files claiming one module name is reported as
 * `ambiguous` rather than resolved to whichever was scanned first.
 */
export function resolvePython(facts: readonly PythonFileFacts[]): PythonResolution {
  const files = facts.map((entry) => entry.file);
  const roots = sourceRoots(files);

  const byModule = new Map<string, Set<string>>();
  const canonicalModule = new Map<string, string>();
  const namespaces = new Set<string>();

  for (const file of files) {
    const names = moduleNamesFor(file, roots);
    for (const name of names) {
      const claimants = byModule.get(name) ?? new Set<string>();
      byModule.set(name, claimants);
      claimants.add(file);
      addNamespacePrefixes(namespaces, name);
    }
    const canonical = shortestName(names);
    if (canonical !== null) {
      canonicalModule.set(file, canonical);
    }
  }

  const edges: GraphEdge[] = [];
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();

  const pushEdge = (
    source: string,
    target: string,
    line: number,
    specifier: string,
    resolution: EdgeEvidence['resolution'],
  ): void => {
    if (source === target) {
      return;
    }
    const key = `${source}\u0000${target}\u0000${line}\u0000${resolution}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    // A package's `__init__.py` re-exports its submodules and members; the edge declares the
    // package layout rather than depending on the target's contents.
    edges.push({
      source,
      target,
      kind: 'import',
      evidence: { line, specifier, resolution },
      role: isPackageInit(source) ? 'declare' : 'use',
    });
  };

  /** Resolve a module name to its one file, reporting an ambiguous claim instead of guessing. */
  const fileFor = (
    module: string,
    source: string,
    reference: PythonImport,
  ): string | null => {
    const claimants = byModule.get(module);
    if (!claimants || claimants.size === 0) {
      return null;
    }
    if (claimants.size > 1) {
      diagnostics.push({
        file: source,
        line: reference.line,
        severity: 'warning',
        kind: 'ambiguous',
        specifier: reference.specifier,
        message: `"${module}" is claimed by ${claimants.size} files (${[...claimants].sort().join(', ')}); no edge was drawn.`,
      });
      return null;
    }
    return [...claimants][0] ?? null;
  };

  for (const fileFacts of facts) {
    for (const reference of fileFacts.imports) {
      const base = absoluteModule(reference, canonicalModule.get(fileFacts.file) ?? '', fileFacts.file);
      if (base === null) {
        // A relative import that climbs past the source root cannot name a file here.
        diagnostics.push({
          file: fileFacts.file,
          line: reference.line,
          severity: 'warning',
          kind: 'unresolved',
          specifier: reference.specifier,
          message: `Relative import "${reference.specifier}" climbs above the source root; no edge was drawn.`,
        });
        continue;
      }

      let resolvedAny = false;

      // `from pkg import name` may name a submodule (`pkg/name.py`) or a member of the
      // package itself. Both are real dependencies, so both are drawn when both resolve.
      for (const name of reference.names) {
        const target = fileFor(base === '' ? name : `${base}.${name}`, fileFacts.file, reference);
        if (target) {
          pushEdge(fileFacts.file, target, reference.line, memberSpecifier(reference, name), 'module-tree');
          resolvedAny = true;
        }
      }

      if (base !== '') {
        const target = fileFor(base, fileFacts.file, reference);
        if (target) {
          pushEdge(fileFacts.file, target, reference.line, reference.specifier, 'exact');
          resolvedAny = true;
        }
      }

      if (resolvedAny || base === '') {
        continue;
      }
      // A single leading segment is enough evidence here: unlike a reverse-DNS JVM package,
      // a Python top-level package name is the whole claim (`app.missing` against `app/`).
      if (looksInternal(base, namespaces, 1)) {
        diagnostics.push({
          file: fileFacts.file,
          line: reference.line,
          severity: 'warning',
          kind: 'unresolved',
          specifier: reference.specifier,
          message: `"${reference.specifier}" looks internal but no repository module matched it.`,
        });
      }
    }
  }

  return { edges, diagnostics };
}

/**
 * How a `from X import name` reads as authored. `from . import helpers` is `.helpers`, not
 * `..helpers`, which would name a different package.
 */
function memberSpecifier(reference: PythonImport, name: string): string {
  return reference.specifier.endsWith('.')
    ? `${reference.specifier}${name}`
    : `${reference.specifier}.${name}`;
}

/**
 * Turn an import into an absolute module path.
 *
 * Depth 1 is the importing file's own package, depth 2 its parent, and so on. Null means
 * the import climbs above the source root, which names nothing in this repository.
 */
function absoluteModule(
  reference: PythonImport,
  canonical: string,
  file: string,
): string | null {
  if (reference.relativeDepth === 0) {
    return reference.module;
  }
  // A package's `__init__.py` *is* its package, so `.` resolves to itself rather than its parent.
  const ownPackage = isPackageInit(file)
    ? canonical
    : canonical.slice(0, Math.max(0, canonical.lastIndexOf('.')));
  const segments = ownPackage === '' ? [] : ownPackage.split('.');
  const climb = reference.relativeDepth - 1;
  if (climb > segments.length) {
    return null;
  }
  const base = segments.slice(0, segments.length - climb).join('.');
  if (reference.module === '') {
    return base;
  }
  return base === '' ? reference.module : `${base}.${reference.module}`;
}

function isPackageInit(file: string): boolean {
  return file === '__init__.py' || file.endsWith('/__init__.py');
}

/**
 * Directories that a module path can be counted from: the repository root, plus the first
 * non-package directory above each package chain.
 */
function sourceRoots(files: readonly string[]): Set<string> {
  const packageDirs = new Set<string>();
  for (const file of files) {
    if (isPackageInit(file)) {
      packageDirs.add(directoryOf(file));
    }
  }

  const roots = new Set<string>(['']);
  for (const dir of packageDirs) {
    let current = dir;
    for (;;) {
      const parent = directoryOf(current);
      if (parent === current) {
        break;
      }
      if (!packageDirs.has(parent)) {
        roots.add(parent);
        break;
      }
      current = parent;
    }
  }
  return roots;
}

/** Every module path this file answers to, one per source root it sits under. */
function moduleNamesFor(file: string, roots: ReadonlySet<string>): string[] {
  if (!file.endsWith('.py')) {
    return [];
  }
  const withoutExtension = file.slice(0, -'.py'.length);
  const names = new Set<string>();
  for (const root of roots) {
    const prefix = root === '' ? '' : `${root}/`;
    if (!withoutExtension.startsWith(prefix)) {
      continue;
    }
    let relative = withoutExtension.slice(prefix.length);
    if (relative === '' || relative === '__init__') {
      continue;
    }
    if (relative.endsWith('/__init__')) {
      relative = relative.slice(0, -'/__init__'.length);
    }
    names.add(relative.split('/').join('.'));
  }
  return [...names];
}

/** The fewest-segment name, which is the one counted from the deepest source root. */
function shortestName(names: readonly string[]): string | null {
  let best: string | null = null;
  for (const name of names) {
    if (
      best === null ||
      name.split('.').length < best.split('.').length ||
      (name.split('.').length === best.split('.').length && name < best)
    ) {
      best = name;
    }
  }
  return best;
}

function directoryOf(file: string): string {
  const index = file.lastIndexOf('/');
  return index === -1 ? '' : file.slice(0, index);
}

/**
 * Extract members from a Python file with tree-sitter.
 *
 * Classes contribute named types; their methods and attributes carry the class as `owner`.
 * Python declares most instance state in `__init__` rather than in the class body, so a
 * `self.x = ...` assignment inside any method is recorded as a field of that class —
 * without it a typical class would report no state at all. Module-level functions and
 * assignments are grouped under an owner named after the file, so a module that declares no
 * class still has members to show.
 */
export async function extractPythonSymbols(
  file: string,
  content: string,
): Promise<SymbolExtraction> {
  return withParser(PYTHON_LANGUAGE, (parser) => {
    const diagnostics: Diagnostic[] = [];
    const symbols: CodeSymbol[] = [];
    const fieldsByOwner = new Map<string, Set<string>>();
    const methodBodies: Array<{ owner: string; method: string; body: Node; scope: Node }> = [];

    const tree = parser.parse(content);
    if (!tree) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'error',
        kind: 'parse-failure',
        message: 'Python parser returned no tree for this file.',
      });
      return { symbols, diagnostics };
    }

    const module = moduleOwnerName(file);

    const addField = (owner: string, name: string, symbol: CodeSymbol | null): void => {
      const owned = fieldsByOwner.get(owner) ?? new Set<string>();
      fieldsByOwner.set(owner, owned);
      if (owned.has(name)) {
        return;
      }
      owned.add(name);
      if (symbol) {
        symbols.push(symbol);
      }
    };

    const visit = (node: Node, owner: string): void => {
      if (node.type === 'decorated_definition') {
        const definition = node.childForFieldName('definition');
        if (definition) {
          visit(definition, owner);
        }
        return;
      }

      if (node.type === 'class_definition') {
        const name = node.childForFieldName('name')?.text;
        if (!name) {
          return;
        }
        symbols.push({
          name,
          kind: 'type',
          visibility: pythonVisibility(name),
          owner,
          line: node.startPosition.row + 1,
        });
        const inner = owner ? `${owner}.${name}` : name;
        const body = node.childForFieldName('body');
        if (body) {
          for (const child of body.namedChildren) {
            visit(child, inner);
          }
        }
        return;
      }

      if (node.type === 'function_definition') {
        const name = node.childForFieldName('name')?.text;
        if (!name) {
          return;
        }
        const owningType = owner === '' ? module : owner;
        const symbol: CodeSymbol = {
          name,
          kind: 'method',
          visibility: pythonVisibility(name),
          owner: owningType,
          type: node.childForFieldName('return_type')?.text,
          parameters: countParameters(node.childForFieldName('parameters')),
          line: node.startPosition.row + 1,
        };
        const body = node.childForFieldName('body');
        if (body) {
          symbol.metrics = collectFunctionMetrics(body, symbol.line, PYTHON_FUNCTION_RULES);
        }
        symbols.push(symbol);
        if (body) {
          methodBodies.push({ owner: owningType, method: name, body, scope: node });
          // Python state is declared by assignment, not by a field declaration, so the
          // method bodies of a class are where its instance attributes are found.
          if (owner !== '') {
            for (const attribute of selfAssignments(body)) {
              addField(owner, attribute.name, {
                name: attribute.name,
                kind: 'field',
                visibility: pythonVisibility(attribute.name),
                owner,
                mutable: true,
                line: attribute.line,
              });
            }
          }
        }
        return;
      }

      if (node.type === 'expression_statement') {
        for (const child of node.namedChildren) {
          collectAssignedName(child, owner === '' ? module : owner, addField);
        }
        return;
      }

      for (const child of node.namedChildren) {
        visit(child, owner);
      }
    };

    for (const child of tree.rootNode.namedChildren) {
      visit(child, '');
    }

    const accesses: MemberAccess[] = [];
    for (const entry of methodBodies) {
      const fields = fieldsByOwner.get(entry.owner);
      if (fields) {
        accesses.push(
          ...collectMemberAccesses(
            entry.body,
            fields,
            entry.owner,
            entry.method,
            PYTHON_ACCESS,
            entry.scope,
          ),
        );
      }
    }

    const declared = new Set(
      symbols.filter((symbol) => symbol.kind === 'method').map((symbol) => symbol.name),
    );
    const types = new Set(
      symbols.filter((symbol) => symbol.kind === 'type').map((symbol) => symbol.name),
    );
    const calls = methodBodies.flatMap((entry) =>
      collectFunctionCalls(entry.body, declared, types, entry.owner, entry.method, PYTHON_CALLS),
    );
    markRecursive(symbols, calls);

    return { symbols: sortSymbols(symbols), diagnostics, accesses, calls };
  });
}

/** A module-level or class-level `name = ...`, with its annotation when one is written. */
function collectAssignedName(
  node: Node,
  owner: string,
  addField: (owner: string, name: string, symbol: CodeSymbol | null) => void,
): void {
  if (node.type !== 'assignment') {
    return;
  }
  const left = node.childForFieldName('left');
  if (!left || left.type !== 'identifier') {
    return;
  }
  addField(owner, left.text, {
    name: left.text,
    kind: 'field',
    visibility: pythonVisibility(left.text),
    owner,
    type: node.childForFieldName('type')?.text,
    mutable: true,
    line: left.startPosition.row + 1,
  });
}

/** `self.x = ...` assignments in a method body, which are how Python declares state. */
function selfAssignments(body: Node): Array<{ name: string; line: number }> {
  const found: Array<{ name: string; line: number }> = [];
  const visit = (node: Node): void => {
    if (node.type === 'assignment' || node.type === 'augmented_assignment') {
      const left = node.childForFieldName('left');
      const attribute = left ? selfAttributeName(left) : null;
      if (attribute) {
        found.push({ name: attribute, line: left?.startPosition.row ?? 0 });
      }
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  };
  visit(body);
  return found.map((entry) => ({ name: entry.name, line: entry.line + 1 }));
}

/** The attribute name of a `self.x` / `cls.x` expression, or null for anything else. */
function selfAttributeName(node: Node): string | null {
  if (node.type !== 'attribute') {
    return null;
  }
  const object = node.childForFieldName('object');
  if (!object || (object.text !== 'self' && object.text !== 'cls')) {
    return null;
  }
  return node.childForFieldName('attribute')?.text ?? null;
}

/**
 * Visibility by Python's naming convention, which is the only signal the language gives.
 *
 * A dunder name (`__init__`) is a magic method, not a private one, so it stays public.
 */
function pythonVisibility(name: string): string {
  if (name.startsWith('__') && name.endsWith('__')) {
    return 'public';
  }
  if (name.startsWith('__')) {
    return 'private';
  }
  if (name.startsWith('_')) {
    return 'protected';
  }
  return 'public';
}

/**
 * Declared parameters, excluding the bound `self`/`cls` receiver.
 *
 * The receiver is supplied by the call, not by the caller, so counting it would report
 * every zero-argument method as taking one.
 */
function countParameters(parameters: Node | null | undefined): number {
  if (!parameters) {
    return 0;
  }
  let count = 0;
  for (const child of parameters.namedChildren) {
    const name = parameterName(child);
    if (count === 0 && (name === 'self' || name === 'cls')) {
      continue;
    }
    count += 1;
  }
  return count;
}

function parameterName(node: Node): string | null {
  if (node.type === 'identifier') {
    return node.text;
  }
  return node.childForFieldName('name')?.text ?? null;
}

/** The owner shared by a module's top-level declarations, e.g. `views` for `app/views.py`. */
function moduleOwnerName(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

const PYTHON_FUNCTION_RULES: FunctionRules = {
  // Only the compound statements themselves nest. `elif`/`else`/`except`/`case` are child
  // nodes of their statement but sit at the same indent as its body, so counting them would
  // report an `if/elif` chain as one level deeper than it reads.
  controlFlowTypes: new Set([
    'if_statement',
    'for_statement',
    'while_statement',
    'try_statement',
    'with_statement',
    'match_statement',
  ]),
  loopTypes: new Set(['for_statement', 'while_statement']),
  decisionNodeTypes: new Set([
    'if_statement',
    'elif_clause',
    'for_statement',
    'while_statement',
    'except_clause',
    'case_clause',
    'conditional_expression',
    // A comprehension guard (`[x for x in xs if p(x)]`) branches exactly like an `if`.
    'if_clause',
    'assert_statement',
  ]),
  decisionOperators: new Set(['and', 'or']),
  callTypes: new Set(['call']),
  callTargetName: (node) => {
    const fn = node.childForFieldName('function');
    if (!fn) {
      return null;
    }
    if (fn.type === 'attribute') {
      return fn.childForFieldName('attribute')?.text ?? null;
    }
    return fn.type === 'identifier' ? fn.text : null;
  },
  linearScanCalls: new Set(['index', 'count', 'find']),
  sortCalls: new Set(['sort', 'sorted']),
  statementTypes: new Set([
    'expression_statement',
    'return_statement',
    'raise_statement',
    'pass_statement',
    'break_statement',
    'continue_statement',
    'delete_statement',
    'assert_statement',
    'global_statement',
    'nonlocal_statement',
    'import_statement',
    'import_from_statement',
    'if_statement',
    'for_statement',
    'while_statement',
    'try_statement',
    'with_statement',
    'match_statement',
  ]),
  nestedFunctionTypes: new Set(['function_definition', 'class_definition', 'lambda']),
};

const PYTHON_CALLS: CallRules = {
  callTypes: new Set(['call']),
  callTarget: (node) => {
    const fn = node.childForFieldName('function');
    if (!fn) {
      return null;
    }
    if (fn.type === 'identifier') {
      return { name: fn.text, kind: 'bare' };
    }
    if (fn.type !== 'attribute') {
      return null;
    }
    const object = fn.childForFieldName('object');
    const attribute = fn.childForFieldName('attribute');
    if (!object || !attribute) {
      return null;
    }
    // Only a call through the bound receiver proves its target; `obj.method()` does not,
    // because the receiver's type is not known here.
    if (object.text === 'self' || object.text === 'cls') {
      return { name: attribute.text, kind: 'self', receiver: object.text };
    }
    return null;
  },
};

const PYTHON_ACCESS: AccessRules = {
  identifierTypes: new Set(['identifier']),
  assignmentTypes: new Set(['assignment', 'augmented_assignment']),
  selfAccess: (node) => {
    const name = selfAttributeName(node);
    if (!name) {
      return null;
    }
    const fieldNode = node.childForFieldName('attribute');
    return fieldNode ? { field: name, fieldNode } : null;
  },
  declaredNames: (body) =>
    collectDeclaredIdentifiers(body, (node) => {
      // A plain parameter is a bare `identifier` under `parameters`; without this a
      // parameter that shares a field's name would read as a reference to the field.
      if (
        node.type === 'identifier' &&
        (node.parent?.type === 'parameters' || node.parent?.type === 'lambda_parameters')
      ) {
        return node.text;
      }
      if (node.type === 'parameters' || node.type === 'lambda_parameters') {
        return null;
      }
      if (
        node.type === 'typed_parameter' ||
        node.type === 'default_parameter' ||
        node.type === 'typed_default_parameter'
      ) {
        return node.childForFieldName('name')?.text ?? null;
      }
      if (node.type === 'assignment' || node.type === 'for_statement') {
        const left = node.childForFieldName('left');
        return left?.type === 'identifier' ? left.text : null;
      }
      if (node.type === 'as_pattern_target') {
        return node.text;
      }
      return null;
    }),
};
