import type { Node } from 'web-tree-sitter';

import type { Diagnostic, GraphEdge } from '../../types.ts';
import { markEntries } from './entry.ts';
import { collectFunctionMetrics, looksLikeTypeName, markRecursive, type FunctionRules } from './function-metrics.ts';
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
} from './symbols.ts';

export const KOTLIN_LANGUAGE: GrammarLanguage = 'kotlin';

export interface KotlinImport {
  /** Fully-qualified type, or package for a wildcard import. */
  name: string;
  wildcard: boolean;
  alias?: string;
  line: number;
}

export interface KotlinTypeDeclaration {
  name: string;
  line: number;
}

/** A type used in the file body, whether or not it was imported. */
export interface KotlinTypeReference {
  name: string;
  line: number;
}

/** A call site whose callee the syntax proves: `foo(...)` or `Type.foo(...)`. */
export interface KotlinCall {
  name: string;
  qualifier?: string;
  line: number;
}

export interface KotlinFileFacts {
  file: string;
  package: string;
  imports: KotlinImport[];
  types: KotlinTypeDeclaration[];
  typeReferences: KotlinTypeReference[];
  /** Function names the file declares, so a call can be proven against this file. */
  functions: string[];
  calls: KotlinCall[];
}

export interface KotlinExtraction {
  facts: KotlinFileFacts;
  diagnostics: Diagnostic[];
}

const PACKAGE_PATTERN = /^package\s+([\w.]+)/;

const KOTLIN_TYPE_DECLARATIONS = new Set([
  'class_declaration',
  'interface_declaration',
  'object_declaration',
]);

/** Parse one Kotlin file into its package, imports, declared types, and type references. */
export async function extractKotlinFacts(file: string, content: string): Promise<KotlinExtraction> {
  return withParser(KOTLIN_LANGUAGE, (parser) => {
    const facts: KotlinFileFacts = {
      file,
      package: '',
      imports: [],
      types: [],
      typeReferences: [],
      functions: [],
      calls: [],
    };
    const diagnostics: Diagnostic[] = [];

    const tree = parser.parse(content);
    if (!tree) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'error',
        kind: 'parse-failure',
        message: 'Kotlin parser returned no tree for this file.',
      });
      return { facts, diagnostics };
    }

    for (const node of tree.rootNode.namedChildren) {
      if (node.type === 'package_header') {
        facts.package = PACKAGE_PATTERN.exec(node.text)?.[1] ?? '';
      } else if (node.type === 'import_list') {
        for (const header of node.namedChildren) {
          if (header.type === 'import_header') {
            const reference = parseImport(header);
            if (reference) {
              facts.imports.push(reference);
            }
          }
        }
      }
    }

    collectTypes(tree.rootNode, '', facts.types);
    const references: KotlinTypeReference[] = [];
    collectTypeReferences(tree.rootNode, references);
    facts.typeReferences = dedupeReferences(references);
    collectFunctions(tree.rootNode, facts.functions);
    collectCalls(tree.rootNode, facts.calls);

    if (tree.rootNode.hasError) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'warning',
        kind: 'parse-failure',
        message: 'Kotlin source contains syntax errors; extracted facts may be incomplete.',
      });
    }

    return { facts, diagnostics };
  });
}

function parseImport(header: Node): KotlinImport | null {
  const identifier = header.namedChildren.find((child) => child.type === 'identifier');
  if (!identifier) {
    return null;
  }
  const wildcard = header.namedChildren.some((child) => child.type === 'wildcard_import');
  const aliasNode = header.namedChildren.find((child) => child.type === 'import_alias');
  const alias = aliasNode?.namedChildren.find((child) => child.type === 'type_identifier')?.text;
  return {
    name: identifier.text,
    wildcard,
    alias,
    line: header.startPosition.row + 1,
  };
}

