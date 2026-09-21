import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  highlightIsolated,
  highlightLines,
  languageForFile,
  tokenizeLine,
} from '../../ui/strabo-highlight.js';

type Token = { text: string; type: string | null };

const typed = (tokens: Token[]) => tokens.filter((token) => token.type).map((token) => `${token.type}:${token.text}`);

test('languageForFile maps the analysed extensions and rejects the rest', () => {
  assert.equal(languageForFile('src/lib.rs'), 'rust');
  assert.equal(languageForFile('ui/app.tsx'), 'javascript');
  assert.equal(languageForFile('a/b.PY'), 'python');
  assert.equal(languageForFile('schema.sql'), 'sql');
  assert.equal(languageForFile('README.md'), null);
  assert.equal(languageForFile('Makefile'), null);
  assert.equal(languageForFile('dir.v2/Makefile'), null);
  assert.equal(languageForFile(undefined), null);
});

test('tokens always concatenate back to the line', () => {
  const lines = [
    "let conn = Connection::open(\"x\")?; // done 'a",
    'const t = `a ${b} c`; /* x */ y',
    "  db: Arc<Mutex<'a, Conn>>,",
    '',
  ];
  for (const language of ['rust', 'javascript', 'python', 'cpp', 'sql']) {
    for (const line of lines) {
      const { tokens } = tokenizeLine(line, language);
      assert.equal(tokens.map((token: Token) => token.text).join(''), line);
    }
  }
});

test('Rust: keywords, calls, macros, types, comments, and char literals versus lifetimes', () => {
  const code = tokenizeLine('pub fn read_db(&self) -> &Arc<Mutex<Connection>> { println!("hi"); }', 'rust').tokens;
  assert.deepEqual(typed(code), [
    'keyword:pub',
    'keyword:fn',
    'function:read_db',
    'keyword:self',
    'type:Arc',
    'type:Mutex',
    'type:Connection',
    'function:println!',
    'string:"hi"',
  ]);
  // `'x'` is a char literal; `'a` in `<'a>` is a lifetime and stays plain.
  assert.deepEqual(typed(tokenizeLine("let c = 'x'; fn f<'a>() {}", 'rust').tokens), [
    'keyword:let',
    "string:'x'",
    'keyword:fn',
  ]);
  assert.deepEqual(typed(tokenizeLine('/// Returns the `db`', 'rust').tokens), ['comment:/// Returns the `db`']);
  assert.deepEqual(typed(tokenizeLine('#[derive(Debug)]', 'rust').tokens), ['meta:#[derive(Debug)]']);
});

test('TypeScript: strings with escapes, numbers, and literals', () => {
  const tokens = tokenizeLine("const n = 0x1F + 2.5e3; const s = 'it\\'s'; return null;", 'javascript').tokens;
  assert.deepEqual(typed(tokens), [
    'keyword:const',
    'number:0x1F',
    'number:2.5e3',
    'keyword:const',
    "string:'it\\'s'",
    'keyword:return',
    'literal:null',
  ]);
});

test('block comments carry across lines and close', () => {
  const lines = ['a /* start', 'still comment', 'end */ b'];
  const result = highlightLines(lines, 'javascript') as Token[][];
  assert.deepEqual(typed(result[0]), ['comment:/* start']);
  assert.deepEqual(typed(result[1]), ['comment:still comment']);
  assert.deepEqual(typed(result[2]), ['comment:end */']);
  assert.equal(result[2].at(-1)?.text, ' b');
});

test('Python triple-quoted strings span lines; decorators and # comments are recognised', () => {
  const result = highlightLines(['@app.route', 'def f():', '    """doc', '    more"""  # tail', '    return None'], 'python') as Token[][];
  assert.deepEqual(typed(result[0]), ['meta:@app.route']);
  assert.deepEqual(typed(result[1]), ['keyword:def', 'function:f']);
  assert.deepEqual(typed(result[2]), ['string:"""doc']);
  assert.deepEqual(typed(result[3]), ['string:    more"""', 'comment:# tail']);
  assert.deepEqual(typed(result[4]), ['keyword:return', 'literal:None']);
});

test('SQL keywords match case-insensitively and -- starts a comment', () => {
  assert.deepEqual(typed(tokenizeLine("SELECT id FROM t WHERE n = 'x' -- why", 'sql').tokens), [
    'keyword:SELECT',
    'keyword:FROM',
    'keyword:WHERE',
    "string:'x'",
    'comment:-- why',
  ]);
});

test('C++ preprocessor directives are meta', () => {
  assert.deepEqual(typed(tokenizeLine('#include <vector>', 'cpp').tokens), ['meta:#include']);
});

test('an unsupported language yields plain text and no highlighting', () => {
  assert.equal(highlightLines(['x'], 'nope'), null);
  assert.equal(highlightIsolated(['x'], 'nope'), null);
  assert.deepEqual(tokenizeLine('x = 1', 'nope').tokens, [{ text: 'x = 1', type: null }]);
});

test('highlightIsolated does not carry an open comment into the next line', () => {
  const result = highlightIsolated(['/* open', 'let x'], 'javascript') as Token[][];
  assert.deepEqual(typed(result[1]), ['keyword:let']);
});
