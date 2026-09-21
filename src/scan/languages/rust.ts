import type { Node } from 'web-tree-sitter';

import type { Diagnostic, GraphEdge } from '../../types.ts';
import { collectFunctionMetrics, looksLikeTypeName, markRecursive, type FunctionRules } from './function-metrics.ts';
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

export const RUST_LANGUAGE: GrammarLanguage = 'rust';

export interface RustMod {
  name: string;
  /** `mod foo;` refers to another file; `mod foo { .. }` is inline and creates no edge. */
  external: boolean;
  line: number;
}

export interface RustUse {
  segments: string[];
  glob: boolean;
  /** Local binding introduced by `use x as name`, or the last path segment. */
  boundName: string;
  reexport: boolean;
  line: number;
}

export interface RustItem {
  name: string;
  line: number;
}

/** A `crate::`/`self::`/`super::` path used inline, without a `use` declaration. */
export interface RustPathReference {
  segments: string[];
  line: number;
}

export interface RustFileFacts {
  file: string;
  /** Directory of the crate root (ends at the last `src` segment), '' when none. */
  crateRoot: string;
  /** Module path relative to the crate root, e.g. `api/request` for `src/api/request.rs`. */
  modulePath: string;
  mods: RustMod[];
  uses: RustUse[];
  /** Top-level items (structs, enums, traits, fns, ...) declared in this module. */
  items: RustItem[];
  /** Inline crate-relative paths referenced in the file body. */
  paths: RustPathReference[];
}

export interface RustExtraction {
  facts: RustFileFacts;
  diagnostics: Diagnostic[];
}

const MOD_PATTERN = /^(?:pub(?:\s*\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*(;|\{)/;

const ITEM_TYPES = new Set([
  'struct_item',
  'enum_item',
  'trait_item',
  'function_item',
  'type_item',
  'const_item',
  'static_item',
  'union_item',
  'macro_definition',
]);

/** Parse one Rust file into module coordinates, items, `mod` declarations, and `use` paths. */
export async function extractRustFacts(file: string, content: string): Promise<RustExtraction> {
  return withParser(RUST_LANGUAGE, (parser) => {
    const { crateRoot, modulePath } = moduleCoordinates(file);
    const facts: RustFileFacts = {
      file,
      crateRoot,
      modulePath,
      mods: [],
      uses: [],
      items: [],
      paths: [],
    };
    const diagnostics: Diagnostic[] = [];

    const tree = parser.parse(content);
    if (!tree) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'error',
        kind: 'parse-failure',
        message: 'Rust parser returned no tree for this file.',
      });
      return { facts, diagnostics };
    }

    for (const node of tree.rootNode.namedChildren) {
      if (node.type === 'mod_item') {
        const match = MOD_PATTERN.exec(node.text);
        if (match) {
          facts.mods.push({
            name: match[1] as string,
            external: match[2] === ';',
            line: node.startPosition.row + 1,
          });
        }
      } else if (node.type === 'use_declaration') {
        const reexport = node.namedChildren.some((child) => child.type === 'visibility_modifier');
        for (const reference of expandUse(node.text)) {
          facts.uses.push({
            segments: reference.segments,
            glob: reference.glob,
            boundName: reference.alias ?? reference.segments.at(-1) ?? '',
            reexport,
            line: node.startPosition.row + 1,
          });
        }
      } else if (ITEM_TYPES.has(node.type)) {
        const name = node.childForFieldName('name');
        if (name) {
          facts.items.push({ name: name.text, line: node.startPosition.row + 1 });
        }
      }
    }

    if (tree.rootNode.hasError) {
      diagnostics.push({
        file,
        line: 1,
        severity: 'warning',
        kind: 'parse-failure',
        message: 'Rust source contains syntax errors; extracted facts may be incomplete.',
      });
    }

    facts.paths = collectInlinePaths(tree.rootNode);

    return { facts, diagnostics };
  });
}

/**
 * Map a file path to its crate root and module path.
 *
 * `src/main.rs` and `src/lib.rs` are the crate root; `src/foo.rs` is module `foo`;
 * `src/foo/mod.rs` is module `foo` and `src/foo/bar.rs` is `foo/bar`.
 */
export function moduleCoordinates(file: string): { crateRoot: string; modulePath: string } {
  const segments = file.split('/').filter(Boolean);
  const srcIndex = segments.lastIndexOf('src');
  const crateRoot = srcIndex >= 0 ? segments.slice(0, srcIndex + 1).join('/') : '';
  const tail = srcIndex >= 0 ? segments.slice(srcIndex + 1) : segments;

  const last = tail.at(-1) ?? '';
  if (last === 'main.rs' || last === 'lib.rs' || last === 'mod.rs') {
    return { crateRoot, modulePath: tail.slice(0, -1).join('/') };
  }
  return { crateRoot, modulePath: [...tail.slice(0, -1), last.replace(/\.rs$/, '')].join('/') };
}

