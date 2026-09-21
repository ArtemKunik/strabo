/**
 * Basic syntax highlighting for the source viewer.
 *
 * A small line-oriented tokenizer, not a parser: it recognises comments, strings, numbers,
 * keywords, and a few identifier shapes (types, calls, attributes) for the languages Strabo
 * analyses. It never throws and never drops text — the tokens for a line always concatenate
 * back to that line — so a wrong guess costs colour, not correctness. A file in a language
 * it does not know is left plain.
 */

const words = (list) => new Set(list.split(/\s+/).filter(Boolean));

const C_LIKE_LITERALS = 'true false null';

const LANGUAGES = {
  javascript: {
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'", '`'],
    multilineQuotes: ['`'],
    attribute: /^@[A-Za-z_$][\w$]*/,
    keywords: words(`
      as async await break case catch class const continue debugger declare default delete do
      else enum export extends finally for from function get if implements import in instanceof
      interface let namespace new of private protected public readonly return set static super
      switch this throw try type typeof var void while with yield abstract satisfies keyof
      infer is override accessor`),
    literals: words(`${C_LIKE_LITERALS} undefined NaN Infinity`),
  },
  python: {
    lineComments: ['#'],
    blockComment: null,
    quotes: ['"', "'"],
    tripleQuotes: ['"""', "'''"],
    attribute: /^@[A-Za-z_][\w.]*/,
    keywords: words(`
      and as assert async await break class continue def del elif else except finally for from
      global if import in is lambda nonlocal not or pass raise return try while with yield
      match case self cls`),
    literals: words('True False None'),
  },
  rust: {
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"'],
    // A quote is a char literal only when it closes at once; otherwise it is a lifetime.
    charLiteral: /^'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F_]+\}|.)|[^'\\])'/,
    attribute: /^#!?\[[^\]]*\]/,
    macroBang: true,
    keywords: words(`
      as async await break const continue crate dyn else enum extern fn for if impl in let loop
      match mod move mut pub ref return self Self static struct super trait type union unsafe
      use where while`),
    literals: words('true false'),
  },
  java: {
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    tripleQuotes: ['"""'],
    attribute: /^@[A-Za-z_$][\w$.]*/,
    keywords: words(`
      abstract assert break case catch class continue default do else enum extends final
      finally for if implements import instanceof interface native new package private
      protected public return static strictfp super switch synchronized this throw throws
      transient try var void volatile while record sealed permits yield
      boolean byte char double float int long short`),
    literals: words(C_LIKE_LITERALS),
  },
  kotlin: {
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    tripleQuotes: ['"""'],
    attribute: /^@[A-Za-z_][\w.]*/,
    keywords: words(`
      abstract annotation as break by catch class companion const constructor continue crossinline
      data do else enum expect external final finally for fun get if import in infix init inline
      inner interface internal is lateinit noinline object open operator out override package
      private protected public reified return sealed set super suspend this throw try typealias
      val value var vararg when where while`),
    literals: words(C_LIKE_LITERALS),
  },
  csharp: {
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    tripleQuotes: ['"""'],
    keywords: words(`
      abstract as async await base bool break byte case catch char checked class const continue
      decimal default delegate do double else enum event explicit extern finally fixed float for
      foreach get goto if implicit in init int interface internal is lock long namespace new
      object operator out override params private protected public readonly record ref required
      return sbyte sealed set short sizeof stackalloc static string struct switch this throw try
      typeof uint ulong unchecked unsafe ushort using var virtual void volatile when while yield`),
    literals: words(C_LIKE_LITERALS),
  },
  cpp: {
    lineComments: ['//'],
    blockComment: ['/*', '*/'],
    quotes: ['"', "'"],
    directive: /^\s*#\s*\w+/,
    keywords: words(`
      alignas alignof and asm auto bool break case catch char class concept const consteval
      constexpr constinit const_cast continue co_await co_return co_yield decltype default delete
      do double dynamic_cast else enum explicit export extern float for friend goto if inline int
      long mutable namespace new noexcept not operator or override private protected public
      register reinterpret_cast requires return short signed sizeof static static_assert
      static_cast struct switch template this thread_local throw try typedef typeid typename
      union unsigned using virtual void volatile while final`),
    literals: words('true false nullptr NULL'),
  },
  sql: {
    lineComments: ['--'],
    blockComment: ['/*', '*/'],
    quotes: ["'", '"'],
    caseInsensitive: true,
    keywords: words(`
      add all alter and as asc begin between by case cast check column commit constraint create
      cross database default delete desc distinct drop else end exists foreign from full group
      having if in index inner insert into is join key left like limit not offset on or order
      outer primary references replace returning right rollback select set table then transaction
      trigger union unique update using values view when where with without rowid autoincrement
      pragma integer int text real blob numeric varchar char boolean date timestamp`),
    literals: words('true false null'),
  },
};

const EXTENSION_LANGUAGE = {
  '.ts': 'javascript',
  '.tsx': 'javascript',
  '.mts': 'javascript',
  '.cts': 'javascript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.cs': 'csharp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.h': 'cpp',
  '.c': 'cpp',
  '.sql': 'sql',
};

/** The highlighter's language key for a file path, or `null` when it is not supported. */
export function languageForFile(file) {
  if (typeof file !== 'string') return null;
  const dot = file.lastIndexOf('.');
  if (dot < 0 || file.lastIndexOf('/') > dot || file.lastIndexOf('\\') > dot) return null;
  return EXTENSION_LANGUAGE[file.slice(dot).toLowerCase()] ?? null;
}

