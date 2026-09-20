import type { Diagnostic, GraphEdge } from '../../types.ts';
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
  sortSymbols,
} from './symbols.ts';

export const CSHARP_LANGUAGE: GrammarLanguage = 'c_sharp';

export interface CSharpUsing {
  kind: 'simple' | 'static' | 'alias';
  /** Dotted namespace (simple) or fully-qualified type (static/alias). */
  target: string;
  line: number;
}

export interface CSharpTypeDeclaration {
  name: string;
  line: number;
}

/** A type used in the file body, whether or not it was imported. */
export interface CSharpTypeReference {
  name: string;
  line: number;
}

export interface CSharpFileFacts {
  file: string;
  namespace: string;
  usings: CSharpUsing[];
  types: CSharpTypeDeclaration[];
  typeReferences: CSharpTypeReference[];
}

export interface CSharpExtraction {
  facts: CSharpFileFacts;
  diagnostics: Diagnostic[];
}

const USING_PATTERN = /^(?:global\s+)?using\s+(?:(static)\s+)?(?:([A-Za-z_]\w*)\s*=\s*)?([\w.]+)\s*;/;
const NAMESPACE_PATTERN = /^namespace\s+([\w.]+)/;

const CSHARP_TYPE_DECLARATIONS = new Set([
  'class_declaration',
  'interface_declaration',
  'struct_declaration',
  'enum_declaration',
  'record_declaration',
  'delegate_declaration',
]);

/** Parse one C# file into its namespace, `using` directives, and declared types. */
export async function extractCSharpFacts(file: string, content: string): Promise<CSharpExtraction> {
  return withParser(CSHARP_LANGUAGE, (parser) => {
    const facts: CSharpFileFacts = {
      file,
      namespace: '',
      usings: [],
      types: [],
      typeReferences: [],
    };
    const diagnostics: Diagnostic[] = [];

    const tree = parser.parse(content);
    if (!tree) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'error',
        kind: 'parse-failure',
        message: 'C# parser returned no tree for this file.',
      });
      return { facts, diagnostics };
    }

    facts.namespace = findNamespace(tree.rootNode);
    for (const node of walk(tree.rootNode)) {
      if (node.type === 'using_directive') {
        const reference = parseUsing(node.text, node.startPosition.row + 1);
        if (reference) {
          facts.usings.push(reference);
        }
      }
    }
    collectTypes(tree.rootNode, '', facts.types);
    const references: CSharpTypeReference[] = [];
    collectTypeReferences(tree.rootNode, references);
    facts.typeReferences = dedupeReferences(references);

    if (tree.rootNode.hasError) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'warning',
        kind: 'parse-failure',
        message: 'C# source contains syntax errors; extracted facts may be incomplete.',
      });
    }

    return { facts, diagnostics };
  });
}

function findNamespace(root: import('web-tree-sitter').Node): string {
  for (const node of walk(root)) {
    if (
      node.type === 'file_scoped_namespace_declaration' ||
      node.type === 'namespace_declaration'
    ) {
      const name = node.childForFieldName('name');
      if (name) {
        return name.text;
      }
      const match = NAMESPACE_PATTERN.exec(node.text);
      if (match) {
        return match[1] as string;
      }
    }
  }
  return '';
}

function parseUsing(text: string, line: number): CSharpUsing | null {
  const match = USING_PATTERN.exec(text.trim());
  if (!match) {
    return null;
  }
  const target = match[3] as string;
  if (match[1]) {
    return { kind: 'static', target, line };
  }
  if (match[2]) {
    return { kind: 'alias', target, line };
  }
  return { kind: 'simple', target, line };
}

/** Collect a type and its nested types with dotted names (`Outer.Inner`). */
function collectTypes(
  node: import('web-tree-sitter').Node,
  prefix: string,
  out: CSharpTypeDeclaration[],
): void {
  let nextPrefix = prefix;
  if (CSHARP_TYPE_DECLARATIONS.has(node.type)) {
    const name = node.childForFieldName('name');
    if (name) {
      const full = prefix ? `${prefix}.${name.text}` : name.text;
      out.push({ name: full, line: node.startPosition.row + 1 });
      nextPrefix = full;
    }
  }
  for (const child of node.namedChildren) {
    collectTypes(child, nextPrefix, out);
  }
}