interface UseReference {
  segments: string[];
  glob: boolean;
  alias?: string;
}

/** Expand a `use` declaration, including nested brace lists, aliases, and globs. */
export function expandUse(text: string): UseReference[] {
  let expression = text.trim().replace(/;$/, '').trim();
  expression = expression.replace(/^pub(?:\s*\([^)]*\))?\s+/, '');
  expression = expression.replace(/^use\s+/, '');
  const references: UseReference[] = [];

  const parse = (value: string, prefix: string[]): void => {
    const expr = value.trim();
    if (!expr) {
      return;
    }
    if (expr.endsWith('::*')) {
      references.push({
        segments: [...prefix, ...splitPath(expr.slice(0, -3))],
        glob: true,
        alias: undefined,
      });
      return;
    }
    const brace = topLevelIndex(expr, '{');
    if (brace >= 0) {
      const close = matchingBrace(expr, brace);
      const head = expr.slice(0, brace).replace(/\s*::\s*$/, '');
      const inner = expr.slice(brace + 1, close);
      const subPrefix = [...prefix, ...splitPath(head)];
      for (const item of splitTopLevel(inner, ',')) {
        parse(item, subPrefix);
      }
      return;
    }
    const alias = /^(.*?)\s+as\s+([A-Za-z_]\w*)$/.exec(expr);
    const path = alias ? (alias[1] as string) : expr;
    references.push({
      segments: [...prefix, ...splitPath(path)],
      glob: false,
      alias: alias ? (alias[2] as string) : undefined,
    });
  };

  parse(expression, []);
  return references;
}

function splitPath(value: string): string[] {
  return value.split('::').map((segment) => segment.trim()).filter(Boolean);
}

/**
 * Collect crate-relative paths used inline in the body (not via `use`).
 *
 * `use` declarations and `mod` items are skipped because they are handled separately.
 * Only `crate::`, `self::`, and `super::` paths are kept; external crate paths such as
 * `std::collections::HashMap` are ignored.
 */
function collectInlinePaths(root: Node): RustPathReference[] {
  const references: RustPathReference[] = [];

  const visit = (node: Node): void => {
    if (node.type === 'use_declaration' || node.type === 'mod_item') {
      return;
    }
    if (node.type === 'scoped_identifier' || node.type === 'scoped_type_identifier') {
      const segments = flattenPath(node);
      if (segments.length > 0 && isCrateRelative(segments)) {
        references.push({ segments, line: node.startPosition.row + 1 });
      }
      return;
    }
    for (const child of node.namedChildren) {
      visit(child);
    }
  };

  visit(root);
  return dedupePaths(references);
}

/** Flatten a nested `scoped_identifier` into ordered segments (`crate`, `util`, `Helper`). */
function flattenPath(node: Node): string[] {
  const segments: string[] = [];
  const walk = (current: Node): void => {
    if (current.namedChildren.length === 0) {
      segments.push(current.text);
      return;
    }
    for (const child of current.namedChildren) {
      walk(child);
    }
  };
  walk(node);
  return segments;
}

function dedupePaths(references: RustPathReference[]): RustPathReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = reference.segments.join('::');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function topLevelIndex(value: string, character: string): number {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === character && depth === 0) return index;
    if (char === '{' || char === '(') depth += 1;
    else if (char === '}' || char === ')') depth -= 1;
  }
  return -1;
}

