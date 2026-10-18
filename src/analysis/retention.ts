import type { CodeSymbol, FunctionCall } from '../scan/languages/symbols.ts';

/**
 * Resource retention: what a file holds, and whether anything recorded releases it.
 *
 * The rest of Strabo's cost vocabulary is a *compute* reading — a nested loop, a long body,
 * a linear scan. This module is the other axis: a *lifetime* reading. It answers "which
 * heavy-weight resource does this file keep in a field, who can reach the load, and is there
 * a recorded release?" It never measures a heap, never runs the program, and never calls a
 * retained field a leak: every fact names the declaration and line that produced it.
 *
 * Pure: no I/O, no disk, no clock. The caller extracts the symbols and passes them in.
 *
 * What this reading cannot see is listed in `unavailable` rather than guessed at. The two
 * that matter most: the symbol extractors do not record *process* lifetime (a Kotlin
 * `object` and a `class` are both `kind: 'type'`), so a retained field is reported
 * field-scoped; and a release performed through a lambda receiver, a framework, or another
 * file is not recorded, so `no-release-path` means "not recorded here", not "never released".
 */

/** The heavy-weight resource families this reading recognises, from a recorded type name. */
export type RetentionKind =
  | 'engine'
  | 'native-model'
  | 'bitmap'
  | 'connection'
  | 'file-read'
  | 'stream'
  | 'listener'
  | 'collection';

/**
 * Tokens in a declared type that name a resource family.
 *
 * Matched against camel-split, lower-cased tokens of the declared type, so `CachedEngine`
 * yields `engine` and `MutableList<Word>` yields `list` (and `word`). Name-based and
 * therefore a signal, not a verdict: a type called `Model` that holds no model is still
 * reported, with its declaration as the evidence.
 */
export const RETENTION_TYPE_TOKENS: Readonly<Record<RetentionKind, readonly string[]>> = {
  engine: ['engine', 'renderer', 'player', 'exoplayer', 'filament', 'glsurfaceview'],
  'native-model': ['model', 'llm', 'litert', 'interpreter', 'tflite', 'onnx', 'tokenizer'],
  bitmap: ['bitmap', 'drawable', 'picture', 'image'],
  connection: ['connection', 'socket', 'client', 'database', 'datasource', 'dao', 'session'],
  'file-read': ['filereader', 'bufferedreader', 'inputstream', 'randomaccessfile', 'filechannel'],
  stream: ['stream', 'channel', 'cursor', 'reader', 'writer'],
  listener: ['listener', 'callback', 'observer', 'subscriber', 'subscription', 'disposable', 'watcher'],
  collection: [
    'list', 'mutablelist', 'arraylist', 'linkedlist', 'map', 'mutablemap', 'hashmap', 'set',
    'mutableset', 'hashset', 'array', 'arraylist', 'deque', 'queue', 'vector', 'buffer',
    'stringbuilder', 'sparsearray',
  ],
};

/**
 * Recorded callee/method names that release or close a resource.
 *
 * A release reached through a lambda receiver (`cached?.let { it.close() }`) or another file
 * is not recorded, so an empty result is `no release path recorded`, never "leaked".
 */
export const RELEASE_CALLS: readonly string[] = [
  'close', 'release', 'dispose', 'free', 'shutdown', 'destroy', 'cancel', 'terminate',
  'quit', 'unbind', 'detach', 'unregister', 'unsubscribe', 'removelistener',
];

/** Recorded calls that add to a collection, when made on the field's own receiver. */
export const APPEND_CALLS: readonly string[] = [
  'add', 'addall', 'put', 'putall', 'append', 'push', 'offer', 'enqueue', 'insert', 'addlast',
];

/** Recorded calls that remove from or bound a collection. */
export const EVICT_CALLS: readonly string[] = [
  'remove', 'removeat', 'removeall', 'removefirst', 'removelast', 'clear', 'evict', 'delete',
  'drop', 'pop', 'poll', 'truncate', 'trimtosize',
];

/** Recorded callee names that read a whole file, asset, or blob into memory. */
export const READ_ALL_CALLS: readonly string[] = [
  'readbytes', 'readtext', 'readallbytes', 'readstring', 'readlines', 'getbytes', 'readfile',
  'slurp',
];

