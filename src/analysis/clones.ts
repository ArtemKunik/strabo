import { createHash } from 'node:crypto';

import { symbolExtractorFor } from '../scan/languages/registry.ts';
import type { Graph } from '../types.ts';
import { readWorkingFile } from './git-content.ts';

/**
 * Near-duplicate function detection over a normalised token stream.
 *
 * This is lexical normalisation, not a full AST comparison. Identifiers collapse to `$id`,
 * literals to `$str` / `$num`, and comments and whitespace are dropped, so a function and a
 * copy with renamed identifiers or changed literals hash the same. A semantically equivalent
 * rewrite that reorders statements, renames a keyword, or changes the token shape does not:
 * the hash is a fingerprint of the normalised tokens, not of behaviour.
 */

export interface CloneMember {
  file: string;
  owner: string;
  name: string;
  line: number;
  endLine: number;
  tokens: number;
}

export interface CloneCluster {
  hash: string;
  members: CloneMember[];
  sharedTokens: number;
}

export interface CloneReport {
  available: boolean;
  reason?: string;
  clusters: CloneCluster[];
  functionsHashed: number;
  filesRead: number;
}

export interface CloneOptions {
  minTokens?: number;
  maxFiles?: number;
  minMembers?: number;
}

const JS_KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'break', 'continue', 'class', 'extends', 'new', 'this', 'super', 'import', 'export',
  'from', 'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'in',
  'of', 'null', 'undefined', 'true', 'false', 'void', 'yield', 'static', 'get', 'set',
  'interface', 'type', 'enum',
]);

const PYTHON_KEYWORDS = new Set([
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not', 'and', 'or',
  'is', 'None', 'True', 'False', 'import', 'from', 'as', 'with', 'try', 'except', 'finally',
  'raise', 'lambda', 'yield', 'async', 'await', 'pass', 'break', 'continue', 'global',
  'nonlocal', 'self',
]);

const RUST_KEYWORDS = new Set([
  'fn', 'let', 'mut', 'return', 'if', 'else', 'for', 'while', 'loop', 'match', 'struct',
  'enum', 'impl', 'trait', 'pub', 'use', 'mod', 'crate', 'self', 'super', 'as', 'in', 'ref',
  'move', 'async', 'await', 'where', 'type', 'const', 'static', 'true', 'false', 'dyn',
]);

const JVM_KEYWORDS = new Set([
  'public', 'private', 'protected', 'static', 'final', 'void', 'class', 'interface', 'extends',
  'implements', 'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'new', 'this', 'super', 'try', 'catch', 'finally', 'throw', 'throws', 'import',
  'package', 'fun', 'val', 'var', 'object', 'data', 'when', 'is', 'in', 'as', 'true', 'false',
  'null', 'override', 'open', 'suspend', 'async', 'await', 'record', 'struct', 'using',
  'namespace', 'internal', 'sealed', 'readonly', 'params', 'get', 'set', 'yield',
]);

const CPP_KEYWORDS = new Set([
  'int', 'char', 'bool', 'void', 'class', 'struct', 'public', 'private', 'protected',
  'virtual', 'override', 'const', 'static', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'new', 'delete', 'this', 'namespace', 'using',
  'template', 'typename', 'true', 'false', 'nullptr', 'auto', 'unsigned', 'signed', 'long',
  'short', 'float', 'double', 'try', 'catch', 'throw', 'constexpr', 'inline', 'extern',
  'include', 'define',
]);

const GENERIC_KEYWORDS = new Set([
  'return', 'if', 'else', 'for', 'while', 'function', 'class', 'true', 'false', 'null', 'new',
  'this',
]);

/** The keyword set kept verbatim for one language; everything else becomes `$id`. */
function keywordsFor(language: string): Set<string> {
  switch (language) {
    case 'typescript':
    case 'javascript':
      return JS_KEYWORDS;
    case 'python':
      return PYTHON_KEYWORDS;
    case 'rust':
      return RUST_KEYWORDS;
    case 'java':
    case 'kotlin':
    case 'csharp':
      return JVM_KEYWORDS;
    case 'cpp':
      return CPP_KEYWORDS;
    default:
      return GENERIC_KEYWORDS;
  }
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isIdentifierStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_' || ch === '$';
}

function isIdentifierPart(ch: string): boolean {
  return isIdentifierStart(ch) || isDigit(ch);
}

/** Skip one quoted literal, handling escapes and Python/JS triple quotes. */
function skipString(source: string, start: number, quote: string): number {
  const length = source.length;
  if (source.startsWith(quote + quote + quote, start)) {
    const close = quote + quote + quote;
    let i = start + 3;
    while (i < length && !source.startsWith(close, i)) {
      i += 1;
    }
    return i >= length ? length : i + 3;
  }
  let i = start + 1;
  while (i < length) {
    const ch = source[i] as string;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    // Only template literals and triple-quoted strings may span a newline.
    if (ch === '\n' && quote !== '`') {
      return i;
    }
    i += 1;
  }
  return length;
}