function matchingBrace(value: string, open: number): number {
  let depth = 0;
  for (let index = open; index < value.length; index += 1) {
    if (value[index] === '{') depth += 1;
    else if (value[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return value.length;
}

function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '{' || char === '(') depth += 1;
    else if (char === '}' || char === ')') depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.filter((part) => part.trim().length > 0);
}

export interface RustResolution {
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
}

interface RustContext {
  modules: Map<string, string>;
  items: Map<string, Map<string, string>>;
  reexports: Map<string, Map<string, string[]>>;
}

/**
 * Resolve Rust `mod` declarations and `use` paths to repository files.
 *
 * Module paths resolve through the file layout; item paths (`crate::api::Request`) resolve
 * through declared items and `pub use` re-exports. Only `crate::`, `self::`, and `super::`
 * paths are followed; anything else is treated as an external crate.
 */
export function resolveRust(facts: RustFileFacts[]): RustResolution {
  const context = buildContext(facts);
  const edges: GraphEdge[] = [];
  const diagnostics: Diagnostic[] = [];
  const seen = new Set<string>();
  const pairs = new Set<string>();

  const push = (
    source: string,
    target: string,
    kind: GraphEdge['kind'],
    line: number,
    specifier: string,
    resolution: 'exact' | 'module-tree',
    role: GraphEdge['role'] = 'use',
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
    edges.push({ source, target, kind, evidence: { line, specifier, resolution }, role });
  };

  for (const fileFacts of facts) {
    for (const module of fileFacts.mods) {
      if (!module.external) {
        continue;
      }
      const target = resolveModFile(module.name, fileFacts, context);
      if (target) {
        // `mod x;` only declares the module tree; it is not a dependency on x's contents.
        push(fileFacts.file, target, 'namespace', module.line, `mod ${module.name}`, 'exact', 'declare');
      } else {
        diagnostics.push({
          file: fileFacts.file,
          line: module.line,
          severity: 'warning',
          kind: 'unresolved',
          specifier: `mod ${module.name}`,
          message: `Rust module "${module.name}" has no matching file in the repository.`,
        });
      }
    }

    for (const reference of fileFacts.uses) {
      const target = resolveSymbolPath(reference.segments, fileFacts, context, new Set());
      if (target && target !== fileFacts.file) {
        push(
          fileFacts.file,
          target,
          reference.reexport ? 're-export' : 'import',
          reference.line,
          reference.segments.join('::'),
          'module-tree',
        );
        continue;
      }
      if (!target && isCrateRelative(reference.segments)) {
        diagnostics.push({
          file: fileFacts.file,
          line: reference.line,
          severity: 'warning',
          kind: 'unresolved',
          specifier: reference.segments.join('::'),
          message: `Rust path "${reference.segments.join('::')}" does not resolve to a file inside the repository.`,
        });
      }
    }

    for (const reference of fileFacts.paths ?? []) {
      const target = resolveSymbolPath(reference.segments, fileFacts, context, new Set());
      if (!target || target === fileFacts.file) {
        continue;
      }
      const pair = `${fileFacts.file}\u0000${target}`;
      if (pairs.has(pair)) {
        continue;
      }
      push(fileFacts.file, target, 'import', reference.line, reference.segments.join('::'), 'module-tree');
    }
  }

  return { edges, diagnostics };
}

/**
 * Resolve a `mod name;` declaration to a file.
 *
 * Rust searches the declaring module's directory first (`src/foo.rs` -> `src/foo/bar.rs`).
 * Cargo bin targets (`[[bin]] path = "src/bin_name.rs"`) are their own crate roots, so
 * `mod name;` there refers to a sibling file; that layout is tried as a fallback.
 */
function resolveModFile(
  name: string,
  fileFacts: RustFileFacts,
  context: RustContext,
): string | null {
  const primary = joinModule(fileFacts.modulePath, name);
  const primaryTarget = context.modules.get(moduleKey(fileFacts.crateRoot, primary));
  if (primaryTarget) {
    return primaryTarget;
  }

  const fileDirectory = fileFacts.file.slice(0, fileFacts.file.lastIndexOf('/'));
  const relativeDirectory =
    fileFacts.crateRoot && fileDirectory.startsWith(fileFacts.crateRoot)
      ? fileDirectory.slice(fileFacts.crateRoot.length).replace(/^\/+/, '')
      : fileDirectory;
  const sibling = relativeDirectory ? `${relativeDirectory}/${name}` : name;
  return context.modules.get(moduleKey(fileFacts.crateRoot, sibling)) ?? null;
}

function buildContext(facts: RustFileFacts[]): RustContext {
  const modules = new Map<string, string>();
  const items = new Map<string, Map<string, string>>();
  const reexports = new Map<string, Map<string, string[]>>();

  for (const fileFacts of facts) {
    const key = moduleKey(fileFacts.crateRoot, fileFacts.modulePath);
    modules.set(key, fileFacts.file);

    if (fileFacts.items.length > 0) {
      const map = items.get(key) ?? new Map<string, string>();
      items.set(key, map);
      for (const item of fileFacts.items) {
        map.set(item.name, fileFacts.file);
      }
    }

    for (const reference of fileFacts.uses) {
      if (!reference.reexport || !reference.boundName) {
        continue;
      }
      const map = reexports.get(key) ?? new Map<string, string[]>();
      reexports.set(key, map);
      map.set(reference.boundName, reference.segments);
    }
  }

  return { modules, items, reexports };
}

function resolveSymbolPath(
  segments: string[],
  facts: RustFileFacts,
  context: RustContext,
  visited: Set<string>,
): string | null {
  if (segments.length === 0) {
    return null;
  }
  let base: string[] = [];
  let index = 0;

  if (segments[0] === 'crate') {
    index = 1;
  } else if (segments[0] === 'self') {
    base = facts.modulePath.split('/').filter(Boolean);
    index = 1;
  } else if (segments[0] === 'super') {
    base = facts.modulePath.split('/').filter(Boolean);
    while (segments[index] === 'super') {
      base = base.slice(0, -1);
      index += 1;
    }
  } else {
    // External crate or a 2015-edition bare path; never invent an edge.
    return null;
  }

  return navigate(facts.crateRoot, base.join('/'), segments.slice(index), context, visited);
}

function navigate(
  crateRoot: string,
  modulePath: string,
  rest: string[],
  context: RustContext,
  visited: Set<string>,
): string | null {
  let current = modulePath;
  for (let index = 0; index < rest.length; index += 1) {
    const segment = rest[index] as string;
    const isLast = index === rest.length - 1;
    const childPath = joinModule(current, segment);
    const child = context.modules.get(moduleKey(crateRoot, childPath));

    if (!isLast && child) {
      current = childPath;
      continue;
    }

    const symbol = resolveSymbol(crateRoot, current, segment, context, visited);
    if (symbol) {
      // A non-final item segment means the remaining segments are its associated items
      // (e.g. `crate::util::Helper::new`), which are not separate files.
      return symbol;
    }
    if (isLast && child) {
      return child;
    }
    return null;
  }
  return context.modules.get(moduleKey(crateRoot, current)) ?? null;
}

function resolveSymbol(
  crateRoot: string,
  modulePath: string,
  name: string,
  context: RustContext,
  visited: Set<string>,
): string | null {
  const key = moduleKey(crateRoot, modulePath);
  const seenKey = `${key}\u0000${name}`;
  if (visited.has(seenKey)) {
    return null;
  }
  visited.add(seenKey);

  const item = context.items.get(key)?.get(name);
  if (item) {
    return item;
  }

  const reexport = context.reexports.get(key)?.get(name);
  if (!reexport || reexport.length === 0) {
    return null;
  }

  if (isCrateRelative(reexport)) {
    const facts: RustFileFacts = {
      file: context.modules.get(key) ?? '',
      crateRoot,
      modulePath,
      mods: [],
      uses: [],
      items: [],
      paths: [],
    };
    return resolveSymbolPath(reexport, facts, context, visited);
  }
  return navigate(crateRoot, modulePath, reexport, context, visited);
}

function isCrateRelative(segments: string[]): boolean {
  return segments[0] === 'crate' || segments[0] === 'self' || segments[0] === 'super';
}

function moduleKey(crateRoot: string, modulePath: string): string {
  return `${crateRoot}\u0000${modulePath}`;
}

function joinModule(modulePath: string, name: string): string {
  return modulePath ? `${modulePath}/${name}` : name;
}

/**
 * Extract struct fields and impl methods with visibility and owner.
 *
 * Struct fields belong to the struct; methods inside an `impl` block belong to the
 * implemented type.
 */
export async function extractRustSymbols(
  file: string,
  content: string,
): Promise<SymbolExtraction> {
  return withParser(RUST_LANGUAGE, (parser) => {
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
        message: 'Rust parser returned no tree for this file.',
      });
      return { symbols, diagnostics };
    }

    const visit = (node: Node, owner: string): void => {
      if (node.type === 'struct_item' || node.type === 'enum_item') {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          symbols.push({
            name,
            kind: 'type',
            visibility: rustVisibility(node),
            owner,
            line: node.startPosition.row + 1,
          });
          const body = node.childForFieldName('body');
          if (body) {
            for (const field of body.namedChildren) {
              if (field.type !== 'field_declaration') {
                continue;
              }
              const fieldName = field.childForFieldName('name')?.text;
              if (fieldName) {
                symbols.push({
                  name: fieldName,
                  kind: 'field',
                  visibility: rustVisibility(field),
                  owner: name,
                  type: field.childForFieldName('type')?.text,
                  line: field.startPosition.row + 1,
                });
                const ownerFields = fieldsByOwner.get(name) ?? new Set<string>();
                fieldsByOwner.set(name, ownerFields);
                ownerFields.add(fieldName);
              }
            }
          }
        }
        return;
      }

      if (node.type === 'impl_item') {
        const owner = node.childForFieldName('type')?.text ?? '';
        const body = node.childForFieldName('body');
        if (body) {
          for (const child of body.namedChildren) {
            visit(child, owner);
          }
        }
        return;
      }

      if (node.type === 'function_item') {
        const name = node.childForFieldName('name')?.text;
        if (name) {
          const parameters = node.childForFieldName('parameters');
          const symbol: CodeSymbol = {
            name,
            kind: 'method',
            visibility: rustVisibility(node),
            owner,
            type: node.childForFieldName('return_type')?.text,
            parameters: parameters?.namedChildren.length ?? 0,
            line: node.startPosition.row + 1,
          };
          const body = node.childForFieldName('body');
          if (body) {
            symbol.metrics = collectFunctionMetrics(body, symbol.line, RUST_FUNCTION_RULES);
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
            RUST_ACCESS,
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
      collectFunctionCalls(entry.body, declared, types, entry.owner, entry.method, RUST_CALLS),
    );
    markRecursive(symbols, calls);

    return { symbols: sortSymbols(symbols), diagnostics, accesses, calls };
  });
}