/** Collect a type and its nested types with dotted names (`Outer.Inner`). */
function collectTypes(node: Node, prefix: string, out: KotlinTypeDeclaration[]): void {
  let nextPrefix = prefix;
  if (KOTLIN_TYPE_DECLARATIONS.has(node.type)) {
    const name = node.namedChildren.find((child) => child.type === 'type_identifier');
    if (name) {
      const full = prefix ? `${prefix}.${name.text}` : name.text;
      out.push({ name: full, line: name.startPosition.row + 1 });
      nextPrefix = full;
    }
  }
  for (const child of node.namedChildren) {
    collectTypes(child, nextPrefix, out);
  }
}

/**
 * Collect simple type names used in the file body.
 *
 * Every `type_identifier` counts except a declaration's own name and an import alias, so
 * generic arguments (`List<Helper>`) contribute both `List` and `Helper`.
 */
function collectTypeReferences(node: Node, out: KotlinTypeReference[]): void {
  if (node.type === 'type_identifier' && !isDeclarationName(node)) {
    out.push({ name: node.text, line: node.startPosition.row + 1 });
    return;
  }
  for (const child of node.namedChildren) {
    collectTypeReferences(child, out);
  }
}

function isDeclarationName(node: Node): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  return KOTLIN_TYPE_DECLARATIONS.has(parent.type) || parent.type === 'import_alias';
}

function dedupeReferences(references: KotlinTypeReference[]): KotlinTypeReference[] {
  const byName = new Map<string, KotlinTypeReference>();
  for (const reference of references) {
    if (!byName.has(reference.name)) {
      byName.set(reference.name, reference);
    }
  }
  return [...byName.values()];
}

/** The local name an import binds: its alias when present, else the last segment. */
function kotlinLocalName(reference: KotlinImport): string {
  if (reference.alias) {
    return reference.alias;
  }
  return reference.name.slice(reference.name.lastIndexOf('.') + 1);
}

/** Collect declared function names, so a call can be proven against this file. */
function collectFunctions(node: Node, out: string[]): void {
  if (node.type === 'function_declaration') {
    const name = node.namedChildren.find((child) => child.type === 'simple_identifier')?.text;
    if (name) {
      out.push(name);
    }
    return;
  }
  for (const child of node.namedChildren) {
    collectFunctions(child, out);
  }
}

/**
 * Collect the call sites whose callee the syntax proves.
 *
 * `foo(...)` is bare; `Type.foo(...)` names the receiver. `this.foo()` is skipped (same-file)
 * and `obj.foo()` is not recorded because the receiver's type is unknown here.
 */
function collectCalls(node: Node, out: KotlinCall[]): void {
  if (node.type === 'call_expression') {
    const callee = node.namedChildren[0];
    if (callee?.type === 'simple_identifier') {
      out.push({ name: callee.text, line: node.startPosition.row + 1 });
    } else if (callee?.type === 'navigation_expression') {
      const receiver = callee.namedChildren[0];
      const suffix = callee.namedChildren.find((child) => child.type === 'navigation_suffix');
      const property = suffix?.namedChildren.find((child) => child.type === 'simple_identifier');
      if (
        receiver?.type === 'simple_identifier' &&
        property &&
        looksLikeTypeName(receiver.text)
      ) {
        out.push({ name: property.text, qualifier: receiver.text, line: node.startPosition.row + 1 });
      }
    }
    return;
  }
  for (const child of node.namedChildren) {
    collectCalls(child, out);
  }
}

interface KotlinIndex {
  qualifiedTypes: Map<string, string>;
  packages: Map<string, Set<string>>;
  namespaces: Set<string>;
  simpleTypesByPackage: Map<string, Map<string, Set<string>>>;
}