function* walk(node: import('web-tree-sitter').Node): Generator<import('web-tree-sitter').Node> {
  yield node;
  for (const child of node.namedChildren) {
    yield* walk(child);
  }
}

/** Collect simple type names from type positions (`type:` fields, base lists, generics). */
function collectTypeReferences(node: import('web-tree-sitter').Node, out: CSharpTypeReference[]): void {
  const typeNode = node.childForFieldName('type');
  if (typeNode) {
    addTypeNames(typeNode, out);
  }
  if (node.type === 'base_list') {
    for (const child of node.namedChildren) {
      addTypeNames(child, out);
    }
  }
  // Generic method invocations (`UseStartup<Startup>()`) carry type arguments that are
  // not reachable from a `type:` field.
  if (node.type === 'generic_name') {
    addTypeNames(node, out);
  }
  for (const child of node.namedChildren) {
    collectTypeReferences(child, out);
  }
}

function addTypeNames(node: import('web-tree-sitter').Node, out: CSharpTypeReference[]): void {
  switch (node.type) {
    case 'predefined_type':
      return;
    case 'identifier':
      out.push({ name: node.text, line: node.startPosition.row + 1 });
      return;
    case 'qualified_name': {
      const name = node.childForFieldName('name');
      if (name) {
        out.push({ name: name.text, line: node.startPosition.row + 1 });
      }
      return;
    }
    case 'generic_name': {
      const base = node.namedChildren.find((child) => child.type === 'identifier');
      if (base) {
        out.push({ name: base.text, line: base.startPosition.row + 1 });
      }
      for (const child of node.namedChildren) {
        if (child.type === 'type_argument_list') {
          for (const argument of child.namedChildren) {
            addTypeNames(argument, out);
          }
        }
      }
      return;
    }
    default:
      for (const child of node.namedChildren) {
        addTypeNames(child, out);
      }
  }
}

function dedupeReferences(references: CSharpTypeReference[]): CSharpTypeReference[] {
  const byName = new Map<string, CSharpTypeReference>();
  for (const reference of references) {
    if (!byName.has(reference.name)) {
      byName.set(reference.name, reference);
    }
  }
  return [...byName.values()];
}

interface CSharpIndex {
  qualifiedTypes: Map<string, string>;
  membersByNamespace: Map<string, Set<string>>;
  namespaces: Set<string>;
  /** Simple type name -> declaring files, scoped per namespace. */
  simpleTypesByNamespace: Map<string, Map<string, Set<string>>>;
}

function buildIndex(facts: CSharpFileFacts[]): CSharpIndex {
  const qualifiedTypes = new Map<string, string>();
  const membersByNamespace = new Map<string, Set<string>>();
  const namespaces = new Set<string>();
  const simpleTypesByNamespace = new Map<string, Map<string, Set<string>>>();

  for (const fileFacts of facts) {
    if (!fileFacts.namespace) {
      continue;
    }
    addNamespacePrefixes(namespaces, fileFacts.namespace);
    const members = membersByNamespace.get(fileFacts.namespace) ?? new Set<string>();
    membersByNamespace.set(fileFacts.namespace, members);
    members.add(fileFacts.file);

    const simpleTypes =
      simpleTypesByNamespace.get(fileFacts.namespace) ?? new Map<string, Set<string>>();
    simpleTypesByNamespace.set(fileFacts.namespace, simpleTypes);

    for (const type of fileFacts.types) {
      qualifiedTypes.set(`${fileFacts.namespace}.${type.name}`, fileFacts.file);
      if (!type.name.includes('.')) {
        const files = simpleTypes.get(type.name) ?? new Set<string>();
        simpleTypes.set(type.name, files);
        files.add(fileFacts.file);
      }
    }
  }

  return { qualifiedTypes, membersByNamespace, namespaces, simpleTypesByNamespace };
}

export interface CSharpResolution {
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

/** Extract declared types, fields, properties, and methods with visibility and owner. */
export async function extractCSharpSymbols(
  file: string,
  content: string,
): Promise<SymbolExtraction> {
  return withParser(CSHARP_LANGUAGE, (parser) => {
    const diagnostics: Diagnostic[] = [];
    const symbols: CodeSymbol[] = [];
    const fieldsByOwner = new Map<string, Set<string>>();
    const methodBodies: Array<{
      owner: string;
      method: string;
      body: import('web-tree-sitter').Node;
      scope: import('web-tree-sitter').Node;
    }> = [];

    const tree = parser.parse(content);
    if (!tree) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'error',
        kind: 'parse-failure',
        message: 'C# parser returned no tree for this file.',
      });
      return { symbols, diagnostics };
    }

