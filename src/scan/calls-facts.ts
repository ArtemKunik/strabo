import type { Node } from 'web-tree-sitter';

import { TYPESCRIPT_SUPER_TYPES } from './languages/typescript.ts';
import { collectSuperTypes, walkNodes, type SuperType } from './languages/symbols.ts';

export interface ImportBinding {
  /** The specifier as authored, e.g. `./util` or `@/lib`. */
  source: string;
  /** The exported name the local binding reads: a name, or `default` / `*`. */
  imported: string;
  kind: 'named' | 'default' | 'namespace';
}

export interface CallSite {
  /** The callee name as authored: `foo` for `foo()`, `foo` for `ns.foo()`. */
  name: string;
  /** The full call as authored, kept as edge evidence: `foo` or `ns.foo`. */
  specifier: string;
  /** The receiver for a member call; absent for a bare call. */
  receiver?: string;
  line: number;
}

export interface FileFacts {
  imports: Map<string, ImportBinding>;
  /** Type-only imports (`import type`, `import { type X }`), for inheritance resolution. */
  typeImports: Map<string, ImportBinding>;
  /** Exported names that name a function and can therefore be a call target. */
  callableExports: Set<string>;
  /** Exported names that name a class, interface, enum, or type alias. */
  typeExports: Set<string>;
  /** True when the file has a default-exported type (`export default class …`). */
  defaultType: boolean;
  /** Supertypes the file's classes and interfaces name, de-duplicated across the file. */
  supertypes: SuperType[];
  calls: CallSite[];
}

export function collectFacts(root: Node): FileFacts {
  const imports = new Map<string, ImportBinding>();
  const typeImports = new Map<string, ImportBinding>();
  const callableExports = new Set<string>();
  const typeExports = new Set<string>();
  const supertypes: SuperType[] = [];
  const calls: CallSite[] = [];
  let defaultType = false;

  for (const statement of root.namedChildren) {
    if (statement.type === 'import_statement') {
      collectImports(statement, imports, typeImports);
    } else if (statement.type === 'export_statement') {
      collectExports(statement, callableExports);
      const markedDefault = collectTypeExports(statement, typeExports);
      defaultType ||= markedDefault;
    }
  }

  walkNodes(root, (node) => {
    if (node.type === 'call_expression') {
      const site = callSiteOf(node);
      if (site) {
        calls.push(site);
      }
      return;
    }
    if (TYPESCRIPT_TYPE_DECLARATIONS.has(node.type) || node.type === 'class') {
      supertypes.push(...collectSuperTypes(node, TYPESCRIPT_SUPER_TYPES));
    }
  });

  return { imports, typeImports, callableExports, typeExports, defaultType, supertypes, calls };
}

/** Type-declaration node types that can carry a supertype clause. */
const TYPESCRIPT_TYPE_DECLARATIONS = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
]);

/**
 * Record the local bindings an import statement introduces.
 *
 * `import type` and `import { type X }` are erased at runtime, so a call to them cannot
 * happen and they stay out of `imports`; they are recorded in `typeImports` instead, because
 * a type-only binding still proves an `extends`/`implements` target. `import { a as b }` binds
 * `b` to the exported name `a`; a default import binds `default`; `import * as ns` binds a
 * namespace.
 */
function collectImports(
  statement: Node,
  imports: Map<string, ImportBinding>,
  typeImports: Map<string, ImportBinding>,
): void {
  const statementTypeOnly = hasToken(statement, 'type');
  const source = stringLiteral(statement.childForFieldName('source'));
  if (source === null) {
    return;
  }
  const clause = statement.namedChildren.find((child) => child.type === 'import_clause');
  if (!clause) {
    return;
  }
  const bind = (local: string, binding: ImportBinding, specifierTypeOnly = false): void => {
    const target = statementTypeOnly || specifierTypeOnly ? typeImports : imports;
    target.set(local, binding);
  };
  for (const child of clause.namedChildren) {
    if (child.type === 'identifier') {
      bind(child.text, { source, imported: 'default', kind: 'default' });
      continue;
    }
    if (child.type === 'namespace_import') {
      const name = child.namedChildren.find((node) => node.type === 'identifier');
      if (name) {
        bind(name.text, { source, imported: '*', kind: 'namespace' });
      }
      continue;
    }
    if (child.type !== 'named_imports') {
      continue;
    }
    for (const specifier of child.namedChildren) {
      if (specifier.type !== 'import_specifier') {
        continue;
      }
      const imported = specifier.childForFieldName('name')?.text;
      const local = specifier.childForFieldName('alias')?.text ?? imported;
      if (imported && local) {
        bind(local, { source, imported, kind: 'named' }, hasToken(specifier, 'type'));
      }
    }
  }
}

/**
 * Record the names this file exports that name a function.
 *
 * A re-export (`export { a } from './x'`) forwards a declaration that lives in another file,
 * so the name is not a call target here: a call to it must resolve to the declaring file, not
 * to the forwarder, and following the chain is left for a later pass.
 */
