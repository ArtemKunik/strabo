import type { Node } from 'web-tree-sitter';

import type { Diagnostic, EdgeEvidence, GraphEdge } from '../../types.ts';
import { collectFunctionMetrics, type FunctionRules } from './function-metrics.ts';
import { addNamespacePrefixes, looksInternal } from './namespace.ts';
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

export const JAVA_LANGUAGE: GrammarLanguage = 'java';

export interface JavaImport {
  /** Fully-qualified type, or package for a wildcard import. */
  name: string;
  static: boolean;
  wildcard: boolean;
  line: number;
}

export interface JavaTypeDeclaration {
  name: string;
  line: number;
}

/** A type used in the file body, whether or not it was imported. */
export interface JavaTypeReference {
  name: string;
  line: number;
}

export interface JavaFileFacts {
  file: string;
  package: string;
  imports: JavaImport[];
  types: JavaTypeDeclaration[];
  typeReferences: JavaTypeReference[];
}

export interface JavaExtraction {
  facts: JavaFileFacts;
  diagnostics: Diagnostic[];
}

const IMPORT_PATTERN = /^import\s+(static\s+)?([\w.$]+?)(\.\*)?\s*;/;
const TYPE_DECLARATIONS = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration',
]);

/** Parse one Java file into package, imports, and declared types. */
export async function extractJavaFacts(file: string, content: string): Promise<JavaExtraction> {
  return withParser(JAVA_LANGUAGE, (parser) => {
    const diagnostics: Diagnostic[] = [];
    const empty: JavaFileFacts = { file, package: '', imports: [], types: [], typeReferences: [] };

    const tree = parser.parse(content);
    if (!tree) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'error',
        kind: 'parse-failure',
        message: 'Java parser returned no tree for this file.',
      });
      return { facts: empty, diagnostics };
    }

    const facts: JavaFileFacts = { file, package: '', imports: [], types: [], typeReferences: [] };

    for (const node of tree.rootNode.namedChildren) {
      switch (node.type) {
        case 'package_declaration':
          facts.package = nodeText(node, 'scoped_identifier') ?? nodeText(node, 'identifier') ?? '';
          break;
        case 'import_declaration':
          collectImport(node, facts.imports);
          break;
        default:
          if (TYPE_DECLARATIONS.has(node.type)) {
            collectTypes(node, '', facts.types);
          }
      }
    }

    const references: JavaTypeReference[] = [];
    collectTypeReferences(tree.rootNode, references);
    facts.typeReferences = dedupeReferences(references);

    if (tree.rootNode.hasError) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'warning',
        kind: 'parse-failure',
        message: 'Java source contains syntax errors; extracted facts may be incomplete.',
      });
    }

    return { facts, diagnostics };
  });
}

function collectImport(node: Node, imports: JavaImport[]): void {
  const match = IMPORT_PATTERN.exec(node.text);
  if (!match) {
    return;
  }
  imports.push({
    name: match[2] ?? '',
    static: Boolean(match[1]),
    wildcard: Boolean(match[3]),
    line: node.startPosition.row + 1,
  });
}

/**
 * Collect a type and its nested types using dotted names (`Outer.Inner`), so an import
 * of a nested type can resolve to the file that declares it.
 *
 * Descent continues through wrapper nodes such as `class_body`, because nested type
 * declarations are not direct children of the enclosing declaration.
 */
