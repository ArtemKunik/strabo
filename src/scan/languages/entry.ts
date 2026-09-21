import type { CodeSymbol } from './symbols.ts';

/**
 * How a function is reachable without an in-file caller.
 *
 * A function the runtime or a framework invokes has no in-file caller by design, so
 * "no callers" is reserved for functions with none of these. Every entry carries the
 * evidence that proved it: the attribute text, the naming convention, or the line of
 * the passing site.
 */
export type EntryKind = 'test' | 'main' | 'handler' | 'passed-as-value';

export interface FunctionEntryMark {
  kind: EntryKind;
  /** The attribute, naming rule, or passing site that proved this is an entry. */
  evidence: string;
}

/** Framework call wrappers whose argument is a handler invoked by the framework. */
const TEST_ATTRIBUTE = /#\[.*test.*\]|@\S*test|\[(Test|TestMethod|Fact|Theory)/i;
const MAIN_ATTRIBUTE = /#\[tokio::main\]/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Mark entry-point functions on already-extracted method symbols.
 *
 * Textual and name-based on purpose: attributes (`#[test]`, `@Test`, `[Fact]`),
 * the `main` name, `test_*` names, and passed-by-reference sites (`::name`,
 * `get(name)`, `.route(..., name)`, `+= name`) are all visible without grammar
 * knowledge, and every mark carries its evidence. Idempotent: a symbol that
 * already carries an entry keeps it.
 */
export function markEntries(symbols: CodeSymbol[], content: string): void {
  const lines = content.split('\n');
  const methods = symbols.filter((symbol) => symbol.kind === 'method' && !symbol.entry);
  if (methods.length === 0) {
    return;
  }

  for (const symbol of methods) {
    const attributes = attributesAbove(lines, symbol.line);
    const testAttribute = attributes.find((line) => TEST_ATTRIBUTE.test(line));
    if (testAttribute) {
      symbol.entry = { kind: 'test', evidence: testAttribute.trim() };
      continue;
    }
    const mainAttribute = attributes.find((line) => MAIN_ATTRIBUTE.test(line));
    if (mainAttribute) {
      symbol.entry = { kind: 'main', evidence: mainAttribute.trim() };
      continue;
    }
    if (/^main$/i.test(symbol.name)) {
      symbol.entry = { kind: 'main', evidence: 'named main' };
      continue;
    }
    if (/^test_/.test(symbol.name)) {
      symbol.entry = { kind: 'test', evidence: 'named test_*' };
      continue;
    }
  }

  for (const symbol of methods) {
    if (symbol.entry) {
      continue;
    }
    const passing = findPassingSite(lines, symbol.name, symbol.line);
    if (passing) {
      symbol.entry = passing;
    }
  }
}

/**
 * The annotation lines attached to a 1-based declaration line.
 *
 * Two shapes occur: the annotation sits on its own lines above (Rust `#[test]`, a
 * Python decorator), or the grammar folds modifiers into the declaration node so the
 * node starts at the annotation itself (Java `@Test`, C# `[Fact]`). The first case
 * collects the contiguous annotation run directly above, tolerating blank lines; the
 * second collects the run downward from the declaration line. Collection stops at the
 * first code line either way, so a neighbouring function's attribute is never claimed.
 */
function attributesAbove(lines: string[], line: number): string[] {
  const isAttribute = (text: string): boolean => /^[@#\[]/.test(text);
  const own = (lines[line - 1] ?? '').trim();
  if (isAttribute(own)) {
    const found: string[] = [];
    for (let index = line - 1; index < lines.length; index += 1) {
      const text = (lines[index] ?? '').trim();
      if (!text) {
        continue;
      }
      if (!isAttribute(text)) {
        break;
      }
      found.push(text);
    }
    return found;
  }
  const found: string[] = [];
  for (let index = line - 2; index >= Math.max(0, line - 6); index -= 1) {
    const text = (lines[index] ?? '').trim();
    if (!text) {
      continue;
    }
    if (!isAttribute(text)) {
      break;
    }
    found.unshift(text);
  }
  return found;
}

/**
 * A site that passes `name` by reference rather than calling it: `::name`, a
 * framework wrapper such as `get(name)`, `.route(..., name)`, or `+= name`.
 * The declaration line itself never counts.
 */
function findPassingSite(
  lines: string[],
  name: string,
  declarationLine: number,
): FunctionEntryMark | null {
  if (!name) {
    return null;
  }
  const escaped = escapeRegExp(name);
  // A trailing `(` means a call, not a reference: `helper()` has a caller already.
  const value = `\\b${escaped}\\b(?!\\s*\\()`;
  const refPattern = new RegExp(`::${escaped}\\b(?!\\s*\\()`);
  const wrapperPattern = new RegExp(`\\b(get|post|put|delete|patch|options|head)\\s*\\([^)]*${value}`);
  const routePattern = new RegExp(`\\.route\\s*\\([^)]*${value}`);
  const subscribePattern = new RegExp(`\\+=\\s*${escaped}\\b`);
  // A named function handed to a test framework (`it('...', helper)`) is invoked
  // by the framework, exactly like an inline `it`/`test` body.
  const testWrapperPattern = new RegExp(`\\b(it|test|describe)(\\.\\w+)?\\s*\\([^)]*${value}`);
  for (let index = 0; index < lines.length; index += 1) {
    if (index + 1 === declarationLine) {
      continue;
    }
    const text = lines[index] ?? '';
    const testWrapper = testWrapperPattern.exec(text);
    if (testWrapper) {
      return { kind: 'test', evidence: `passed to ${testWrapper[1]} at L${index + 1}` };
    }
    if (refPattern.test(text)) {
      return { kind: 'passed-as-value', evidence: `passed as value at L${index + 1}` };
    }
    const wrapper = wrapperPattern.exec(text);
    if (wrapper) {
      return { kind: 'handler', evidence: `passed to ${wrapper[1]} at L${index + 1}` };
    }
    if (routePattern.test(text)) {
      return { kind: 'handler', evidence: `passed to route at L${index + 1}` };
    }
    if (subscribePattern.test(text)) {
      return { kind: 'passed-as-value', evidence: `passed as value at L${index + 1}` };
    }
  }
  return null;
}

/**
 * Mark functions defined as callbacks to `it(...)` / `test(...)` as test entries.
 *
 * The TypeScript extractor threads the call name while visiting, so an inline
 * `it('...', () => {...})` body is recorded with the framework call as evidence.
 */
export function testBodyEvidence(callName: string, line: number): FunctionEntryMark {
  return { kind: 'test', evidence: `${callName} body at L${line}` };
}

/** True when a call callee is a test-framework entry (`it`, `test`, `describe`). */
export function isTestFrameworkCall(callee: string): boolean {
  const head = callee.split('.')[0] ?? '';
  return head === 'it' || head === 'test' || head === 'describe';
}
