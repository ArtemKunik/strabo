import type { Node } from 'web-tree-sitter';

import type { Diagnostic, EdgeEvidence, GraphEdge } from '../../types.ts';
import { markEntries } from './entry.ts';
import { collectFunctionMetrics, looksLikeTypeName, markRecursive, type FunctionRules } from './function-metrics.ts';
import type { GrammarLanguage } from './parser-runtime.ts';
import type { SymbolContext } from './registry.ts';
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

export const CPP_LANGUAGE: GrammarLanguage = 'cpp';

/** One `#include` directive. */
export interface CppInclude {
  /** The path as authored, without its quotes or angle brackets. */
  path: string;
  /**
   * True for `#include "x.h"`, false for `#include <x>`. The language makes the distinction
   * itself: quoted means "look beside this file first", angled means a system or library
   * header. It is the one piece of evidence that says whether a miss is worth reporting.
   */
  quoted: boolean;
  line: number;
}

export interface CppFileFacts {
  file: string;
  includes: CppInclude[];
}

export interface CppExtraction {
  facts: CppFileFacts;
  diagnostics: Diagnostic[];
}

export interface CppResolution {
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

/** Parse one C++ file into the headers it includes. */
export async function extractCppFacts(file: string, content: string): Promise<CppExtraction> {
  return withParser(CPP_LANGUAGE, (parser) => {
    const diagnostics: Diagnostic[] = [];
    const facts: CppFileFacts = { file, includes: [] };

    const tree = parser.parse(content);
    if (!tree) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'error',
        kind: 'parse-failure',
        message: 'C++ parser returned no tree for this file.',
      });
      return { facts, diagnostics };
    }

    // Includes are collected from the whole tree, not just the top: a header guard or an
    // `#ifdef` block puts them inside a preprocessor node.
    collectIncludes(tree.rootNode, facts.includes);

    if (tree.rootNode.hasError) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'warning',
        kind: 'parse-failure',
        message: 'C++ source contains syntax errors; extracted facts may be incomplete.',
      });
    }

    return { facts, diagnostics };
  });
}

function collectIncludes(node: Node, includes: CppInclude[]): void {
  if (node.type === 'preproc_include') {
    const path = node.childForFieldName('path');
    if (path) {
      if (path.type === 'string_literal') {
        const content = path.namedChildren.find((child) => child.type === 'string_content');
        if (content) {
          includes.push({ path: content.text, quoted: true, line: node.startPosition.row + 1 });
        }
      } else if (path.type === 'system_lib_string') {
        includes.push({
          path: path.text.replace(/^<|>$/g, ''),
          quoted: false,
          line: node.startPosition.row + 1,
        });
      }
    }
    return;
  }
  for (const child of node.namedChildren) {
    collectIncludes(child, includes);
  }
}

/**
 * Resolve `#include` directives to repository files.
 *
 * An include names a path, not a symbol, so resolution is a path lookup rather than the
 * namespace search the JVM languages need. Three spellings are tried, in the order a
 * compiler would: beside the including file, from the repository root, then as a suffix of
 * exactly one repository path — which stands in for an unknown `-I` include directory.
 *
 * A suffix that matches several files is reported as `ambiguous` rather than resolved to
 * one of them. An angled include is never an edge and never a diagnostic: `<vector>` is a
 * system header by definition, and the repository is not expected to contain it.
 */
