import fs from 'node:fs';
import path from 'node:path';

import { toPosix } from '../boundary/repository-root.ts';
import { excludedDirectory } from '../scan/exclusions.ts';
import type { ContractDefinition, ContractField } from '../types.ts';

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Source extensions whose language declares DTOs this pass can read.
 *
 * SQL is absent: a table is not a data-transfer object with a stable cross-repo id.
 */
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.kt',
  '.kts',
  '.java',
  '.cs',
  '.rs',
  '.cpp',
  '.cc',
  '.cxx',
  '.hpp',
  '.hh',
  '.hxx',
  '.h',
]);

/**
 * Extract data contracts from language-native DTO declarations.
 *
 * A DTO's id is its bare type name, because that is the only part two repositories share
 * when the same shape is declared in different languages or packages: a `User` in one
 * repository matches a `User` in another, so `computeContractDrift` can compare them. Only
 * shapes with a clear DTO reading are taken (a `data class`, a `record`, a `@dataclass`, an
 * exported interface, an accessor-shaped Java class, a named-field C++ `struct`); anything
 * ambiguous is skipped rather than guessed at. A file that is too large, has no readable
 * text, or fails to parse contributes nothing.
 */
export function extractLanguageContracts(root: string, repository: string): ContractDefinition[] {
  const contracts: ContractDefinition[] = [];
  for (const file of findSourceFiles(root)) {
    const content = readText(root, file);
    if (content === null) {
      continue;
    }
    try {
      contracts.push(...parseSource(repository, file, content));
    } catch {
      // A malformed source file is not a contract; it is reported as absent.
    }
  }
  return contracts;
}

/** Find candidate source files, pruning generated directories with the scanner's rules. */
export function findSourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      const relative = toPosix(path.relative(root, absolute));
      if (entry.isDirectory()) {
        if (excludedDirectory(relative)) {
          continue;
        }
        walk(absolute);
        continue;
      }
      if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push(relative);
      }
    }
  };
  walk(root);
  return found.sort();
}

function parseSource(repository: string, file: string, content: string): ContractDefinition[] {
  const extension = path.extname(file).toLowerCase();
  if (['.ts', '.tsx', '.mts', '.cts'].includes(extension)) {
    return parseTypeScript(repository, file, content, 'typescript');
  }
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    return parseTypeScript(repository, file, content, 'javascript');
  }
  if (extension === '.py') {
    return parsePython(repository, file, content);
  }
  if (extension === '.kt' || extension === '.kts') {
    return parseKotlin(repository, file, content);
  }
  if (extension === '.java') {
    return parseJava(repository, file, content);
  }
  if (extension === '.cs') {
    return parseCSharp(repository, file, content);
  }
  if (extension === '.rs') {
    return parseRust(repository, file, content);
  }
  if (['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h'].includes(extension)) {
    return parseCpp(repository, file, content);
  }
  return [];
}