/** Recorded callee names that copy bytes into a second buffer. */
export const COPY_CALLS: readonly string[] = [
  'allocatedirect', 'copyof', 'copyofrange', 'copyinto', 'wrap', 'asreadonlybuffer',
  'newarray', 'clone',
];

/** Method-name tokens that read as a check, probe, or validation rather than real work. */
export const VALIDATION_TOKENS: readonly string[] = [
  'validate', 'validation', 'valid', 'check', 'probe', 'verify', 'isvalid', 'ensure', 'inspect',
  'preview', 'canload', 'canrun', 'diagnose', 'health',
];

/** Callee/method tokens that load or initialise something heavy. */
export const LOAD_TOKENS: readonly string[] = [
  'initialize', 'init', 'load', 'loadmodel', 'open', 'connect', 'instantiate', 'warmup',
  'start', 'prepare', 'getengine',
];

/** One resource the file holds in a recorded field. */
export interface RetentionFact {
  file: string;
  /** 1-based line of the field declaration. */
  line: number;
  kind: RetentionKind;
  /** The field that holds it, as declared. */
  symbol: string;
  /** The declaring type, when the extractor recorded one. */
  ownerType?: string;
  /** The declared type text, verbatim. */
  type: string;
  /** How the fact was read: the declaration, or the holder that reaches a heavy field. */
  evidence: string;
  /** Lines of recorded calls that release it (`close`, `dispose`, `evict`, …). */
  releaseSites: number[];
  /** The release method names recorded at those lines. */
  releaseCalls: string[];
}

export type RetentionSignalKind =
  | 'field-retained-resource'
  | 'no-release-path'
  | 'unbounded-collection'
  | 'eager-load-on-validation'
  | 'double-materialisation'
  | 'listener-without-removal';

/** A recorded fact crossing a documented line, with the evidence that produced it. */
export interface RetentionSignal {
  kind: RetentionSignalKind;
  line: number;
  detail: string;
  /** The field the signal is attributed to, when it names one. */
  symbol?: string;
}

export interface RetentionReport {
  file: string;
  available: boolean;
  /** Set when the reading is unavailable; the caller names the reason. */
  reason?: string;
  facts: RetentionFact[];
  signals: RetentionSignal[];
  /** What this reading could not see, named rather than assumed. */
  unavailable: string[];
}

/** Human-readable label per signal, for a passport, panel, or prompt. */
export const RETENTION_SIGNAL_LABELS: Record<RetentionSignalKind, string> = {
  'field-retained-resource': 'Heavy-weight resource held in a field',
  'no-release-path': 'No release path recorded',
  'unbounded-collection': 'Unbounded collection',
  'eager-load-on-validation': 'Heavy load reached from a validation',
  'double-materialisation': 'Whole-file read copied into a second buffer',
  'listener-without-removal': 'Listener registered without removal',
};

/** Precedence when a declared type matches more than one family (`List<Engine>`). */
const KIND_PRECEDENCE: readonly RetentionKind[] = [
  'engine',
  'native-model',
  'bitmap',
  'connection',
  'file-read',
  'stream',
  'listener',
  'collection',
];

/**
 * Camel-split, lower-cased tokens of a type or call text.
 *
 * `CachedEngine?` yields `cached`, `engine`, so a holder reaches the resource it wraps;
 * `MutableList<Word>` yields `mutable`, `list`, `word`.
 */
export function retentionTokens(text: string): string[] {
  return text
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .map((token) => token.toLowerCase())
    .filter((token) => token !== '');
}

/**
 * The simple type name a declared type text names.
 *
 * Generic arguments are dropped first, then qualifiers, so `CachedEngine?` yields
 * `CachedEngine`, `MutableList<Word>` yields `MutableList`, and
 * `com.acme.GenerativeModel` yields `GenerativeModel`. This is what lets a field be matched
 * to a type the same file declares without a generic argument (`Word` in `List<Word>`) or a
 * package prefix deciding it.
 */