/** Skip one numeric literal, including hex/bin/oct prefixes, decimals, and exponents. */
function skipNumber(source: string, start: number): number {
  const length = source.length;
  let i = start;
  if (source[i] === '0' && /[xXbBoO]/.test(source[i + 1] ?? '')) {
    i += 2;
    while (i < length && /[0-9a-fA-F_]/.test(source[i] as string)) {
      i += 1;
    }
    return i;
  }
  while (i < length && /[0-9_]/.test(source[i] as string)) {
    i += 1;
  }
  if (source[i] === '.' && isDigit(source[i + 1] ?? '')) {
    i += 1;
    while (i < length && /[0-9_]/.test(source[i] as string)) {
      i += 1;
    }
  }
  if (source[i] === 'e' || source[i] === 'E') {
    let j = i + 1;
    if (source[j] === '+' || source[j] === '-') {
      j += 1;
    }
    if (isDigit(source[j] ?? '')) {
      i = j;
      while (i < length && /[0-9_]/.test(source[i] as string)) {
        i += 1;
      }
    }
  }
  return i;
}

/**
 * Normalise a source slice to a language-agnostic token stream.
 *
 * Comments and whitespace vanish; strings become `$str`; numbers become `$num`; identifiers
 * become `$id` unless they are keywords for `language`; every other character is its own
 * token. `//` is a line comment everywhere except Python, where it is floor division, and
 * `#` is a line comment only in Python so a C/C++ preprocessor line or a TypeScript `#field`
 * is not eaten. Exported for unit testing.
 */
export function normaliseTokens(source: string, language: string): string[] {
  const keywords = keywordsFor(language);
  const tokens: string[] = [];
  const length = source.length;
  let i = 0;

  while (i < length) {
    const ch = source[i] as string;

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === '\f' || ch === '\v') {
      i += 1;
      continue;
    }

    if (ch === '/' && source[i + 1] === '/' && language !== 'python') {
      i += 2;
      while (i < length && source[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    if (ch === '#' && language === 'python') {
      i += 1;
      while (i < length && source[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < length && !(source[i] === '*' && source[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      continue;
    }

    if (ch === '<' && source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      i = end === -1 ? length : end + 3;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(source, i, ch);
      tokens.push('$str');
      continue;
    }

    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1] ?? ''))) {
      i = skipNumber(source, i);
      tokens.push('$num');
      continue;
    }

    if (isIdentifierStart(ch)) {
      let j = i + 1;
      while (j < length && isIdentifierPart(source[j] as string)) {
        j += 1;
      }
      const word = source.slice(i, j);
      tokens.push(keywords.has(word) ? word : '$id');
      i = j;
      continue;
    }

    tokens.push(ch);
    i += 1;
  }

  return tokens;
}

/**
 * Find clusters of near-duplicate functions across the source files in `graph`.
 *
 * Each function is read from the working tree, sliced to its declaration through its body,
 * normalised, and hashed. Functions below `minTokens` are ignored, and only hashes shared by
 * at least `minMembers` functions form a cluster. When no function could be hashed the report
 * is unavailable rather than an empty success.
 */
export async function computeClones(
  root: string,
  graph: Graph,
  options: CloneOptions = {},
): Promise<CloneReport> {
  const minTokens = options.minTokens ?? 30;
  const maxFiles = options.maxFiles ?? 400;
  const minMembers = options.minMembers ?? 2;

  const byHash = new Map<string, CloneMember[]>();
  let functionsHashed = 0;
  let filesRead = 0;
  let attempted = 0;

  for (const node of graph.nodes) {
    if (attempted >= maxFiles) {
      break;
    }
    const extractor = symbolExtractorFor(node.id);
    if (!extractor) {
      continue;
    }
    attempted += 1;

    const content = readWorkingFile(root, node.id);
    if (content === null) {
      continue;
    }
    filesRead += 1;

    let symbols;
    try {
      symbols = (await extractor.extract(node.id, content)).symbols;
    } catch {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (const symbol of symbols) {
      const metrics = symbol.metrics;
      if (!metrics) {
        continue;
      }
      const start = Math.max(1, symbol.line);
      const end = Math.min(metrics.endLine, lines.length);
      if (start > end) {
        continue;
      }
      const slice = lines.slice(start - 1, end).join('\n');
      const tokens = normaliseTokens(slice, extractor.language);
      if (tokens.length < minTokens) {
        continue;
      }
      const hash = createHash('sha1').update(tokens.join(' ')).digest('hex');
      functionsHashed += 1;

      const member: CloneMember = {
        file: node.id,
        owner: symbol.owner,
        name: symbol.name,
        line: symbol.line,
        endLine: metrics.endLine,
        tokens: tokens.length,
      };
      const list = byHash.get(hash);
      if (list) {
        list.push(member);
      } else {
        byHash.set(hash, [member]);
      }
    }
  }

  const clusters: CloneCluster[] = [];
  for (const [hash, members] of byHash) {
    if (members.length < minMembers) {
      continue;
    }
    members.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    clusters.push({ hash, members, sharedTokens: members[0]?.tokens ?? 0 });
  }
  clusters.sort((a, b) => b.sharedTokens - a.sharedTokens || a.hash.localeCompare(b.hash));

  if (functionsHashed === 0) {
    return {
      available: false,
      reason: 'no functions were extracted',
      clusters: [],
      functionsHashed,
      filesRead,
    };
  }

  return { available: true, clusters, functionsHashed, filesRead };
}