    const visit = (node: import('web-tree-sitter').Node, owner: string): void => {
      if (CSHARP_TYPE_DECLARATIONS.has(node.type)) {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          symbols.push({
            name,
            kind: 'type',
            visibility: csharpVisibility(node),
            owner,
            line: node.startPosition.row + 1,
          });
          owner = owner ? `${owner}.${name}` : name;
        }
        for (const child of node.namedChildren) {
          visit(child, owner);
        }
        return;
      }

      if (node.type === 'field_declaration') {
        const declaration = node.namedChildren.find(
          (child) => child.type === 'variable_declaration',
        );
        const type = declaration?.childForFieldName('type')?.text;
        for (const declarator of declaration?.namedChildren ?? []) {
          if (declarator.type !== 'variable_declarator') {
            continue;
          }
          const name = declarator.childForFieldName('name')?.text;
          if (name) {
            symbols.push({
              name,
              kind: 'field',
              visibility: csharpVisibility(node),
              owner,
              type,
              mutable: true,
              line: declarator.startPosition.row + 1,
            });
            const ownerFields = fieldsByOwner.get(owner) ?? new Set<string>();
            fieldsByOwner.set(owner, ownerFields);
            ownerFields.add(name);
          }
        }
        return;
      }

      if (node.type === 'property_declaration') {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          const accessors = node.childForFieldName('accessors')?.text ?? '';
          symbols.push({
            name,
            kind: 'property',
            visibility: csharpVisibility(node),
            owner,
            type: node.childForFieldName('type')?.text,
            mutable: /\bset\b/.test(accessors),
            line: node.startPosition.row + 1,
          });
          const ownerFields = fieldsByOwner.get(owner) ?? new Set<string>();
          fieldsByOwner.set(owner, ownerFields);
          ownerFields.add(name);
        }
        return;
      }

      if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          const parameters = node.childForFieldName('parameters');
          const symbol: CodeSymbol = {
            name,
            kind: 'method',
            visibility: csharpVisibility(node),
            owner,
            type: node.childForFieldName('returns')?.text,
            parameters:
              parameters?.namedChildren.filter((child) => child.type === 'parameter').length ?? 0,
            line: node.startPosition.row + 1,
          };
          const body = node.childForFieldName('body');
          if (body) {
            symbol.metrics = collectFunctionMetrics(body, symbol.line, CSHARP_FUNCTION_RULES);
          }
          symbols.push(symbol);
          if (body && owner) {
            methodBodies.push({ owner, method: name, body, scope: node });
          }
        }
        return;
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
            CSHARP_ACCESS,
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
      collectFunctionCalls(entry.body, declared, types, entry.owner, entry.method, CSHARP_CALLS),
    );
    markRecursive(symbols, calls);

    return { symbols: sortSymbols(symbols), diagnostics, accesses, calls };
  });
}

const CSHARP_FUNCTION_RULES: FunctionRules = {
  controlFlowTypes: new Set([
    'if_statement',
    'foreach_statement',
    'for_statement',
    'while_statement',
    'do_statement',
    'switch_statement',
    'try_statement',
    'catch_clause',
    'using_statement',
    'lock_statement',
    'conditional_expression',
  ]),
  loopTypes: new Set([
    'foreach_statement',
    'for_statement',
    'while_statement',
    'do_statement',
  ]),
  decisionNodeTypes: new Set([
    'if_statement',
    'foreach_statement',
    'for_statement',
    'while_statement',
    'do_statement',
    'switch_section',
    'catch_clause',
    'conditional_expression',
  ]),
  decisionOperators: new Set(['&&', '||', '??']),
  statementTypes: new Set([
    'local_declaration_statement',
    'expression_statement',
    'return_statement',
    'throw_statement',
    'break_statement',
    'continue_statement',
    'yield_statement',
    'if_statement',
    'foreach_statement',
    'for_statement',
    'while_statement',
    'do_statement',
    'switch_statement',
    'try_statement',
    'using_statement',
    'lock_statement',
    'fixed_statement',
    'checked_statement',
    'unchecked_statement',
  ]),
  nestedFunctionTypes: new Set([
    'method_declaration',
    'constructor_declaration',
    'local_function_statement',
    'lambda_expression',
    'anonymous_method_expression',
    'class_declaration',
    'interface_declaration',
    'struct_declaration',
    'record_declaration',
    'enum_declaration',
  ]),
};

