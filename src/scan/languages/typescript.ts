import type { Node } from 'web-tree-sitter';

import type { Diagnostic } from '../../types.ts';
import { collectFunctionMetrics, type FunctionRules } from './function-metrics.ts';
import type { GrammarLanguage } from './parser-runtime.ts';
import { withParser } from './parser-runtime.ts';
import {
  type AccessRules,
  type CodeSymbol,
  type MemberAccess,
  type SymbolExtraction,
  collectDeclaredIdentifiers,
  collectMemberAccesses,
  sortSymbols,
} from './symbols.ts';

export const TYPESCRIPT_LANGUAGE: GrammarLanguage = 'typescript';
export const TSX_LANGUAGE: GrammarLanguage = 'tsx';

/**
 * Declarations that introduce a named type. Interfaces and type aliases are contracts with
 * no runtime members, but their declared members are still useful, so they are treated like
 * a class body.
 */
const TYPE_DECLARATIONS = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'enum_declaration',
  'type_alias_declaration',
]);

const FUNCTION_DECLARATIONS = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_signature',
]);

/** Bodyless method forms: interface `method_signature` and abstract methods. */
const METHOD_SIGNATURES = new Set(['method_signature', 'abstract_method_signature']);

const PARAMETER_TYPES = new Set(['required_parameter', 'optional_parameter']);

const VARIABLE_DECLARATIONS = new Set(['lexical_declaration', 'variable_declaration']);

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function']);

type MethodBody = { owner: string; method: string; body: Node; scope: Node };

/**
 * Extract members from a TypeScript or JavaScript file with tree-sitter.
 *
 * Classes, interfaces, enums, and type aliases contribute named types; their fields and
 * methods carry the declaring type as `owner`. Top-level declarations (module functions and
 * variables) are grouped under an owner named after the file's base name, so a module that
 * declares no type still has members to show.
 *
 * Extraction is on demand rather than during every scan; edges do not need members.
 */