function define(
  repository: string,
  file: string,
  format: ContractDefinition['format'],
  name: string,
  fields: ContractField[],
): ContractDefinition {
  return {
    id: name,
    format,
    repository,
    source: file,
    fields: fields
      .filter((field) => field.name !== '')
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// --- TypeScript / JavaScript -------------------------------------------------

/**
 * TypeScript interfaces and object type aliases.
 *
 * A member is `name: Type` (optionally `readonly`, optionally quoted). Method signatures and
 * nested object types are skipped: their braces are crossed but their members are not fields.
 */
function parseTypeScript(
  repository: string,
  file: string,
  content: string,
  format: ContractDefinition['format'],
): ContractDefinition[] {
  const contracts: ContractDefinition[] = [];
  const patterns = [
    /^[ \t]*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)\b[^{]*\{/gm,
    /^[ \t]*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=\s*\{/gm,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const open = (match.index ?? 0) + match[0].length - 1;
      const body = braceBlock(content, open);
      if (body === null) {
        continue;
      }
      const fields = bracedFields(body, typeScriptMember);
      if (fields.length > 0) {
        contracts.push(define(repository, file, format, match[1] ?? '', fields));
      }
    }
  }
  return contracts;
}

function typeScriptMember(line: string): ContractField | null {
  if (line.startsWith('[')) {
    return null;
  }
  const hit =
    /^(?:readonly\s+|declare\s+)?(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*(\?)?\s*:\s*(.+?);?$/.exec(
      line,
    );
  if (!hit) {
    return null;
  }
  const name = hit[1] ?? hit[2] ?? hit[3] ?? '';
  const type = clean(hit[5] ?? '');
  if (name === '' || type === '' || type.startsWith('{') || type.includes('(')) {
    return null;
  }
  return { name, type, required: !hit[4] };
}

// --- Python ------------------------------------------------------------------

/** `@dataclass` classes and pydantic `BaseModel` (or `TypedDict`) subclasses. */
function parsePython(repository: string, file: string, content: string): ContractDefinition[] {
  const lines = content.split(/\r?\n/);
  const contracts: ContractDefinition[] = [];
  const classPattern = /^([ \t]*)class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/;
  for (let index = 0; index < lines.length; index += 1) {
    const hit = classPattern.exec(lines[index] ?? '');
    if (!hit) {
      continue;
    }
    const indent = (hit[1] ?? '').length;
    const name = hit[2] ?? '';
    const bases = (hit[3] ?? '')
      .split(',')
      .map((base) => base.trim().split('.').pop() ?? '')
      .filter(Boolean);
    const isModel = bases.includes('BaseModel') || bases.includes('TypedDict');
    if (!isDataclassDecorated(lines, index, indent) && !isModel) {
      continue;
    }
    const fields = pythonFields(pythonBody(lines, index, indent));
    if (fields.length > 0) {
      contracts.push(define(repository, file, 'python', name, fields));
    }
  }
  return contracts;
}

function isDataclassDecorated(lines: string[], classIndex: number, indent: number): boolean {
  for (let index = classIndex - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') {
      continue;
    }
    if (line.length - line.trimStart().length > indent) {
      return false;
    }
    return /^@(?:[\w.]+\.)?dataclass\b/.test(line.trim());
  }
  return false;
}

/** The class body lines paired with their indentation. */
function pythonBody(
  lines: string[],
  classIndex: number,
  indent: number,
): Array<{ indent: number; text: string }> {
  const body: Array<{ indent: number; text: string }> = [];
  for (let index = classIndex + 1; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    if (raw.trim() === '') {
      body.push({ indent: -1, text: '' });
      continue;
    }
    const lineIndent = raw.length - raw.trimStart().length;
    if (lineIndent <= indent) {
      break;
    }
    body.push({ indent: lineIndent, text: raw.trim() });
  }
  return body;
}

function pythonFields(body: Array<{ indent: number; text: string }>): ContractField[] {
  const first = body.find((entry) => entry.text !== '');
  if (!first) {
    return [];
  }
  const fields: ContractField[] = [];
  for (const entry of body) {
    if (entry.indent !== first.indent || entry.text.startsWith('@')) {
      continue;
    }
    const hit = /^([A-Za-z_]\w*)\s*:\s*([^=]+?)(\s*=.+)?$/.exec(entry.text);
    if (!hit) {
      continue;
    }
    fields.push({ name: hit[1] ?? '', type: clean(hit[2] ?? ''), required: !hit[3] });
  }
  return fields;
}

// --- Kotlin ------------------------------------------------------------------

/**
 * A `data class`: the primary-constructor parameters plus any `val`/`var` properties in the
 * class body. Body properties are the schema too when they carry a serialised field, so a
 * `data class User(val id: Long) { val name: String = "" }` has both. Only depth-zero
 * property declarations are read; a local `val` inside a method is not a field.
 */
function parseKotlin(repository: string, file: string, content: string): ContractDefinition[] {
  const contracts: ContractDefinition[] = [];
  const pattern = /(?:^|\n)[ \t]*(?:@\w+(?:\([^)]*\))?[ \t]+)*data\s+class\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/g;
  for (const match of content.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const params = parenBlock(content, open);
    if (params === null) {
      continue;
    }
    const fields: ContractField[] = [];
    for (const param of splitTopLevel(params, ',')) {
      const hit = /(?:^|\s)(?:val|var)\s+([A-Za-z_]\w*)\s*:\s*(.+?)(\s*=.+)?$/.exec(stripAnnotations(param));
      if (!hit) {
        continue;
      }
      const type = clean(hit[2] ?? '');
      fields.push({ name: hit[1] ?? '', type, required: !hit[3] && !type.endsWith('?') });
    }
    const close = enclosedEnd(content, open, '(', ')');
    if (close !== null) {
      const bodyOpen = content.indexOf('{', close);
      const between = bodyOpen === -1 ? '' : content.slice(close + 1, bodyOpen);
      if (bodyOpen !== -1 && /^\s*(?::[^{}\n]*)?$/.test(between)) {
        const body = braceBlock(content, bodyOpen);
        if (body !== null) {
          fields.push(...kotlinBodyFields(body));
        }
      }
    }
    if (fields.length > 0) {
      contracts.push(define(repository, file, 'kotlin', match[1] ?? '', fields));
    }
  }
  return contracts;
}

function kotlinBodyFields(body: string): ContractField[] {
  const fields: ContractField[] = [];
  let depth = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = stripLineComment(raw).trim();
    if (line === '') {
      continue;
    }
    if (depth === 0) {
      const hit =
        /^(?:(?:private|public|protected|internal|lateinit|const|override)\s+)*(?:val|var)\s+([A-Za-z_]\w*)\s*:\s*(.+?)(\s*=.+)?$/.exec(
          stripAnnotations(line),
        );
      if (hit) {
        const type = clean(hit[2] ?? '');
        fields.push({ name: hit[1] ?? '', type, required: !hit[3] && !type.endsWith('?') });
      }
    }
    depth = Math.max(0, depth + countBraces(line));
  }
  return fields;
}

// --- Java --------------------------------------------------------------------

/**
 * Java `record` components, plus POJO classes.
 *
 * A POJO is read only when it has a clear accessor shape: at least one instance field, at
 * least one `get`/`is`/`set` accessor naming a declared field, and no method that is neither
 * an accessor, a constructor, nor `equals`/`hashCode`/`toString`/`canEqual`. A Lombok
 * annotation (`@Data`, `@Value`, `@Getter`, `@Setter`, `@Builder`) stands in for the
 * accessors it generates. `static` members are class state, not part of the transfer shape,
 * so they are ignored.
 */
function parseJava(repository: string, file: string, content: string): ContractDefinition[] {
  const contracts: ContractDefinition[] = [];
  const recordPattern =
    /(?:^|\n)[ \t]*(?:public\s+|protected\s+|private\s+)?record\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/g;
  for (const match of content.matchAll(recordPattern)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const params = parenBlock(content, open);
    if (params === null) {
      continue;
    }
    const fields = positionalFields(params, true);
    if (fields.length > 0) {
      contracts.push(define(repository, file, 'java', match[1] ?? '', fields));
    }
  }

  const classPattern =
    /(?:^|\n)[ \t]*(?:public\s+|protected\s+|private\s+|static\s+|final\s+|abstract\s+)*class\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?(?:[^{\n;]*)\{/g;
  for (const match of content.matchAll(classPattern)) {
    const name = match[1] ?? '';
    const open = (match.index ?? 0) + match[0].length - 1;
    const body = braceBlock(content, open);
    if (body === null) {
      continue;
    }
    const lines = content.split(/\r?\n/);
    const keywordAt = (match.index ?? 0) + match[0].indexOf('class');
    const classLine = content.slice(0, keywordAt).split('\n').length - 1;
    const fields = javaPojoFields(body, name, lines, classLine);
    if (fields !== null && fields.length > 0) {
      contracts.push(define(repository, file, 'java', name, fields));
    }
  }
  return contracts;
}

const JAVA_OBJECT_METHODS = new Set(['equals', 'hashCode', 'toString', 'canEqual']);

function javaPojoFields(
  body: string,
  className: string,
  lines: string[],
  classLine: number,
): ContractField[] | null {
  const fields: ContractField[] = [];
  const fieldNames = new Set<string>();
  const accessorTargets: string[] = [];
  let extraMethods = 0;
  let depth = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = stripLineComment(raw).trim();
    if (line === '') {
      continue;
    }
    if (depth === 0 && !line.startsWith('@')) {
      if (line.includes('(')) {
        const method = javaMethodName(line);
        if (method?.name === className) {
          // A constructor: allowed, and contributes no field.
        } else if (!method) {
          extraMethods += 1;
        } else if (JAVA_OBJECT_METHODS.has(method.name)) {
          // `equals`/`hashCode`/`toString` are allowed object protocol.
        } else {
          const target = javaAccessorTarget(method.name);
          if (target === null) {
            extraMethods += 1;
          } else {
            accessorTargets.push(target);
          }
        }
      } else {
        const field = javaField(line);
        if (field) {
          fields.push(field);
          fieldNames.add(field.name);
        }
      }
    }
    depth = Math.max(0, depth + countBraces(line));
  }

  const lombok = hasLombokAnnotation(lines, classLine);
  const matchedAccessor = accessorTargets.some((target) => fieldNames.has(target));
  if (extraMethods > 0 || !matchedAccessor) {
    return lombok ? fields : null;
  }
  return fields;
}

function javaMethodName(line: string): { name: string } | null {
  const hit =
    /^(?:(?:private|protected|public|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:[\w<>\[\].,?$]+\s+)?([A-Za-z_]\w*)\s*\(/.exec(
      line,
    );
  return hit ? { name: hit[1] ?? '' } : null;
}

function javaAccessorTarget(name: string): string | null {
  if (name.length > 3 && (name.startsWith('get') || name.startsWith('set'))) {
    return decapitalise(name.slice(3));
  }
  if (name.length > 2 && name.startsWith('is')) {
    return decapitalise(name.slice(2));
  }
  return null;
}

function decapitalise(name: string): string {
  return name.length > 1 && name[1] === name[1]?.toUpperCase()
    ? name
    : name.charAt(0).toLowerCase() + name.slice(1);
}

function javaField(line: string): ContractField | null {
  if (!line.endsWith(';')) {
    return null;
  }
  const declared = line.slice(0, -1).trim();
  if (/\bstatic\b/.test(declared)) {
    return null;
  }
  const hit =
    /^(?:(?:private|protected|public|final|volatile|transient|synchronized)\s+)*([\w<>\[\].,?$]+)\s+([A-Za-z_]\w*)\s*(?:=\s*.+)?$/.exec(
      declared,
    );
  if (!hit) {
    return null;
  }
  return { name: hit[2] ?? '', type: clean(hit[1] ?? ''), required: true };
}

function hasLombokAnnotation(lines: string[], classLine: number): boolean {
  for (let index = classLine - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim();
    if (line === '') {
      continue;
    }
    if (!line.startsWith('@')) {
      return false;
    }
    if (
      /^@(?:[\w.]+\.)?(Data|Value|Getter|Setter|Builder|AllArgsConstructor|RequiredArgsConstructor)\b/.test(
        line,
      )
    ) {
      return true;
    }
  }
  return false;
}

// --- C# ----------------------------------------------------------------------

/** C# `record` (and `record class` / `record struct`) primary-constructor parameters. */
function parseCSharp(repository: string, file: string, content: string): ContractDefinition[] {
  const contracts: ContractDefinition[] = [];
  const pattern =
    /(?:^|\n)[ \t]*(?:public\s+|internal\s+|private\s+|protected\s+|sealed\s+|abstract\s+|partial\s+)*record\s+(?:class\s+|struct\s+)?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/g;
  for (const match of content.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const params = parenBlock(content, open);
    if (params === null) {
      continue;
    }
    const fields = positionalFields(params, false);
    if (fields.length > 0) {
      contracts.push(define(repository, file, 'csharp', match[1] ?? '', fields));
    }
  }
  return contracts;
}

/** `Type name` parameters; a trailing `?` or `= default` means not required. */
function positionalFields(params: string, javaDefaults: boolean): ContractField[] {
  const fields: ContractField[] = [];
  for (const param of splitTopLevel(params, ',')) {
    const withoutDefault = stripAnnotations(param);
    const equals = topLevelIndex(withoutDefault, '=');
    const declared = (equals === -1 ? withoutDefault : withoutDefault.slice(0, equals)).trim();
    const hit = /^(.+?)\s+([A-Za-z_]\w*)$/.exec(declared);
    if (!hit) {
      continue;
    }
    const type = clean(hit[1] ?? '');
    fields.push({
      name: hit[2] ?? '',
      type,
      required: javaDefaults ? !type.endsWith('?') : equals === -1 && !type.endsWith('?'),
    });
  }
  return fields;
}

// --- Rust --------------------------------------------------------------------

/** Rust named-field structs. Tuple structs are skipped: their fields have no names. */
function parseRust(repository: string, file: string, content: string): ContractDefinition[] {
  const contracts: ContractDefinition[] = [];
  const pattern = /(?:^|\n)[ \t]*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\{/g;
  for (const match of content.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const body = braceBlock(content, open);
    if (body === null) {
      continue;
    }
    const fields = bracedFields(body, rustMember);
    if (fields.length > 0) {
      contracts.push(define(repository, file, 'rust', match[1] ?? '', fields));
    }
  }
  return contracts;
}

function rustMember(line: string): ContractField | null {
  if (line.startsWith('#') || line.startsWith('/')) {
    return null;
  }
  const hit = /^(?:pub(?:\([^)]*\))?\s+)?([A-Za-z_]\w*)\s*:\s*(.+?),?$/.exec(line);
  if (!hit) {
    return null;
  }
  const type = clean(hit[2] ?? '');
  return { name: hit[1] ?? '', type, required: !/^Option\s*</.test(type) };
}

// --- C++ ---------------------------------------------------------------------

/**
 * C++ `struct` declarations with named fields. A struct is the DTO idiom in C++; a method
 * (`(`) or a nested brace is skipped, and a `static` member is class state rather than part
 * of the transfer shape. `typedef struct { ... } Point;` has no tag to name it, so it is
 * skipped rather than given a guessed id.
 */
function parseCpp(repository: string, file: string, content: string): ContractDefinition[] {
  const contracts: ContractDefinition[] = [];
  const pattern =
    /(?:^|\n)[ \t]*(?:typedef\s+)?(?:template\s*<[^>]*>\s*)?struct\s+([A-Za-z_]\w*)\s*(?::[^{\n;]*)?\{/g;
  for (const match of content.matchAll(pattern)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const body = braceBlock(content, open);
    if (body === null) {
      continue;
    }
    const fields = bracedFields(body, cppMember);
    if (fields.length > 0) {
      contracts.push(define(repository, file, 'cpp', match[1] ?? '', fields));
    }
  }
  return contracts;
}

function cppMember(line: string): ContractField | null {
  if (line.includes('(') || line.includes('{') || line.includes('}')) {
    return null;
  }
  const declared = line.replace(/;$/, '').trim();
  if (declared.endsWith(':')) {
    return null;
  }
  const equals = topLevelIndex(declared, '=');
  const withoutInitializer = (equals === -1 ? declared : declared.slice(0, equals)).trim();
  const hit = /^(.*?)\s*([A-Za-z_]\w*)$/.exec(withoutInitializer);
  if (!hit) {
    return null;
  }
  const type = clean(hit[1] ?? '');
  if (type === '' || /\b(static|friend|typedef|using|template|virtual|operator)\b/.test(type)) {
    return null;
  }
  return { name: hit[2] ?? '', type, required: true };
}

// --- shared ------------------------------------------------------------------

/**
 * Fields from a brace-delimited block whose members are one line each, stopping at any
 * nested brace (a nested object is not a field).
 */
function bracedFields(body: string, parse: (line: string) => ContractField | null): ContractField[] {
  const fields: ContractField[] = [];
  let depth = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = stripLineComment(raw).trim();
    if (line === '') {
      continue;
    }
    if (depth === 0) {
      const field = parse(line);
      if (field) {
        fields.push(field);
      }
    }
    depth = Math.max(0, depth + countBraces(line));
  }
  return fields;
}

/** The substring inside the braces that open at `openIndex`, or null when unbalanced. */
function braceBlock(content: string, openIndex: number): string | null {
  return enclosed(content, openIndex, '{', '}');
}

/** The substring inside the parentheses that open at `openIndex`, or null when unbalanced. */
function parenBlock(content: string, openIndex: number): string | null {
  return enclosed(content, openIndex, '(', ')');
}

function enclosed(content: string, openIndex: number, open: string, close: string): string | null {
  const end = enclosedEnd(content, openIndex, open, close);
  return end === null ? null : content.slice(openIndex + 1, end);
}

/** The index of the `close` that matches the `open` at `openIndex`, or null. */
function enclosedEnd(
  content: string,
  openIndex: number,
  open: string,
  close: string,
): number | null {
  if (content[openIndex] !== open) {
    return null;
  }
  let depth = 0;
  for (let index = openIndex; index < content.length; index += 1) {
    const character = content[index];
    if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return null;
}

/** Split on `separator` at the top level, ignoring `()[]{}<>` nesting. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if ('([{<'.includes(character)) {
      depth += 1;
    } else if (')]}>'.includes(character)) {
      depth = Math.max(0, depth - 1);
    }
    if (character === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/** The index of `needle` at the top level, or -1. */
function topLevelIndex(text: string, needle: string): number {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if ('([{<'.includes(character)) {
      depth += 1;
    } else if (')]}>'.includes(character)) {
      depth = Math.max(0, depth - 1);
    } else if (character === needle && depth === 0) {
      return index;
    }
  }
  return -1;
}

function stripAnnotations(text: string): string {
  return text.replace(/@[\w.]+(?:\s*\([^)]*\))?\s*/g, '').trim();
}

function stripLineComment(line: string): string {
  const marker = line.indexOf('//');
  return marker === -1 ? line : line.slice(0, marker);
}

function countBraces(line: string): number {
  let count = 0;
  for (const character of line) {
    if (character === '{') {
      count += 1;
    } else if (character === '}') {
      count -= 1;
    }
  }
  return count;
}

function clean(type: string): string {
  return type.trim().replace(/;$/, '').replace(/\s+/g, ' ');
}

function readText(root: string, file: string): string | null {
  try {
    const absolute = path.join(root, file);
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_BYTES) {
      return null;
    }
    const content = fs.readFileSync(absolute);
    return content.includes(0) ? null : content.toString('utf8');
  } catch {
    return null;
  }
}
