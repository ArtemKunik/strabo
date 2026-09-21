import type { Node } from 'web-tree-sitter';

import type { Diagnostic, GraphEdge } from '../types.ts';
import { loadAliasTables, resolveAliased, type AliasTables } from '../resolve/aliases.ts';
import { resolveRelative, type ResolvedReference } from '../resolve/index.ts';
import { withParser } from './languages/parser-runtime.ts';
import { grammarFor } from './languages/typescript.ts';
import { walkNodes } from './languages/symbols.ts';
import { serializeParserWork } from './scan-polyglot.ts';

export interface CallGraphResult {
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

export interface CallGraphOptions {
  /** Repository root for alias discovery; omit to keep purely relative resolution. */
  root?: string;
}

/**
 * Record cross-file function-call edges for JS/TS.
 *
 * Only calls Strabo can prove are recorded. A bare `foo()` where `foo` is a named or default
 * import from `./x`, and `ns.foo()` where `ns` is a namespace import, resolve to `x` when `x`
 * declares and exports that function. A value receiver (`obj.method()`), a dynamic call, a
 * re-exported name, and any receiver whose type is not known are left unclaimed rather than
 * guessed — the same contract as the import edges. A call edge always sits beside an import
 * edge for the same pair, so it adds evidence without changing reachability.
 *
 * Runs one tree-sitter parse per file, serialised with polyglot resolution through the shared
 * parser queue. A missing grammar degrades to no call edges instead of failing the scan.
 */
export function scanJsTsCalls(
  files: readonly string[],
  contentByFile: ReadonlyMap<string, string>,
  options: CallGraphOptions = {},
): Promise<CallGraphResult> {
  return serializeParserWork(() => extractAndResolve(files, contentByFile, options));
}

async function extractAndResolve(
  files: readonly string[],
  contentByFile: ReadonlyMap<string, string>,
  options: CallGraphOptions,
): Promise<CallGraphResult> {
  const candidates = files.filter(isJavaScriptLike).sort();
  if (candidates.length === 0) {
    return { edges: [], diagnostics: [] };
  }
  const fileSet = new Set(files);
  const tables: AliasTables | null = options.root ? loadAliasTables(options.root) : null;

  const facts = new Map<string, FileFacts>();
  try {
    for (const file of candidates) {
      const content = contentByFile.get(file);
      if (content === undefined) {
        continue;
      }
      const parsed = await withParser(grammarFor(file), (parser) => {
        const tree = parser.parse(content);
        return tree ? collectFacts(tree.rootNode) : null;
      });
      if (parsed) {
        facts.set(file, parsed);
      }
    }
  } catch {
    // Call edges are additive evidence; a parser or grammar fault must not fail the scan.
    return { edges: [], diagnostics: [] };
  }

  return { edges: resolveCalls(facts, fileSet, tables), diagnostics: [] };
}

interface ImportBinding {
  /** The specifier as authored, e.g. `./util` or `@/lib`. */
  source: string;
  /** The exported name the local binding reads: a name, or `default` / `*`. */
  imported: string;
  kind: 'named' | 'default' | 'namespace';
}

interface CallSite {
  /** The callee name as authored: `foo` for `foo()`, `foo` for `ns.foo()`. */
  name: string;
  /** The full call as authored, kept as edge evidence: `foo` or `ns.foo`. */
  specifier: string;
  /** The receiver for a member call; absent for a bare call. */
  receiver?: string;
  line: number;
}

interface FileFacts {
  imports: Map<string, ImportBinding>;
  /** Exported names that name a function and can therefore be a call target. */
  callableExports: Set<string>;
  calls: CallSite[];
}

function collectFacts(root: Node): FileFacts {
  const imports = new Map<string, ImportBinding>();
  const callableExports = new Set<string>();
  const calls: CallSite[] = [];

  for (const statement of root.namedChildren) {
    if (statement.type === 'import_statement') {
      collectImports(statement, imports);
    } else if (statement.type === 'export_statement') {
      collectExports(statement, callableExports);
    }
  }

  walkNodes(root, (node) => {
    if (node.type !== 'call_expression') {
      return;
    }
    const site = callSiteOf(node);
    if (site) {
      calls.push(site);
    }
  });

  return { imports, callableExports, calls };
}

/**
 * Record the local bindings an import statement introduces.
 *
 * `import type` and `import { type X }` are erased at runtime and cannot be called, so they
 * are skipped. `import { a as b }` binds `b` to the exported name `a`; a default import binds
 * the `default` export; `import * as ns` binds a namespace.
 */
function collectImports(statement: Node, imports: Map<string, ImportBinding>): void {
  if (hasToken(statement, 'type')) {
    return;
  }
  const source = stringLiteral(statement.childForFieldName('source'));
  if (source === null) {
    return;
  }
  const clause = statement.namedChildren.find((child) => child.type === 'import_clause');
  if (!clause) {
    return;
  }
  for (const child of clause.namedChildren) {
    if (child.type === 'identifier') {
      imports.set(child.text, { source, imported: 'default', kind: 'default' });
      continue;
    }
    if (child.type === 'namespace_import') {
      const name = child.namedChildren.find((node) => node.type === 'identifier');
      if (name) {
        imports.set(name.text, { source, imported: '*', kind: 'namespace' });
      }
      continue;
    }
    if (child.type !== 'named_imports') {
      continue;
    }
    for (const specifier of child.namedChildren) {
      if (specifier.type !== 'import_specifier' || hasToken(specifier, 'type')) {
        continue;
      }
      const imported = specifier.childForFieldName('name')?.text;
      const local = specifier.childForFieldName('alias')?.text ?? imported;
      if (imported && local) {
        imports.set(local, { source, imported, kind: 'named' });
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
    if (specifier.type !== 'export_specifier') {
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

function resolveCalls(
  facts: Map<string, FileFacts>,
  fileSet: ReadonlySet<string>,
  tables: AliasTables | null,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  for (const [file, fact] of facts) {
    for (const call of fact.calls) {
      const binding = call.receiver ? fact.imports.get(call.receiver) : fact.imports.get(call.name);
      if (!binding) {
        continue;
      }
      if (call.receiver) {
        // A member call only proves a cross-file target through a namespace import.
        if (binding.kind !== 'namespace') {
          continue;
        }
      } else if (binding.kind === 'namespace') {
        // A namespace object is not itself callable.
        continue;
      }
      const resolved = resolveSource(binding.source, call.line, file, fileSet, tables);
      if (!resolved) {
        continue;
      }
      const exportedName = binding.kind === 'namespace' ? call.name : binding.imported;
      if (!facts.get(resolved.target)?.callableExports.has(exportedName)) {
        continue;
      }
      const key = `${file}\u0000${resolved.target}\u0000${call.line}\u0000${call.specifier}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      edges.push({
        source: file,
        target: resolved.target,
        kind: 'call',
        role: 'use',
        evidence: {
          line: call.line,
          specifier: call.specifier,
          resolution: resolved.evidence.resolution,
        },
      });
    }
  }

  return edges;
}

/** Resolve an import specifier to an internal file through the same rules import edges use. */
function resolveSource(
  specifier: string,
  line: number,
  from: string,
  files: ReadonlySet<string>,
  tables: AliasTables | null,
): ResolvedReference | null {
  if (specifier.startsWith('.')) {
    return resolveRelative(specifier, line, { from, files });
  }
  return tables ? resolveAliased(specifier, line, from, files, tables).resolved : null;
}

function isJavaScriptLike(file: string): boolean {
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