export function declaredTypeName(text: string): string {
  const withoutGenerics = text.split('<')[0] ?? '';
  const simple = withoutGenerics.split('.').pop() ?? withoutGenerics;
  return simple.replace(/[^A-Za-z0-9_]/g, '');
}

/**
 * Whether a type or call text names something in `set`.
 *
 * Matched three ways so both a whole name and a camel-split part count: `readBytes` matches
 * `readbytes`, `allocateDirect` matches `allocatedirect`, and a declared `CachedEngine`
 * matches `engine` through its tokens. `FunctionCall.method` is the *enclosing* method, so
 * only `callee` is ever matched against a name set.
 */
function matchesSet(text: string, set: readonly string[]): boolean {
  const tokens = retentionTokens(text);
  return (
    set.includes(text.toLowerCase()) ||
    set.includes(tokens.join('')) ||
    tokens.some((token) => set.includes(token))
  );
}

function kindOfType(text: string): RetentionKind | null {
  for (const kind of KIND_PRECEDENCE) {
    if (matchesSet(text, RETENTION_TYPE_TOKENS[kind])) {
      return kind;
    }
  }
  return null;
}

function isOnField(call: FunctionCall, field: string): boolean {
  return call.receiver === field;
}

/** Fields of one owner name, from the recorded (possibly nested) owner label. */
function fieldsOfOwner(symbols: readonly CodeSymbol[], owner: string): CodeSymbol[] {
  return symbols.filter(
    (symbol) => isField(symbol) && (symbol.owner === owner || symbol.owner.endsWith(`.${owner}`)),
  );
}

function isField(symbol: CodeSymbol): boolean {
  return symbol.kind === 'field' || symbol.kind === 'property';
}

/**
 * Read what a file retains from its extracted symbols, calls, and member accesses.
 *
 * Every fact and signal names the declaration or call that produced it. A file with no
 * heavy-weight field returns empty lists and says so in `unavailable`, which the caller
 * renders as `no heavy-weight resource recorded`, never "safe".
 */
