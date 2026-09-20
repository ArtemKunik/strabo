import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Language, Parser } from 'web-tree-sitter';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/scan/languages/ or dist/scan/languages/ -> package root is three levels up.
const packageRoot = path.resolve(here, '..', '..', '..');

/**
 * Languages that ship a grammar. Grammars are resolver-driven, so this list grows only
 * when a resolver is implemented; `GrammarLanguage` stays wider to type future work.
 */
export type GrammarLanguage =
  | 'java'
  | 'kotlin'
  | 'sql'
  | 'c_sharp'
  | 'cpp'
  | 'rust'
  | 'typescript'
  | 'tsx';

export const GRAMMAR_LANGUAGES: readonly GrammarLanguage[] = [
  'java',
  'rust',
  'c_sharp',
  'kotlin',
  'typescript',
  'tsx',
];

export class GrammarUnavailableError extends Error {
  readonly language: GrammarLanguage;
  readonly searched: string[];
  constructor(language: GrammarLanguage, searched: string[]) {
    super(`No grammar asset for "${language}". Searched: ${searched.join(', ')}`);
    this.name = 'GrammarUnavailableError';
    this.language = language;
    this.searched = searched;
  }
}

/** Override the grammar directory (tests, embedding hosts). Defaults to `parsers/vendor`. */
export function parserDirectory(): string {
  const configured = process.env.STRABO_PARSER_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(packageRoot, 'parsers', 'vendor');
}

function grammarCandidates(language: GrammarLanguage): string[] {
  const filename = `tree-sitter-${language}.wasm`;
  return [
    // Package-owned assets, produced by `npm run vendor:parsers`.
    path.join(parserDirectory(), language, filename),
    // Dev fallback: the devDependency, so tests work before vendoring.
    path.join(packageRoot, 'node_modules', 'tree-sitter-wasm', 'out', language, filename),
  ];
}

export function grammarPath(language: GrammarLanguage): string | null {
  return grammarCandidates(language).find((candidate) => fs.existsSync(candidate)) ?? null;
}

export function availableGrammarLanguages(): GrammarLanguage[] {
  return GRAMMAR_LANGUAGES.filter((language) => grammarPath(language) !== null);
}

let initialized: Promise<void> | null = null;
const languages = new Map<GrammarLanguage, Promise<Language>>();

function ensureInit(): Promise<void> {
  initialized ??= Parser.init();
  return initialized;
}

/** Load (and cache) a grammar language. Rejects with {@link GrammarUnavailableError}. */
export function loadLanguage(language: GrammarLanguage): Promise<Language> {
  const cached = languages.get(language);
  if (cached) {
    return cached;
  }
  const task = (async () => {
    const file = grammarPath(language);
    if (!file) {
      throw new GrammarUnavailableError(language, grammarCandidates(language));
    }
    await ensureInit();
    return Language.load(file);
  })();
  languages.set(language, task);
  return task;
}

/**
 * Parser runtime state is process-global and parsers are not reentrant, so callers must
 * serialise access. Polyglot scans do this through a promise queue in scan-polyglot.
 *
 * Parsers are cached per language and reused; they are released when the process exits.
 */
const parsers = new Map<GrammarLanguage, Promise<Parser>>();

async function parserFor(language: GrammarLanguage): Promise<Parser> {
  const cached = parsers.get(language);
  if (cached) {
    return cached;
  }
  const task = (async () => {
    const grammar = await loadLanguage(language);
    const parser = new Parser();
    parser.setLanguage(grammar);
    return parser;
  })();
  parsers.set(language, task);
  return task;
}

/** Run `fn` against the shared parser for `language`. Callers must serialise invocation. */
export async function withParser<T>(
  language: GrammarLanguage,
  fn: (parser: Parser) => T,
): Promise<T> {
  const parser = await parserFor(language);
  return fn(parser);
}