function collectTypes(node: Node, prefix: string, out: JavaTypeDeclaration[]): void {
  let nextPrefix = prefix;
  if (TYPE_DECLARATIONS.has(node.type)) {
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

function nodeText(node: Node, type: string): string | null {
  return node.namedChildren.find((child) => child.type === type)?.text ?? null;
}

/**
 * Collect simple type names used in the file body.
 *
 * A qualified use (`com.acme.util.Helper`) contributes only its last segment, so
 * intermediate package segments are never mistaken for type references.
 */
function collectTypeReferences(node: Node, out: JavaTypeReference[]): void {
  if (node.type === 'scoped_type_identifier') {
    const last = lastTypeIdentifier(node);
    if (last) {
      out.push({ name: last.text, line: last.startPosition.row + 1 });
    }
    return;
  }
  if (node.type === 'type_identifier') {
    out.push({ name: node.text, line: node.startPosition.row + 1 });
    return;
  }
  for (const child of node.namedChildren) {
    collectTypeReferences(child, out);
  }
}

function lastTypeIdentifier(node: Node): Node | null {
  let found: Node | null = null;
  const walk = (current: Node): void => {
    if (current.type === 'type_identifier') {
      found = current;
      return;
    }
    for (const child of current.namedChildren) {
      walk(child);
    }
  };
  walk(node);
  return found;
}

function dedupeReferences(references: JavaTypeReference[]): JavaTypeReference[] {
  const byName = new Map<string, JavaTypeReference>();
  for (const reference of references) {
    if (!byName.has(reference.name)) {
      byName.set(reference.name, reference);
    }
  }
  return [...byName.values()];
}

interface JavaIndex {
  qualifiedTypes: Map<string, string>;
  packages: Map<string, Set<string>>;
  /** Every package and all of its prefixes, e.g. `a`, `a.b` for package `a.b.c`. */
  namespaces: Set<string>;
  /** Simple type name -> declaring files, scoped per package, for same-package references. */
  simpleTypesByPackage: Map<string, Map<string, Set<string>>>;
}

function buildIndex(facts: JavaFileFacts[]): JavaIndex {
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

    const simpleTypes = simpleTypesByPackage.get(fileFacts.package) ?? new Map<string, Set<string>>();
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

export interface JavaResolution {
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

/**
 * Resolve Java imports to repository files.
 *
 * A file is only an edge when the reference resolves inside the repository. Imports
 * whose root package does not exist in the repository are treated as external (e.g.
 * `java.util.List`); imports that look internal but do not resolve become diagnostics
 * rather than speculative edges.
 */
export function resolveJava(facts: JavaFileFacts[]): JavaResolution {
  const index = buildIndex(facts);
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
    edges.push({
      source,
      target,
      kind: 'package',
      evidence: { line, specifier, resolution },
    });
  };

  const looksLikeInternalImport = (name: string): boolean => looksInternal(name, index.namespaces);
  const pairs = new Set<string>();
  const importedSimpleNames = new Map<string, Set<string>>();

  for (const fileFacts of facts) {
    const imported = importedSimpleNames.get(fileFacts.file) ?? new Set<string>();
    importedSimpleNames.set(fileFacts.file, imported);

    for (const reference of fileFacts.imports) {
      if (reference.wildcard) {
        const members = index.packages.get(reference.name);
        if (members && members.size > 0) {
          for (const target of [...members].sort()) {
            pushEdge(fileFacts.file, target, reference.line, `${reference.name}.*`, 'index-of-package');
            pairs.add(`${fileFacts.file}\u0000${target}`);
          }
        } else if (looksLikeInternalImport(reference.name)) {
          diagnostics.push(unresolved(fileFacts.file, reference, reference.name));
        }
        continue;
      }

      if (!reference.static) {
        imported.add(reference.name.slice(reference.name.lastIndexOf('.') + 1));
      }
      const candidates = reference.static
        ? [reference.name, reference.name.slice(0, reference.name.lastIndexOf('.'))]
        : [reference.name];
      const target = candidates.map((candidate) => index.qualifiedTypes.get(candidate)).find(Boolean);
      if (target) {
        pushEdge(fileFacts.file, target, reference.line, reference.name, 'exact');
        pairs.add(`${fileFacts.file}\u0000${target}`);
        continue;
      }
      if (looksLikeInternalImport(reference.name)) {
        diagnostics.push(unresolved(fileFacts.file, reference, reference.name));
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

    for (const reference of fileFacts.typeReferences ?? []) {
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
      pushEdge(fileFacts.file, target, reference.line, reference.name, 'index-of-package');
      pairs.add(`${fileFacts.file}\u0000${target}`);
    }
  }

  return { edges, diagnostics };
}

function unresolved(file: string, reference: JavaImport, specifier: string): Diagnostic {
  return {
    file,
    line: reference.line,
    severity: 'warning',
    kind: 'unresolved',
    specifier,
    message: `Java import "${specifier}" does not resolve to a file inside the repository.`,
  };
}

/** Extract declared types, fields, and methods with visibility and owner. */
export async function extractJavaSymbols(
  file: string,
  content: string,
): Promise<SymbolExtraction> {
  return withParser(JAVA_LANGUAGE, (parser) => {
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
        message: 'Java parser returned no tree for this file.',
      });
      return { symbols, diagnostics };
    }

    const visit = (node: Node, owner: string): void => {
      if (TYPE_DECLARATIONS.has(node.type)) {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          symbols.push({
            name,
            kind: 'type',
            visibility: javaVisibility(node),
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
        const type = node.childForFieldName('type')?.text;
        const modifiers = node.namedChildren.find((child) => child.type === 'modifiers')?.text ?? '';
        const mutable = !/\bfinal\b/.test(modifiers);
        for (const declarator of node.namedChildren) {
          if (declarator.type !== 'variable_declarator') {
            continue;
          }
          const name = declarator.childForFieldName('name')?.text;
          if (name) {
            symbols.push({
              name,
              kind: 'field',
              visibility: javaVisibility(node),
              owner,
              type,
              mutable,
              line: declarator.startPosition.row + 1,
            });
            const ownerFields = fieldsByOwner.get(owner) ?? new Set<string>();
            fieldsByOwner.set(owner, ownerFields);
            ownerFields.add(name);
          }
        }
        return;
      }

      if (node.type === 'method_declaration' || node.type === 'constructor_declaration') {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          const parameters = node.childForFieldName('parameters');
          symbols.push({
            name,
            kind: 'method',
            visibility: javaVisibility(node),
            owner,
            type: node.childForFieldName('type')?.text,
            parameters:
              parameters?.namedChildren.filter((child) => child.type === 'formal_parameter')
                .length ?? 0,
            line: node.startPosition.row + 1,
          });
          const body = node.childForFieldName('body');
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
            JAVA_ACCESS,
            entry.scope,
          ),
        );
      }
    }

    return { symbols: sortSymbols(symbols), diagnostics, accesses };
  });
}

const JAVA_ACCESS: AccessRules = {
  identifierTypes: new Set(['identifier']),
  assignmentTypes: new Set(['assignment_expression', 'update_expression']),
  selfAccess: (node) => {
    if (node.type !== 'field_access') {
      return null;
    }
    const object = node.childForFieldName('object');
    if (!object || (object.type !== 'this' && object.text !== 'this')) {
      return null;
    }
    const field = node.childForFieldName('field');
    return field ? { field: field.text, fieldNode: field } : null;
  },
  declaredNames: (body) =>
    collectDeclaredIdentifiers(body, (node) => {
      if (
        node.type === 'variable_declarator' ||
        node.type === 'formal_parameter' ||
        node.type === 'catch_formal_parameter' ||
        node.type === 'spread_parameter' ||
        node.type === 'inferred_parameter' ||
        node.type === 'enhanced_for_statement'
      ) {
        return node.childForFieldName('name')?.text ?? null;
      }
      return null;
    }),
};

function javaVisibility(node: Node): string {
  const modifiers = node.namedChildren.find((child) => child.type === 'modifiers')?.text ?? '';
  if (/\bpublic\b/.test(modifiers)) return 'public';
  if (/\bprivate\b/.test(modifiers)) return 'private';
  if (/\bprotected\b/.test(modifiers)) return 'protected';
  return 'package';
}