function collectExports(statement: Node, callableExports: Set<string>): void {
  if (statement.childForFieldName('source')) {
    return;
  }
  // `export type { X }` re-exports a type; a type is not callable and not a call target.
  if (hasToken(statement, 'type')) {
    return;
  }
  if (hasToken(statement, 'default')) {
    callableExports.add('default');
    return;
  }
  const declaration = statement.childForFieldName('declaration');
  if (declaration) {
    for (const name of declaredFunctionNames(declaration)) {
      callableExports.add(name);
    }
    return;
  }
  const clause = statement.namedChildren.find((child) => child.type === 'export_clause');
  if (!clause) {
    return;
  }
  for (const specifier of clause.namedChildren) {
    if (specifier.type !== 'export_specifier' || hasToken(specifier, 'type')) {
      continue;
    }
    const exported =
      specifier.childForFieldName('alias')?.text ?? specifier.childForFieldName('name')?.text;
    if (exported) {
      callableExports.add(exported);
    }
  }
}

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function']);

/** Names a declaration exports that are callable functions, not classes or data. */
function declaredFunctionNames(declaration: Node): string[] {
  if (declaration.type === 'function_declaration' || declaration.type === 'generator_function_declaration') {
    const name = declaration.childForFieldName('name')?.text;
    return name ? [name] : [];
  }
  if (declaration.type !== 'lexical_declaration' && declaration.type !== 'variable_declaration') {
    return [];
  }
  const names: string[] = [];
  for (const declarator of declaration.namedChildren) {
    if (declarator.type !== 'variable_declarator') {
      continue;
    }
    const value = declarator.childForFieldName('value');
    if (!value || !FUNCTION_VALUES.has(value.type)) {
      continue;
    }
    const name = declarator.childForFieldName('name')?.text;
    if (name) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Record the names this file exports that name a type (class, interface, enum, or alias).
 *
 * Only a local declaration or an `export { … }` clause counts: a re-export (`export … from`)
 * forwards a name declared elsewhere, so the inheritance pass must resolve through the
 * forwarder's own import rather than claim the original file here. Returns true when the
 * statement is a default export of a type, so a default import can match it.
 */
function collectTypeExports(statement: Node, typeExports: Set<string>): boolean {
  if (statement.childForFieldName('source')) {
    return false;
  }
  if (hasToken(statement, 'default')) {
    const declaration = statement.childForFieldName('declaration');
    const name = declaration?.childForFieldName('name')?.text;
    if (name) {
      typeExports.add(name);
    }
    return true;
  }
  const declaration = statement.childForFieldName('declaration');
  if (declaration) {
    for (const name of declaredTypeNames(declaration)) {
      typeExports.add(name);
    }
    return false;
  }
  const clause = statement.namedChildren.find((child) => child.type === 'export_clause');
  if (!clause) {
    return false;
  }
  for (const specifier of clause.namedChildren) {
    if (specifier.type !== 'export_specifier') {
      continue;
    }
    const exported =
      specifier.childForFieldName('alias')?.text ?? specifier.childForFieldName('name')?.text;
    if (exported) {
      typeExports.add(exported);
    }
  }
  return false;
}

const TYPE_DECLARATION_NODES = new Set([
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'enum_declaration',
  'type_alias_declaration',
]);

/** Names a type declaration introduces, which an `export` of it makes importable. */
function declaredTypeNames(declaration: Node): string[] {
  if (!TYPE_DECLARATION_NODES.has(declaration.type)) {
    return [];
  }
  const name = declaration.childForFieldName('name')?.text;
  return name ? [name] : [];
}

/** The callee of a call the syntax proves: a bare name or `identifier.property`. */
function callSiteOf(node: Node): CallSite | null {
  const fn = node.childForFieldName('function');
  if (!fn) {
    return null;
  }
  if (fn.type === 'identifier') {
    return { name: fn.text, specifier: fn.text, line: node.startPosition.row + 1 };
  }
  if (fn.type !== 'member_expression') {
    return null;
  }
  const object = fn.childForFieldName('object');
  const property = fn.childForFieldName('property');
  if (!object || !property || property.type !== 'property_identifier' || object.type !== 'identifier') {
    return null;
  }
  return {
    name: property.text,
    specifier: `${object.text}.${property.text}`,
    receiver: object.text,
    line: node.startPosition.row + 1,
  };
}

export function isJavaScriptLike(file: string): boolean {
  return /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(file);
}

/** The unquoted text of a string-literal node, or null for any other node. */
function stringLiteral(node: Node | null | undefined): string | null {
  if (!node || node.type !== 'string') {
    return null;
  }
  const text = node.text;
  const quote = text[0];
  if ((quote === '"' || quote === "'") && text.length >= 2 && text.endsWith(quote)) {
    return text.slice(1, -1);
  }
  return null;
}

function hasToken(node: Node, token: string): boolean {
  return node.children.some((child) => !child.isNamed && child.type === token);
}