export async function extractTypeScriptSymbols(
  file: string,
  content: string,
): Promise<SymbolExtraction> {
  return withParser(grammarFor(file), (parser) => {
    const diagnostics: Diagnostic[] = [];
    const symbols: CodeSymbol[] = [];
    const fieldsByOwner = new Map<string, Set<string>>();
    const methodBodies: MethodBody[] = [];
    const seen = new Set<string>();

    const tree = parser.parse(content);
    if (!tree) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'error',
        kind: 'parse-failure',
        message: 'TypeScript parser returned no tree for this file.',
      });
      return { symbols, diagnostics };
    }

    const moduleOwner = moduleName(file);
    const ownerFor = (owner: string): string => owner || moduleOwner;

    const pushSymbol = (symbol: CodeSymbol): boolean => {
      const key = `${symbol.kind}\u0000${symbol.owner}\u0000${symbol.name}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      symbols.push(symbol);
      return true;
    };

    const addField = (field: CodeSymbol): void => {
      if (!pushSymbol(field)) {
        return;
      }
      const ownerFields = fieldsByOwner.get(field.owner) ?? new Set<string>();
      fieldsByOwner.set(field.owner, ownerFields);
      ownerFields.add(field.name);
    };

    const addMethod = (method: CodeSymbol, value: Node): void => {
      const body = value.childForFieldName('body');
      if (body) {
        method.metrics = collectFunctionMetrics(body, method.line, TYPESCRIPT_FUNCTION_RULES);
        methodBodies.push({ owner: method.owner, method: method.name, body, scope: value });
      }
      pushSymbol(method);
    };

    /** Constructor parameter properties (`private readonly dep: Dep`) declare fields. */
    const addParameterProperties = (parameters: Node | null, owner: string): void => {
      if (!parameters) {
        return;
      }
      for (const parameter of parameters.namedChildren) {
        if (!PARAMETER_TYPES.has(parameter.type)) {
          continue;
        }
        const modifier = parameter.namedChildren.find(
          (child) => child.type === 'accessibility_modifier',
        );
        if (!modifier && !hasToken(parameter, 'readonly')) {
          continue;
        }
        const name = simpleName(parameter.childForFieldName('pattern'));
        if (name) {
          addField({
            name,
            kind: 'field',
            visibility: modifier?.text ?? 'public',
            owner,
            type: annotationText(parameter.childForFieldName('type')),
            mutable: !hasToken(parameter, 'readonly'),
            line: parameter.startPosition.row + 1,
          });
        }
      }
    };

    const visit = (node: Node, owner: string): void => {
      if (TYPE_DECLARATIONS.has(node.type) || node.type === 'class') {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          pushSymbol({
            name,
            kind: 'type',
            visibility: visibilityOf(node),
            owner,
            line: node.startPosition.row + 1,
          });
        }
        const nextOwner = name ? (owner ? `${owner}.${name}` : name) : owner;
        for (const child of node.namedChildren) {
          visit(child, nextOwner);
        }
        return;
      }

      // `namespace N {}` and `module N {}` group their declarations under `N`; an ambient
      // `declare module 'x'` has a string name and keeps the enclosing owner.
      if (node.type === 'internal_module' || node.type === 'module') {
        const nameNode = node.childForFieldName('name');
        const name = nameNode?.type === 'identifier' ? nameNode.text : undefined;
        const nextOwner = name ? (owner ? `${owner}.${name}` : name) : owner;
        for (const child of node.namedChildren) {
          visit(child, nextOwner);
        }
        return;
      }

      if (FUNCTION_DECLARATIONS.has(node.type)) {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          addMethod(
            {
              name,
              kind: 'method',
              visibility: visibilityOf(node),
              owner: ownerFor(owner),
              type: annotationText(node.childForFieldName('return_type')),
              parameters: parameterCount(node.childForFieldName('parameters')),
              line: node.startPosition.row + 1,
            },
            node,
          );
        }
        return;
      }

      if (METHOD_SIGNATURES.has(node.type)) {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          pushSymbol({
            name,
            kind: 'method',
            visibility: visibilityOf(node),
            owner: ownerFor(owner),
            type: annotationText(node.childForFieldName('return_type')),
            parameters: parameterCount(node.childForFieldName('parameters')),
            line: node.startPosition.row + 1,
          });
        }
        return;
      }

      if (node.type === 'method_definition') {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          const methodOwner = ownerFor(owner);
          addMethod(
            {
              name,
              kind: 'method',
              visibility: visibilityOf(node, name),
              owner: methodOwner,
              type: annotationText(node.childForFieldName('return_type')),
              parameters: parameterCount(node.childForFieldName('parameters')),
              line: node.startPosition.row + 1,
            },
            node,
          );
          if (name === 'constructor') {
            addParameterProperties(node.childForFieldName('parameters'), methodOwner);
          }
        }
        return;
      }

      if (node.type === 'public_field_definition') {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          addField({
            name,
            kind: 'field',
            visibility: visibilityOf(node, name),
            owner: ownerFor(owner),
            type: annotationText(node.childForFieldName('type')),
            mutable: !hasToken(node, 'readonly'),
            line: node.startPosition.row + 1,
          });
        }
        return;
      }

      if (node.type === 'property_signature') {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          addField({
            name,
            kind: 'field',
            visibility: 'public',
            owner: ownerFor(owner),
            type: annotationText(node.childForFieldName('type')),
            mutable: !hasToken(node, 'readonly'),
            line: node.startPosition.row + 1,
          });
        }
        return;
      }

      if (VARIABLE_DECLARATIONS.has(node.type)) {
        const binding = node.childForFieldName('kind')?.text ?? 'var';
        for (const declarator of node.namedChildren) {
          if (declarator.type !== 'variable_declarator') {
            continue;
          }
          const name = simpleName(declarator.childForFieldName('name'));
          if (!name) {
            continue;
          }
          const value = declarator.childForFieldName('value');
          if (value && FUNCTION_VALUES.has(value.type)) {
            addMethod(
              {
                name,
                kind: 'method',
                visibility: 'public',
                owner: ownerFor(owner),
                type: annotationText(value.childForFieldName('return_type')),
                parameters: parameterCount(value.childForFieldName('parameters')),
                line: declarator.startPosition.row + 1,
              },
              value,
            );
          } else {
            addField({
              name,
              kind: 'field',
              visibility: 'public',
              owner: ownerFor(owner),
              type: annotationText(declarator.childForFieldName('type')),
              mutable: binding !== 'const',
              line: declarator.startPosition.row + 1,
            });
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
            TYPESCRIPT_ACCESS,
            entry.scope,
          ),
        );
      }
    }

    return { symbols: sortSymbols(symbols), diagnostics, accesses };
  });
}

const TYPESCRIPT_FUNCTION_RULES: FunctionRules = {
  controlFlowTypes: new Set([
    'if_statement',
    'switch_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'do_statement',
    'try_statement',
    'catch_clause',
  ]),
  loopTypes: new Set(['for_statement', 'for_in_statement', 'while_statement', 'do_statement']),
  decisionNodeTypes: new Set([
    'if_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'do_statement',
    'switch_case',
    'switch_default',
    'catch_clause',
    'ternary_expression',
  ]),
  decisionOperators: new Set(['&&', '||', '??']),
  statementTypes: new Set([
    'expression_statement',
    'lexical_declaration',
    'variable_declaration',
    'return_statement',
    'throw_statement',
    'break_statement',
    'continue_statement',
    'if_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'do_statement',
    'switch_statement',
    'try_statement',
    'labeled_statement',
    'empty_statement',
  ]),
  nestedFunctionTypes: new Set([
    'function_declaration',
    'generator_function_declaration',
    'function_expression',
    'arrow_function',
    'function',
    'method_definition',
    'class_declaration',
    'abstract_class_declaration',
    'class',
  ]),
};

const TYPESCRIPT_ACCESS: AccessRules = {
  identifierTypes: new Set(['identifier', 'shorthand_property_identifier']),
  assignmentTypes: new Set([
    'assignment_expression',
    'augmented_assignment_expression',
    'update_expression',
  ]),
  selfAccess: (node) => {
    if (node.type !== 'member_expression') {
      return null;
    }
    const object = node.childForFieldName('object');
    if (!object || object.type !== 'this') {
      return null;
    }
    const property = node.childForFieldName('property');
    return property ? { field: property.text, fieldNode: property } : null;
  },
  declaredNames: (scope) =>
    collectDeclaredIdentifiers(scope, (node) => {
      if (PARAMETER_TYPES.has(node.type)) {
        return simpleName(node.childForFieldName('pattern')) ?? null;
      }
      if (node.type === 'variable_declarator') {
        return simpleName(node.childForFieldName('name')) ?? null;
      }
      if (node.type === 'catch_clause') {
        return simpleName(node.childForFieldName('parameter')) ?? null;
      }
      return null;
    }),
};

/** `.tsx` needs the TSX grammar for JSX; every other module extension uses TypeScript. */
function grammarFor(file: string): GrammarLanguage {
  return file.toLowerCase().endsWith('.tsx') ? TSX_LANGUAGE : TYPESCRIPT_LANGUAGE;
}

/** The owner shared by a module's top-level declarations, e.g. `scan` for `src/scan.ts`. */
function moduleName(file: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function annotationText(node: Node | null | undefined): string | undefined {
  if (!node) {
    return undefined;
  }
  const text = node.text.replace(/^:\s*/, '').trim();
  return text || undefined;
}

function visibilityOf(node: Node, name?: string): string {
  const modifier = node.namedChildren.find((child) => child.type === 'accessibility_modifier');
  if (modifier) {
    return modifier.text;
  }
  // A `#private` field carries its privacy in the name, not a modifier.
  return name?.startsWith('#') ? 'private' : 'public';
}

function parameterCount(parameters: Node | null | undefined): number {
  if (!parameters) {
    return 0;
  }
  return parameters.namedChildren.filter((child) => PARAMETER_TYPES.has(child.type)).length;
}

/** A binding name for a simple pattern; destructuring patterns are not modelled. */
function simpleName(node: Node | null | undefined): string | undefined {
  return node?.type === 'identifier' ? node.text : undefined;
}

function hasToken(node: Node, token: string): boolean {
  return node.children.some((child) => !child.isNamed && child.type === token);
}