function buildIndex(facts: KotlinFileFacts[]): KotlinIndex {
  const qualifiedTypes = new Map<string, string>();
  const packages = new Map<string, Set<string>>();
  const namespaces = new Set<string>();
  const simpleTypesByPackage = new Map<string, Map<string, Set<string>>>();

  for (const fileFacts of facts) {
    if (!fileFacts.package) {
      continue;
    }
    addNamespacePrefixes(namespaces, fileFacts.package);
    const members = packages.get(fileFacts.package) ?? new Set<string>();
    packages.set(fileFacts.package, members);
    members.add(fileFacts.file);

    const simpleTypes =
      simpleTypesByPackage.get(fileFacts.package) ?? new Map<string, Set<string>>();
    simpleTypesByPackage.set(fileFacts.package, simpleTypes);

    for (const type of fileFacts.types) {
      qualifiedTypes.set(`${fileFacts.package}.${type.name}`, fileFacts.file);
      if (!type.name.includes('.')) {
        const files = simpleTypes.get(type.name) ?? new Set<string>();
        simpleTypes.set(type.name, files);
        files.add(fileFacts.file);
      }
    }
  }

  return { qualifiedTypes, packages, namespaces, simpleTypesByPackage };
}

export interface KotlinResolution {
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

/**
 * Resolve Kotlin imports and same-package type references to repository files.
 *
 * An import only becomes an edge when it resolves inside the repository. Imports are
 * treated as external unless they share at least two leading package segments with the
 * repository, so a common root such as `com`, `io`, or `org` is not mistaken for proof of
 * an internal reference.
 */
export function resolveKotlin(facts: KotlinFileFacts[]): KotlinResolution {
  const index = buildIndex(facts);
  const edges: GraphEdge[] = [];
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const pairs = new Set<string>();
  const importedSimpleNames = new Map<string, Set<string>>();

  const push = (
    source: string,
    target: string,
    line: number,
    specifier: string,
    resolution: 'exact' | 'index-of-package',
  ): void => {
    if (source === target) {
      return;
    }
    const key = `${source}\u0000${target}\u0000${line}\u0000${resolution}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    pairs.add(`${source}\u0000${target}`);
    edges.push({ source, target, kind: 'package', evidence: { line, specifier, resolution } });
  };

  for (const fileFacts of facts) {
    const imported = importedSimpleNames.get(fileFacts.file) ?? new Set<string>();
    importedSimpleNames.set(fileFacts.file, imported);

    for (const reference of fileFacts.imports) {
      if (reference.wildcard) {
        const members = index.packages.get(reference.name);
        if (members && members.size > 0) {
          for (const target of [...members].sort()) {
            push(fileFacts.file, target, reference.line, `${reference.name}.*`, 'index-of-package');
          }
        } else if (looksInternal(reference.name, index.namespaces)) {
          diagnostics.push(unresolved(fileFacts.file, reference.line, reference.name));
        }
        continue;
      }

      imported.add(reference.name.slice(reference.name.lastIndexOf('.') + 1));
      const candidates = [
        reference.name,
        reference.name.slice(0, reference.name.lastIndexOf('.')),
      ].filter(Boolean);
      const target = candidates.map((candidate) => index.qualifiedTypes.get(candidate)).find(Boolean);
      if (target) {
        push(fileFacts.file, target, reference.line, reference.name, 'exact');
        continue;
      }
      if (looksInternal(reference.name, index.namespaces)) {
        diagnostics.push(unresolved(fileFacts.file, reference.line, reference.name));
      }
    }
  }

  for (const fileFacts of facts) {
    if (!fileFacts.package) {
      continue;
    }
    const simpleTypes = index.simpleTypesByPackage.get(fileFacts.package);
    if (!simpleTypes) {
      continue;
    }
    const imported = importedSimpleNames.get(fileFacts.file) ?? new Set<string>();
    const ownTypes = new Set(fileFacts.types.map((type) => type.name.split('.').pop() as string));
    const ambiguous = new Set<string>();

    for (const reference of fileFacts.typeReferences) {
      if (imported.has(reference.name) || ownTypes.has(reference.name)) {
        continue;
      }
      const files = simpleTypes.get(reference.name);
      if (!files || files.size === 0) {
        continue;
      }
      if (files.size > 1) {
        if (!ambiguous.has(reference.name)) {
          ambiguous.add(reference.name);
          diagnostics.push({
            file: fileFacts.file,
            line: reference.line,
            severity: 'warning',
            kind: 'ambiguous',
            specifier: reference.name,
            message: `Type "${reference.name}" is declared by more than one file in package "${fileFacts.package}".`,
          });
        }
        continue;
      }
      const target = [...files][0] as string;
      if (target === fileFacts.file || pairs.has(`${fileFacts.file}\u0000${target}`)) {
        continue;
      }
      push(fileFacts.file, target, reference.line, reference.name, 'index-of-package');
    }
  }

  appendCallEdges(facts, index, edges);
  return { edges, diagnostics };
}

/**
 * Join a provable call to the file that declares its function.
 *
 * `Type.foo()` resolves `Type` through an import (or a same-package type) and requires the
 * target file to declare `foo`. A bare `foo()` resolves a top-level function import by the
 * same last-segment rule the import resolver uses. Ambiguous or unimported receivers are left
 * unclaimed.
 */
function appendCallEdges(
  facts: readonly KotlinFileFacts[],
  index: KotlinIndex,
  edges: GraphEdge[],
): void {
  const declaredFunctions = new Map<string, Set<string>>();
  for (const fact of facts) {
    declaredFunctions.set(fact.file, new Set(fact.functions ?? []));
  }
  const declares = (file: string, name: string): boolean =>
    declaredFunctions.get(file)?.has(name) ?? false;
  const seen = new Set<string>();

  for (const fact of facts) {
    for (const call of fact.calls ?? []) {
      let target: string | undefined;
      if (call.qualifier) {
        const imported = fact.imports.find(
          (entry) => !entry.wildcard && kotlinLocalName(entry) === call.qualifier,
        );
        target = imported ? index.qualifiedTypes.get(imported.name) : undefined;
        if (!target) {
          const samePackage = index.simpleTypesByPackage.get(fact.package)?.get(call.qualifier);
          target = samePackage && samePackage.size === 1 ? ([...samePackage][0] as string) : undefined;
        }
      } else {
        for (const entry of fact.imports) {
          if (entry.wildcard || kotlinLocalName(entry) !== call.name) {
            continue;
          }
          // A top-level function import names the function; its file is the parent path's type
          // or module, which the import resolver already matched.
          const parent = entry.name.slice(0, entry.name.lastIndexOf('.'));
          const candidate = index.qualifiedTypes.get(entry.name) ?? index.qualifiedTypes.get(parent);
          if (candidate && declares(candidate, call.name)) {
            target = candidate;
          }
        }
      }
      if (!target || target === fact.file || !declares(target, call.name)) {
        continue;
      }
      const specifier = call.qualifier ? `${call.qualifier}.${call.name}` : call.name;
      const key = `${fact.file}\u0000${target}\u0000${call.line}\u0000call`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      edges.push({
        source: fact.file,
        target,
        kind: 'call',
        role: 'use',
        evidence: { line: call.line, specifier, resolution: 'exact' },
      });
    }
  }
}

function unresolved(file: string, line: number, specifier: string): Diagnostic {
  return {
    file,
    line,
    severity: 'warning',
    kind: 'unresolved',
    specifier,
    message: `Kotlin import "${specifier}" does not resolve to a file inside the repository.`,
  };
}

/**
 * Extract declared members (fields and methods) with visibility and owner.
 *
 * Symbols are extracted on demand rather than during every scan; edges do not need them.
 */
export async function extractKotlinSymbols(
  file: string,
  content: string,
): Promise<SymbolExtraction> {
  return withParser(KOTLIN_LANGUAGE, (parser) => {
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
        message: 'Kotlin parser returned no tree for this file.',
      });
      return { symbols, diagnostics };
    }

    const typeNames = new Set<string>();

    const visit = (node: Node, owner: string): void => {
      if (
        node.type === 'class_declaration' ||
        node.type === 'interface_declaration' ||
        node.type === 'object_declaration'
      ) {
        const name = node.namedChildren.find((child) => child.type === 'type_identifier')?.text;
        if (name) {
          typeNames.add(name);
        }
        const nextOwner = name ? (owner ? `${owner}.${name}` : name) : owner;
        for (const child of node.namedChildren) {
          visit(child, nextOwner);
        }
        return;
      }
      // Members of a companion object belong to the enclosing type.
      if (node.type === 'companion_object') {
        for (const child of node.namedChildren) {
          visit(child, owner);
        }
        return;
      }
      if (node.type === 'property_declaration') {
        const field = fieldOf(node, owner);
        if (field) {
          symbols.push(field);
          const ownerFields = fieldsByOwner.get(owner) ?? new Set<string>();
          fieldsByOwner.set(owner, ownerFields);
          ownerFields.add(field.name);
          return;
        }
      }
      if (node.type === 'function_declaration') {
        const method = methodOf(node, owner);
        if (method) {
          const body = node.namedChildren.find((child) => child.type === 'function_body');
          if (body) {
            method.metrics = collectFunctionMetrics(body, method.line, KOTLIN_FUNCTION_RULES);
          }
          symbols.push(method);
          // Top-level `fun` records calls too: without an owner the member-access
          // pass is a no-op and type-qualified receivers are refused, so this is safe.
          if (body) {
            methodBodies.push({ owner, method: method.name, body, scope: node });
          }
          return;
        }
      }
      for (const child of node.namedChildren) {
        visit(child, owner);
      }
    };

    visit(tree.rootNode, '');

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
            KOTLIN_ACCESS,
            entry.scope,
          ),
        );
      }
    }

    const declared = new Set(
      symbols.filter((symbol) => symbol.kind === 'method').map((symbol) => symbol.name),
    );
    const calls = methodBodies.flatMap((entry) =>
      collectFunctionCalls(entry.body, declared, typeNames, entry.owner, entry.method, KOTLIN_CALLS),
    );
    markRecursive(symbols, calls);
    markEntries(symbols, content);

    symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
    return { symbols, diagnostics, accesses, calls };
  });
}

const KOTLIN_FUNCTION_RULES: FunctionRules = {
  controlFlowTypes: new Set([
    'if_expression',
    'when_expression',
    'for_statement',
    'while_statement',
    'do_while_statement',
    'try_expression',
    'catch_block',
  ]),
  loopTypes: new Set(['for_statement', 'while_statement', 'do_while_statement']),
  decisionNodeTypes: new Set([
    'if_expression',
    'when_entry',
    'for_statement',
    'while_statement',
    'do_while_statement',
    'catch_block',
    'conjunction_expression',
    'disjunction_expression',
    'elvis_expression',
  ]),
  decisionOperators: new Set(),
  callTypes: new Set(['call_expression']),
  callTargetName: (node) => {
    const callee = node.namedChildren[0];
    if (!callee) {
      return null;
    }
    if (callee.type === 'simple_identifier') {
      return callee.text;
    }
    if (callee.type === 'navigation_expression') {
      const suffix = callee.namedChildren.find((child) => child.type === 'navigation_suffix');
      return suffix?.namedChildren.find((child) => child.type === 'simple_identifier')?.text ?? null;
    }
    return null;
  },
  linearScanCalls: new Set([
    'contains',
    'indexof',
    'lastindexof',
    'find',
    'filter',
    'any',
    'all',
    'none',
    'count',
  ]),
  sortCalls: new Set(['sort', 'sorted', 'sortedby', 'sortby', 'sortedwith']),
  statementTypes: new Set([
    'property_declaration',
    'assignment',
    'call_expression',
    'if_expression',
    'when_expression',
    'for_statement',
    'while_statement',
    'do_while_statement',
    'try_expression',
    'jump_expression',
  ]),
  nestedFunctionTypes: new Set([
    'function_declaration',
    'lambda_literal',
    'anonymous_function',
    'object_literal',
    'class_declaration',
    'object_declaration',
    'interface_declaration',
  ]),
};

const KOTLIN_CALLS: CallRules = {
  callTypes: new Set(['call_expression']),
  callTarget: (node) => {
    const callee = node.namedChildren[0];
    if (!callee) {
      return null;
    }
    if (callee.type === 'simple_identifier') {
      return { name: callee.text, kind: 'bare' };
    }
    if (callee.type !== 'navigation_expression') {
      return null;
    }
    const receiver = callee.namedChildren[0];
    const suffix = callee.namedChildren.find((child) => child.type === 'navigation_suffix');
    const property = suffix?.namedChildren.find((child) => child.type === 'simple_identifier');
    if (!receiver || !property) {
      return null;
    }
    if (receiver.type === 'this_expression' || receiver.text === 'this') {
      return { name: property.text, kind: 'self', receiver: 'this' };
    }
    if (receiver.type === 'simple_identifier' && looksLikeTypeName(receiver.text)) {
      return { name: property.text, kind: 'type-qualified', receiver: receiver.text };
    }
    return null;
  },
};

const KOTLIN_ACCESS: AccessRules = {
  identifierTypes: new Set(['simple_identifier']),
  assignmentTypes: new Set(['assignment', 'assignment_expression', 'update_expression']),
  selfAccess: (node) => {
    if (node.type !== 'navigation_expression') {
      return null;
    }
    const receiver = node.namedChildren[0];
    if (!receiver || (receiver.type !== 'this_expression' && receiver.text !== 'this')) {
      return null;
    }
    const suffix = node.namedChildren.find((child) => child.type === 'navigation_suffix');
    const field = suffix?.namedChildren.find((child) => child.type === 'simple_identifier');
    return field ? { field: field.text, fieldNode: field } : null;
  },
  declaredNames: (body) =>
    collectDeclaredIdentifiers(body, (node) => {
      if (node.type === 'parameter' || node.type === 'variable_declaration') {
        return node.namedChildren.find((child) => child.type === 'simple_identifier')?.text ?? null;
      }
      if (node.type === 'lambda_parameters') {
        return node.namedChildren.find((child) => child.type === 'variable_declaration')
          ?.namedChildren.find((child) => child.type === 'simple_identifier')?.text ?? null;
      }
      return null;
    }),
};

function visibilityOf(node: Node): string {
  const modifiers = node.namedChildren.find((child) => child.type === 'modifiers');
  const visibility = modifiers?.namedChildren.find((child) => child.type === 'visibility_modifier');
  return visibility?.text ?? 'public';
}

function fieldOf(node: Node, owner: string): CodeSymbol | null {
  const declaration = node.namedChildren.find((child) => child.type === 'variable_declaration');
  const name = declaration?.namedChildren.find((child) => child.type === 'simple_identifier')?.text;
  if (!name) {
    return null;
  }
  const binding = node.namedChildren.find((child) => child.type === 'binding_pattern_kind')?.text;
  const type = declaration?.namedChildren
    .find((child) => child.type === 'user_type')
    ?.namedChildren.find((child) => child.type === 'type_identifier')?.text;
  return {
    name,
    kind: 'field',
    visibility: visibilityOf(node),
    owner,
    type,
    mutable: binding === 'var',
    line: node.startPosition.row + 1,
  };
}

function methodOf(node: Node, owner: string): CodeSymbol | null {
  const name = node.namedChildren.find((child) => child.type === 'simple_identifier')?.text;
  if (!name) {
    return null;
  }
  const parameters = node.namedChildren.find(
    (child) => child.type === 'function_value_parameters',
  );
  const returnType = node.namedChildren
    .filter((child) => child.type === 'user_type')
    .at(-1)
    ?.namedChildren.find((child) => child.type === 'type_identifier')?.text;
  return {
    name,
    kind: 'method',
    visibility: visibilityOf(node),
    owner,
    type: returnType,
    parameters: parameters?.namedChildren.filter((child) => child.type === 'parameter').length ?? 0,
    line: node.startPosition.row + 1,
  };
}