const RUST_FUNCTION_RULES: FunctionRules = {
  controlFlowTypes: new Set([
    'if_expression',
    'for_expression',
    'while_expression',
    'loop_expression',
    'match_expression',
    'try_expression',
  ]),
  loopTypes: new Set(['for_expression', 'while_expression', 'loop_expression']),
  decisionNodeTypes: new Set([
    'if_expression',
    'for_expression',
    'while_expression',
    'loop_expression',
    'match_arm',
    'try_expression',
  ]),
  decisionOperators: new Set(['&&', '||']),
  callTypes: new Set(['call_expression']),
  callTargetName: (node) => {
    const fn = node.childForFieldName('function');
    if (!fn) {
      return null;
    }
    if (fn.type === 'identifier') {
      return fn.text;
    }
    if (fn.type === 'field_expression') {
      return fn.childForFieldName('field')?.text ?? null;
    }
    if (fn.type === 'scoped_identifier') {
      return fn.childForFieldName('name')?.text ?? null;
    }
    return null;
  },
  linearScanCalls: new Set(['contains', 'position', 'find', 'filter', 'any', 'all', 'count']),
  sortCalls: new Set(['sort', 'sort_by', 'sort_unstable', 'sort_by_key']),
  statementTypes: new Set([
    'let_declaration',
    'expression_statement',
    'return_expression',
    'break_expression',
    'continue_expression',
    'if_expression',
    'for_expression',
    'while_expression',
    'loop_expression',
    'match_expression',
  ]),
  nestedFunctionTypes: new Set(['function_item', 'closure_expression']),
};