const CSHARP_CALLS: CallRules = {
  callTypes: new Set(['invocation_expression']),
  callTarget: (node) => {
    const fn = node.childForFieldName('function');
    if (!fn) {
      return null;
    }
    if (fn.type === 'identifier') {
      return { name: fn.text, kind: 'bare' };
    }
    if (fn.type !== 'member_access_expression') {
      return null;
    }
    const expression = fn.childForFieldName('expression');
    const name = fn.childForFieldName('name');
    if (!expression || !name || name.type !== 'identifier') {
      return null;
    }
    if (expression.type === 'this_expression' || expression.text === 'this') {
      return { name: name.text, kind: 'self', receiver: 'this' };
    }
    if (expression.type === 'identifier' && looksLikeTypeName(expression.text)) {
      return { name: name.text, kind: 'type-qualified', receiver: expression.text };
    }
    return null;
  },
};

const CSHARP_ACCESS: AccessRules = {
  identifierTypes: new Set(['identifier']),
  assignmentTypes: new Set(['assignment_expression', 'update_expression']),
  selfAccess: (node) => {
    if (node.type !== 'member_access_expression') {
      return null;
    }
    const expression = node.childForFieldName('expression');
    if (!expression || (expression.type !== 'this_expression' && expression.text !== 'this')) {
      return null;
    }
    const field = node.childForFieldName('name');
    return field ? { field: field.text, fieldNode: field } : null;
  },
  declaredNames: (body) =>
    collectDeclaredIdentifiers(body, (node) => {
      if (node.type === 'variable_declarator' || node.type === 'parameter') {
        return node.childForFieldName('name')?.text ?? null;
      }
      return null;
    }),
};

function csharpVisibility(node: import('web-tree-sitter').Node): string {
  const modifiers = node.namedChildren
    .filter((child) => child.type === 'modifier')
    .map((child) => child.text);
  for (const candidate of ['public', 'private', 'protected', 'internal']) {
    if (modifiers.includes(candidate)) {
      return candidate;
    }
  }
  return 'private';
}
/**
 * Resolve C# `using` directives to repository files.
 *
 * A namespace import links to every file declaring a type in that namespace; a `static`
 * or alias import links to the declaring type's file. External namespaces such as
 * `System.*` are ignored, and namespaces that look internal but do not resolve become
 * diagnostics.
 */
export function resolveCSharp(facts: CSharpFileFacts[]): CSharpResolution {
  const index = buildIndex(facts);
  const edges: GraphEdge[] = [];
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const pairs = new Set<string>();

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
    edges.push({ source, target, kind: 'namespace', evidence: { line, specifier, resolution } });
  };

  for (const fileFacts of facts) {
    for (const reference of fileFacts.usings) {
      if (reference.kind === 'simple') {
        const members = index.membersByNamespace.get(reference.target);
        if (members && members.size > 0) {
          for (const target of [...members].sort()) {
            push(fileFacts.file, target, reference.line, reference.target, 'index-of-package');
          }
          continue;
        }
      } else {
        const target = index.qualifiedTypes.get(reference.target);
        if (target) {
          push(fileFacts.file, target, reference.line, reference.target, 'exact');
          continue;
        }
      }

      if (looksInternal(reference.target, index.namespaces)) {
        diagnostics.push({
          file: fileFacts.file,
          line: reference.line,
          severity: 'warning',
          kind: 'unresolved',
          specifier: reference.target,
          message: `C# using "${reference.target}" does not resolve to a file inside the repository.`,
        });
      }
    }
  }

  for (const fileFacts of facts) {
    if (!fileFacts.namespace) {
      continue;
    }
    const simpleTypes = index.simpleTypesByNamespace.get(fileFacts.namespace);
    if (!simpleTypes) {
      continue;
    }
    const ownTypes = new Set(
      fileFacts.types.map((type) => type.name.split('.').pop() as string),
    );
    const ambiguous = new Set<string>();

    for (const reference of fileFacts.typeReferences ?? []) {
      if (ownTypes.has(reference.name)) {
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
            message: `Type "${reference.name}" is declared by more than one file in namespace "${fileFacts.namespace}".`,
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

  return { edges, diagnostics };
}