const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]{0,3}/;
const IDENTIFIER = /^[A-Za-z_$][\w$]*/;

/** Where `closer` first ends in `text` from `from`, honouring backslash escapes; -1 if it does not. */
function findClose(text, from, closer, escapes) {
  for (let index = from; index < text.length; index += 1) {
    if (escapes && text[index] === '\\') {
      index += 1;
    } else if (text.startsWith(closer, index)) {
      return index + closer.length;
    }
  }
  return -1;
}

/**
 * Tokenise one line.
 *
 * `state` is what the previous line left open — `null`, `{ kind: 'comment', closer }`, or
 * `{ kind: 'string', closer }` — and the returned `state` is what this line leaves open, so a
 * caller can thread it through consecutive lines. Tokens are `{ text, type }`; `type` is
 * `null` for plain text.
 */
export function tokenizeLine(line, language, state = null) {
  const spec = LANGUAGES[language];
  if (!spec) return { tokens: [{ text: line, type: null }], state: null };

  const tokens = [];
  let plain = '';
  const flush = () => {
    if (plain) tokens.push({ text: plain, type: null });
    plain = '';
  };
  const emit = (text, type) => {
    flush();
    tokens.push({ text, type });
  };

  let position = 0;
  let open = state;

  if (open) {
    const end = findClose(line, 0, open.closer, open.kind === 'string');
    if (end < 0) return { tokens: [{ text: line, type: open.kind }], state: open };
    emit(line.slice(0, end), open.kind);
    position = end;
    open = null;
  }

  if (spec.directive) {
    const directive = spec.directive.exec(line.slice(position));
    if (directive && position === 0) {
      emit(directive[0], 'meta');
      position = directive[0].length;
    }
  }

  while (position < line.length) {
    const rest = line.slice(position);
    const char = rest[0];

    const lineComment = spec.lineComments.find((prefix) => rest.startsWith(prefix));
    if (lineComment) {
      emit(rest, 'comment');
      position = line.length;
      break;
    }

    if (spec.blockComment && rest.startsWith(spec.blockComment[0])) {
      const [opener, closer] = spec.blockComment;
      const end = findClose(line, position + opener.length, closer, false);
      if (end < 0) {
        emit(rest, 'comment');
        open = { kind: 'comment', closer };
        position = line.length;
        break;
      }
      emit(line.slice(position, end), 'comment');
      position = end;
      continue;
    }

    const triple = spec.tripleQuotes?.find((quote) => rest.startsWith(quote));
    if (triple) {
      const end = findClose(line, position + triple.length, triple, true);
      if (end < 0) {
        emit(rest, 'string');
        open = { kind: 'string', closer: triple };
        position = line.length;
        break;
      }
      emit(line.slice(position, end), 'string');
      position = end;
      continue;
    }

    if (char === "'" && spec.charLiteral) {
      const literal = spec.charLiteral.exec(rest);
      if (literal) {
        emit(literal[0], 'string');
        position += literal[0].length;
      } else {
        plain += char;
        position += 1;
      }
      continue;
    }

    if (spec.quotes.includes(char)) {
      const end = findClose(line, position + 1, char, true);
      if (end < 0) {
        emit(rest, 'string');
        // A backtick template can run on; every other string ends with its line.
        if (spec.multilineQuotes?.includes(char)) open = { kind: 'string', closer: char };
        position = line.length;
        break;
      }
      emit(line.slice(position, end), 'string');
      position = end;
      continue;
    }

    if (spec.attribute && (char === '@' || char === '#')) {
      const attribute = spec.attribute.exec(rest);
      if (attribute) {
        emit(attribute[0], 'meta');
        position += attribute[0].length;
        continue;
      }
    }

    if (/\d/.test(char)) {
      const number = NUMBER.exec(rest);
      if (number) {
        emit(number[0], 'number');
        position += number[0].length;
        continue;
      }
    }

    const identifier = IDENTIFIER.exec(rest);
    if (identifier) {
      const word = identifier[0];
      const lookup = spec.caseInsensitive ? word.toLowerCase() : word;
      const after = rest.slice(word.length);
      let type = null;
      if (spec.keywords.has(lookup)) type = 'keyword';
      else if (spec.literals.has(lookup)) type = 'literal';
      else if (/^\s*\(/.test(after) || (spec.macroBang && /^!\s*[([{]/.test(after))) type = 'function';
      else if (/^[A-Z]/.test(word) && /[a-z]/.test(word)) type = 'type';
      if (type === 'function' && spec.macroBang && after.startsWith('!')) {
        emit(word + '!', 'function');
        position += word.length + 1;
        continue;
      }
      if (type) emit(word, type);
      else plain += word;
      position += word.length;
      continue;
    }

    plain += char;
    position += 1;
  }

  flush();
  return { tokens, state: open };
}

/**
 * Tokenise consecutive lines, threading open comments and multi-line strings from one to the
 * next. `null` when the language is unsupported, so callers fall back to plain text.
 */
export function highlightLines(lines, language) {
  if (!LANGUAGES[language]) return null;
  let state = null;
  return lines.map((line) => {
    const result = tokenizeLine(line, language, state);
    state = result.state;
    return result.tokens;
  });
}

/** Tokenise each line on its own — for a diff, whose lines are not consecutive source. */
export function highlightIsolated(lines, language) {
  if (!LANGUAGES[language]) return null;
  return lines.map((line) => tokenizeLine(line, language).tokens);
}