const RUST_CALLS: CallRules = {
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
      const value = fn.childForFieldName('value');
      const field = fn.childForFieldName('field');
      if (!value || !field) {
        return null;
      }
      if (value.text === 'self') {
        return { name: field.text, kind: 'self', receiver: 'self' };
      }
      return null;
    }
    if (fn.type === 'scoped_identifier') {
      const path = fn.childForFieldName('path');
      const name = fn.childForFieldName('name');
      if (!path || !name) {
        return null;
      }
      if (path.text === 'Self') {
        return { name: name.text, kind: 'type-qualified', receiver: 'Self' };
      }
      const separator = path.text.lastIndexOf('::');
      const receiver = separator === -1 ? path.text : path.text.slice(separator + 2);
      if (looksLikeTypeName(receiver)) {
        return { name: name.text, kind: 'type-qualified', receiver };
      }
    }
    return null;
  },
};

const RUST_ACCESS: AccessRules = {
  identifierTypes: new Set(['identifier']),
  assignmentTypes: new Set([
    'assignment_expression',
    'compound_assignment_expr',
    'update_expression',
  ]),
  selfAccess: (node) => {
    if (node.type !== 'field_expression') {
      return null;
    }
    const value = node.childForFieldName('value');
    if (!value || value.text !== 'self') {
      return null;
    }
    const field = node.childForFieldName('field');
    return field ? { field: field.text, fieldNode: field } : null;
  },
  declaredNames: (body) =>
    collectDeclaredIdentifiers(body, (node) => {
      if (node.type === 'parameter' || node.type === 'let_declaration') {
        const pattern = node.childForFieldName('pattern');
        return pattern?.text ?? null;
      }
      return null;
    }),
};

function rustVisibility(node: Node): string {
  const modifier = node.namedChildren.find((child) => child.type === 'visibility_modifier')?.text;
  if (!modifier) {
    return 'private';
  }
  if (modifier.includes('crate')) return 'crate';
  if (modifier.includes('super')) return 'super';
  return 'public';
}