export function resolveCpp(facts: readonly CppFileFacts[]): CppResolution {
  const known = new Set(facts.map((entry) => entry.file));

  // Index by trailing path segments so an include written against an unknown -I root can
  // still be matched, and so a collision is visible rather than silently resolved.
  const bySuffix = new Map<string, Set<string>>();
  for (const file of known) {
    const segments = file.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      const suffix = segments.slice(index).join('/');
      const claimants = bySuffix.get(suffix) ?? new Set<string>();
      bySuffix.set(suffix, claimants);
      claimants.add(file);
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
    const key = `${source}\u0000${target}\u0000${line}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    edges.push({ source, target, kind: 'import', evidence: { line, specifier, resolution } });
  };

  for (const fileFacts of facts) {
    for (const include of fileFacts.includes) {
      if (!include.quoted) {
        continue;
      }

      const beside = normalisePath(`${directoryOf(fileFacts.file)}/${include.path}`);
      if (beside !== null && known.has(beside)) {
        pushEdge(fileFacts.file, beside, include.line, include.path, 'exact');
        continue;
      }

      const fromRoot = normalisePath(include.path);
      if (fromRoot !== null && known.has(fromRoot)) {
        pushEdge(fileFacts.file, fromRoot, include.line, include.path, 'root');
        continue;
      }

      const claimants = fromRoot === null ? undefined : bySuffix.get(fromRoot);
      if (claimants && claimants.size === 1) {
        const target = [...claimants][0];
        if (target) {
          pushEdge(fileFacts.file, target, include.line, include.path, 'root');
        }
        continue;
      }
      if (claimants && claimants.size > 1) {
        diagnostics.push({
          file: fileFacts.file,
          line: include.line,
          severity: 'warning',
          kind: 'ambiguous',
          specifier: include.path,
          message: `"${include.path}" matches ${claimants.size} files (${[...claimants].sort().join(', ')}); no edge was drawn.`,
        });
        continue;
      }

      // A quoted include asks for a file beside this one, so a miss is worth reporting —
      // unlike an angled include, which names a header the repository is not expected to own.
      diagnostics.push({
        file: fileFacts.file,
        line: include.line,
        severity: 'warning',
        kind: 'unresolved',
        specifier: include.path,
        message: `Quoted include "${include.path}" did not match a repository file.`,
      });
    }
  }

  return { edges, diagnostics };
}

/** Apply `.` and `..` segments; null when the path climbs above the repository root. */
function normalisePath(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (out.length === 0) {
        return null;
      }
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

function directoryOf(file: string): string {
  const index = file.lastIndexOf('/');
  return index === -1 ? '' : file.slice(0, index);
}

/**
 * Extract members from a C++ file with tree-sitter.
 *
 * Two things make C++ different from the other languages here. Access is positional — a
 * `public:` label applies until the next label, rather than a modifier sitting on each
 * member — so the class body is walked in order with the current label carried along. And a
 * method is declared in the class body but often defined outside it, as
 * `void Widget::render() { ... }`; when both are in one file they are recorded as one
 * member, with the body's measurements attached to the declaration, so a method does not
 * appear twice in the member map.
 */
export async function extractCppSymbols(
  file: string,
  content: string,
  context?: SymbolContext,
): Promise<SymbolExtraction> {
  // Resolved before the parser is taken: the shared parser is not reentrant, so the headers
  // are parsed to completion first rather than from inside this file's own parse.
  const inherited = await inheritedDeclarations(context?.related);

  return withParser(CPP_LANGUAGE, (parser) => {
    const diagnostics: Diagnostic[] = [];
    const symbols: CodeSymbol[] = [];
    const fieldsByOwner = new Map<string, Set<string>>();
    const methodBodies: Array<{ owner: string; method: string; body: Node; scope: Node }> = [];
    const declaredMethods = new Map<string, CodeSymbol>();

    const tree = parser.parse(content);
    if (!tree) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'error',
        kind: 'parse-failure',
        message: 'C++ parser returned no tree for this file.',
      });
      return { symbols, diagnostics };
    }

    const recordField = (owner: string, name: string): void => {
      const owned = fieldsByOwner.get(owner) ?? new Set<string>();
      fieldsByOwner.set(owner, owned);
      owned.add(name);
    };

    /** Walk a class body, tracking the access label that is currently in force. */
    const visitClassBody = (body: Node, owner: string, defaultAccess: string): void => {
      let access = defaultAccess;
      for (const member of body.namedChildren) {
        if (member.type === 'access_specifier') {
          access = member.text.replace(':', '').trim() || access;
          continue;
        }
        visitMember(member, owner, access);
      }
    };

    const visitMember = (node: Node, owner: string, access: string): void => {
      if (TYPE_SPECIFIERS.has(node.type)) {
        visitType(node, owner, access);
        return;
      }

      if (node.type === 'template_declaration') {
        for (const child of node.namedChildren) {
          visitMember(child, owner, access);
        }
        return;
      }

      // A bodyless method: `void render();` is a field_declaration, a constructor is a
      // bare declaration, and both carry a function_declarator.
      if (node.type === 'field_declaration' || node.type === 'declaration') {
        const declarator = node.childForFieldName('declarator');
        if (declarator?.type === 'function_declarator') {
          const symbol = methodSymbol(node, declarator, owner, access);
          if (symbol) {
            symbols.push(symbol);
            declaredMethods.set(`${owner}\u0000${symbol.name}`, symbol);
          }
          return;
        }
        const name = innermostName(declarator);
        if (name) {
          symbols.push({
            name,
            kind: 'field',
            visibility: access,
            owner,
            type: node.childForFieldName('type')?.text,
            mutable: !/\bconst\b/.test(node.text.slice(0, node.text.indexOf(name) + 1)),
            line: (declarator ?? node).startPosition.row + 1,
          });
          recordField(owner, name);
        }
        return;
      }

      if (node.type === 'function_definition') {
        visitFunctionDefinition(node, owner, access);
        return;
      }
    };

    const visitType = (node: Node, owner: string, access: string): void => {
      const name = node.childForFieldName('name')?.text;
      if (!name) {
        return;
      }
      symbols.push({
        name,
        kind: 'type',
        visibility: access,
        owner,
        line: node.startPosition.row + 1,
      });
      const body = node.childForFieldName('body');
      if (body) {
        const inner = owner ? `${owner}::${name}` : name;
        // A struct's members are public by default; a class's are private.
        visitClassBody(body, inner, node.type === 'class_specifier' ? 'private' : 'public');
      }
    };

    const visitFunctionDefinition = (node: Node, owner: string, access: string): void => {
      const declarator = node.childForFieldName('declarator');
      if (declarator?.type !== 'function_declarator') {
        return;
      }
      const target = declarator.childForFieldName('declarator');
      if (!target) {
        return;
      }

      // `void acme::Widget::render()` names its own owner; the last segment is the method
      // and the one before it is the type, so the namespace prefix falls away.
      const qualified = qualifiedSegments(target);
      const name = qualified[qualified.length - 1] ?? '';
      const declaredOwner =
        qualified.length >= 2 ? qualified[qualified.length - 2] ?? owner : owner;
      if (name === '') {
        return;
      }

      const body = node.childForFieldName('body');
      const existing = declaredMethods.get(`${declaredOwner}\u0000${name}`);
      if (existing) {
        // The declaration is already recorded; attach the body to it rather than repeating it.
        // The span is measured from the definition, not from the declaration: they can be
        // hundreds of lines apart, and `lines` is meant to size the body.
        if (body) {
          existing.metrics = collectFunctionMetrics(
            body,
            node.startPosition.row + 1,
            CPP_FUNCTION_RULES,
          );
          methodBodies.push({ owner: declaredOwner, method: name, body, scope: node });
        }
        return;
      }

      const symbol = methodSymbol(node, declarator, declaredOwner, access);
      if (!symbol) {
        return;
      }
      if (body) {
        symbol.metrics = collectFunctionMetrics(body, symbol.line, CPP_FUNCTION_RULES);
      }
      symbols.push(symbol);
      declaredMethods.set(`${declaredOwner}\u0000${name}`, symbol);
      if (body) {
        methodBodies.push({ owner: declaredOwner, method: name, body, scope: node });
      }
    };

    /** Top level: namespaces are transparent, and a free function belongs to the file. */
    const visitTop = (node: Node): void => {
      if (node.type === 'namespace_definition' || node.type === 'linkage_specification') {
        const body = node.childForFieldName('body');
        if (body) {
          for (const child of body.namedChildren) {
            visitTop(child);
          }
        }
        return;
      }
      if (node.type === 'template_declaration' || node.type === 'declaration_list') {
        for (const child of node.namedChildren) {
          visitTop(child);
        }
        return;
      }
      if (TYPE_SPECIFIERS.has(node.type)) {
        visitType(node, '', 'public');
        return;
      }
      if (node.type === 'function_definition') {
        visitFunctionDefinition(node, moduleOwnerName(file), 'public');
        return;
      }
      if (node.type === 'declaration' || node.type === 'field_declaration') {
        visitMember(node, moduleOwnerName(file), 'public');
      }
    };

    for (const child of tree.rootNode.namedChildren) {
      visitTop(child);
    }

    // A class's fields live in its header, so an implementation file borrows them for the
    // types it actually implements here. Other headers it includes contribute nothing: only
    // an owner with a method body in this file can have its state explained by this file.
    const implementedOwners = new Set(methodBodies.map((entry) => entry.owner));
    for (const owner of implementedOwners) {
      for (const field of inherited.fields.get(owner) ?? []) {
        const owned = fieldsByOwner.get(owner) ?? new Set<string>();
        fieldsByOwner.set(owner, owned);
        if (owned.has(field.name)) {
          continue;
        }
        owned.add(field.name);
        symbols.push(field);
      }
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
            CPP_ACCESS,
            entry.scope,
          ),
        );
      }
    }

    // A method declared only in the header is still a provable call target from here.
    const declared = new Set([
      ...symbols.filter((symbol) => symbol.kind === 'method').map((symbol) => symbol.name),
      ...inherited.methods,
    ]);
    const types = new Set([
      ...symbols.filter((symbol) => symbol.kind === 'type').map((symbol) => symbol.name),
      ...inherited.types,
    ]);
    const calls = methodBodies.flatMap((entry) =>
      collectFunctionCalls(entry.body, declared, types, entry.owner, entry.method, CPP_CALLS),
    );
    markRecursive(symbols, calls);
    markEntries(symbols, content);

    return { symbols: sortSymbols(symbols), diagnostics, accesses, calls };
  });
}

const TYPE_SPECIFIERS = new Set(['class_specifier', 'struct_specifier', 'union_specifier']);

interface InheritedDeclarations {
  /** Fields per owning type, already carrying the header they were declared in. */
  fields: Map<string, CodeSymbol[]>;
  methods: Set<string>;
  types: Set<string>;
}

const NO_INHERITANCE: InheritedDeclarations = {
  fields: new Map(),
  methods: new Set(),
  types: new Set(),
};

/**
 * Read the declarations a file's own headers provide.
 *
 * Each header is extracted the same way any C++ file is, without a context of its own, so
 * the walk is one level deep: a header's headers are the caller's to supply if they matter.
 */
async function inheritedDeclarations(
  related: ReadonlyMap<string, string> | undefined,
): Promise<InheritedDeclarations> {
  if (!related || related.size === 0) {
    return NO_INHERITANCE;
  }
  const fields = new Map<string, CodeSymbol[]>();
  const methods = new Set<string>();
  const types = new Set<string>();

  for (const [path, source] of related) {
    const { symbols } = await extractCppSymbols(path, source);
    for (const symbol of symbols) {
      if (symbol.kind === 'method') {
        methods.add(symbol.name);
        continue;
      }
      if (symbol.kind === 'type') {
        types.add(symbol.name);
        continue;
      }
      if (symbol.kind !== 'field' || symbol.owner === '') {
        continue;
      }
      const owned = fields.get(symbol.owner) ?? [];
      fields.set(symbol.owner, owned);
      owned.push({ ...symbol, declaredIn: symbol.declaredIn ?? path });
    }
  }
  return { fields, methods, types };
}

function methodSymbol(
  node: Node,
  declarator: Node,
  owner: string,
  access: string,
): CodeSymbol | null {
  const target = declarator.childForFieldName('declarator');
  const segments = target ? qualifiedSegments(target) : [];
  const name = segments[segments.length - 1];
  if (!name) {
    return null;
  }
  const parameters = declarator.childForFieldName('parameters');
  return {
    name,
    kind: 'method',
    visibility: access,
    owner,
    type: node.childForFieldName('type')?.text,
    parameters:
      parameters?.namedChildren.filter((child) => child.type === 'parameter_declaration').length ??
      0,
    line: node.startPosition.row + 1,
  };
}

/** Flatten `acme::Widget::render` into its segments, innermost last. */
function qualifiedSegments(node: Node): string[] {
  if (node.type === 'qualified_identifier') {
    const scope = node.childForFieldName('scope')?.text;
    const name = node.childForFieldName('name');
    return [...(scope ? [scope] : []), ...(name ? qualifiedSegments(name) : [])];
  }
  const name = innermostName(node);
  return name ? [name] : [];
}

/** Unwrap pointer, reference, and array declarators down to the declared name. */
function innermostName(node: Node | null | undefined): string | null {
  if (!node) {
    return null;
  }
  if (
    node.type === 'identifier' ||
    node.type === 'field_identifier' ||
    node.type === 'type_identifier' ||
    node.type === 'destructor_name' ||
    node.type === 'operator_name'
  ) {
    return node.text;
  }
  const inner = node.childForFieldName('declarator');
  return inner ? innermostName(inner) : null;
}

/** The owner shared by a file's free functions, e.g. `widget` for `src/widget.cpp`. */
function moduleOwnerName(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.indexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

const CPP_FUNCTION_RULES: FunctionRules = {
  controlFlowTypes: new Set([
    'if_statement',
    'for_statement',
    'for_range_loop',
    'while_statement',
    'do_statement',
    'switch_statement',
    'try_statement',
    'catch_clause',
  ]),
  loopTypes: new Set(['for_statement', 'for_range_loop', 'while_statement', 'do_statement']),
  decisionNodeTypes: new Set([
    'if_statement',
    'for_statement',
    'for_range_loop',
    'while_statement',
    'do_statement',
    'case_statement',
    'catch_clause',
    'conditional_expression',
  ]),
  decisionOperators: new Set(['&&', '||']),
  callTypes: new Set(['call_expression']),
  callTargetName: (node) => {
    const fn = node.childForFieldName('function');
    if (!fn) {
      return null;
    }
    if (fn.type === 'field_expression') {
      return fn.childForFieldName('field')?.text ?? null;
    }
    if (fn.type === 'qualified_identifier') {
      const segments = qualifiedSegments(fn);
      return segments[segments.length - 1] ?? null;
    }
    return fn.type === 'identifier' ? fn.text : null;
  },
  linearScanCalls: new Set(['find', 'count', 'contains', 'find_if']),
  sortCalls: new Set(['sort', 'stable_sort', 'partial_sort']),
  statementTypes: new Set([
    'declaration',
    'expression_statement',
    'return_statement',
    'break_statement',
    'continue_statement',
    'goto_statement',
    'throw_statement',
    'if_statement',
    'for_statement',
    'for_range_loop',
    'while_statement',
    'do_statement',
    'switch_statement',
    'try_statement',
    'labeled_statement',
  ]),
  nestedFunctionTypes: new Set([
    'function_definition',
    'lambda_expression',
    'class_specifier',
    'struct_specifier',
  ]),
};

const CPP_CALLS: CallRules = {
  callTypes: new Set(['call_expression']),
  callTarget: (node) => {
    const fn = node.childForFieldName('function');
    if (!fn) {
      return null;
    }
    if (fn.type === 'identifier') {
      return { name: fn.text, kind: 'bare' };
    }
    if (fn.type === 'field_expression') {
      const argument = fn.childForFieldName('argument');
      const field = fn.childForFieldName('field');
      if (!argument || !field) {
        return null;
      }
      // `this->x()` proves its target; `other.x()` does not, because the receiver's type
      // is not known here.
      if (argument.type === 'this' || argument.text === 'this') {
        return { name: field.text, kind: 'self', receiver: 'this' };
      }
      return null;
    }
    if (fn.type === 'qualified_identifier') {
      const segments = qualifiedSegments(fn);
      const name = segments[segments.length - 1];
      const scope = segments[segments.length - 2];
      if (name && scope && looksLikeTypeName(scope)) {
        return { name, kind: 'type-qualified', receiver: scope };
      }
      return null;
    }
    return null;
  },
};

const CPP_ACCESS: AccessRules = {
  identifierTypes: new Set(['identifier', 'field_identifier']),
  assignmentTypes: new Set(['assignment_expression', 'update_expression']),
  selfAccess: (node) => {
    if (node.type !== 'field_expression') {
      return null;
    }
    const argument = node.childForFieldName('argument');
    if (!argument || (argument.type !== 'this' && argument.text !== 'this')) {
      return null;
    }
    const field = node.childForFieldName('field');
    return field ? { field: field.text, fieldNode: field } : null;
  },
  declaredNames: (body) =>
    collectDeclaredIdentifiers(body, (node) => {
      if (
        node.type === 'parameter_declaration' ||
        node.type === 'optional_parameter_declaration' ||
        node.type === 'init_declarator'
      ) {
        return innermostName(node.childForFieldName('declarator'));
      }
      if (node.type === 'declaration') {
        return innermostName(node.childForFieldName('declarator'));
      }
      return null;
    }),
};