export function buildRetention(
  file: string,
  symbols: readonly CodeSymbol[],
  calls: readonly FunctionCall[] = [],
): RetentionReport {
  const fields = symbols.filter(isField);
  const types = symbols.filter((symbol) => symbol.kind === 'type');
  const facts: RetentionFact[] = [];

  for (const field of fields) {
    const declared = (field.type ?? '').trim();
    if (declared === '') {
      continue;
    }
    let kind = kindOfType(declared);
    let evidence = `declared type \`${declared}\``;

    // A type the file itself declares is read from its own fields, not from its name. A
    // `data class LocalModel(url: String, sizeBytes: Long)` is a value holder that *describes*
    // a model; calling it one because its name ends in `model` puts it at the top of a memory
    // ranking. So a declared type whose own records hold nothing heavy is not a resource. A
    // type the file does not declare (`Engine`, `OkHttpClient`) is judged by name as before,
    // because there is nothing else recorded to read.
    const wanted = declaredTypeName(declared);
    const local =
      wanted === ''
        ? undefined
        : types.find((candidate) => declaredTypeName(candidate.name) === wanted);
    if (local) {
      const own = fieldsOfOwner(symbols, local.name);
      const inner = own.find((candidate) => kindOfType(candidate.type ?? ''));
      if (inner) {
        kind = kindOfType(inner.type ?? '');
        evidence = `declared type \`${declared}\` holds \`${inner.type ?? ''}\` (declared in this file)`;
      } else if (own.length > 0) {
        continue;
      }
    }

    if (kind === null) {
      continue;
    }
    const releases = calls.filter(
      (call) => isOnField(call, field.name) && matchesSet(call.callee, RELEASE_CALLS),
    );
    facts.push({
      file,
      line: field.line,
      kind,
      symbol: field.name,
      ...(field.owner ? { ownerType: field.owner } : {}),
      type: declared,
      evidence,
      releaseSites: [...new Set(releases.map((call) => call.line))].sort((a, b) => a - b),
      releaseCalls: [...new Set(releases.map((call) => call.callee))].sort(),
    });
  }

  const signals: RetentionSignal[] = [];

  for (const fact of facts) {
    if (fact.kind === 'collection' || fact.kind === 'listener') {
      continue;
    }
    signals.push({
      kind: 'field-retained-resource',
      line: fact.line,
      symbol: fact.symbol,
      detail: `${fact.kind} \`${fact.type}\` held in \`${fact.symbol}\` (${fact.evidence})`,
    });
    if (fact.releaseSites.length === 0) {
      signals.push({
        kind: 'no-release-path',
        line: fact.line,
        symbol: fact.symbol,
        detail: `no recorded release call for \`${fact.symbol}\` in this file`,
      });
    }
  }

  for (const fact of facts.filter((entry) => entry.kind === 'collection')) {
    const onField = calls.filter((call) => isOnField(call, fact.symbol));
    const appends = onField.filter((call) => matchesSet(call.callee, APPEND_CALLS));
    const evicts = onField.filter((call) => matchesSet(call.callee, EVICT_CALLS));
    if (appends.length > 0 && evicts.length === 0) {
      signals.push({
        kind: 'unbounded-collection',
        line: fact.line,
        symbol: fact.symbol,
        detail: `\`${fact.symbol}\` is added to (${[...new Set(appends.map((call) => call.callee))].sort().join(', ')}) with no recorded cap, remove, or clear`,
      });
    }
  }

  for (const fact of facts.filter((entry) => entry.kind === 'listener')) {
    if (fact.releaseSites.length === 0) {
      signals.push({
        kind: 'listener-without-removal',
        line: fact.line,
        symbol: fact.symbol,
        detail: `\`${fact.symbol}\` is registered but no removal or unsubscribe is recorded`,
      });
    }
  }

  // A validation-shaped method that reaches a load: the cheap-looking entry that pays for it.
  for (const method of symbols.filter((symbol) => symbol.kind === 'method')) {
    const methodTokens = retentionTokens(method.name);
    if (!methodTokens.some((token) => VALIDATION_TOKENS.includes(token))) {
      continue;
    }
    const fromMethod = calls.filter(
      (call) => call.owner === method.owner && call.method === method.name,
    );
    const load = fromMethod.find((call) => matchesSet(call.callee, LOAD_TOKENS));
    if (load) {
      signals.push({
        kind: 'eager-load-on-validation',
        line: load.line,
        symbol: method.name,
        detail: `\`${method.name}\` calls \`${load.callee}\` (line ${load.line})`,
      });
    }
  }

  // A whole-file read and a buffer copy on one line. Lines cannot prove the nesting, so the
  // signal says "same line" rather than claiming the copy took the read's result.
  const byLine = new Map<number, FunctionCall[]>();
  for (const call of calls) {
    const bucket = byLine.get(call.line) ?? [];
    bucket.push(call);
    byLine.set(call.line, bucket);
  }
  for (const [line, lineCalls] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    const read = lineCalls.find((call) => matchesSet(call.callee, READ_ALL_CALLS));
    const copy = lineCalls.find((call) => matchesSet(call.callee, COPY_CALLS));
    if (read && copy && read !== copy) {
      signals.push({
        kind: 'double-materialisation',
        line,
        detail: 'a whole-file read and a buffer copy on the same line',
      });
    }
  }

  signals.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind) || (a.symbol ?? '').localeCompare(b.symbol ?? ''));

  return {
    file,
    available: true,
    facts: facts.sort((a, b) => a.line - b.line || a.symbol.localeCompare(b.symbol)),
    signals,
    unavailable: [
      'process lifetime is not recorded (a singleton holder reads as a plain type), so a retained field is reported field-scoped',
      'a release reached through a lambda receiver, a framework, or another file is not recorded, so "no release path" means "not recorded here"',
      'locals are not recorded as fields, so a short-lived resource is not reported',
      'native allocations behind an engine or player are not read',
      'a type the same file declares is read from its own recorded fields, so a value holder whose name matches a resource family is reported as a value, not as the resource',
      'a value type declared in another file is not known here, so a field whose type name matches a resource family is still reported when the type is not declared in this file',
      'a field with no declared type is read only when the extractor resolves its initializer to a type, which not every language records',
    ],
  };
}
