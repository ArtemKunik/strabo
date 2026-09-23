import path from 'node:path';

/**
 * One navigable piece of evidence found in terminal output.
 *
 * `file` is the path exactly as it appeared, POSIX-normalised so a Windows drive path and
 * a POSIX path look the same to the UI. `line` is 1-based. `raw` is the resolved absolute
 * path when a root was supplied and the match was relative, otherwise the normalised path;
 * it is what an editor-open request would send.
 */
export interface Citation {
  file: string;
  line: number;
  col?: number;
  raw: string;
}

export interface FindCitationsOptions {
  /** Repository root used only to resolve a relative match into `raw`. */
  root?: string;
}

/** Hard cap so a pathological log cannot flood the UI or the JSON body. */
const MAX_CITATIONS = 200;

/** Noise that is never a project file worth opening. */
const NOISE_SEGMENTS = ['node_modules', 'vendor', 'dist', 'build', '.git'];

const URL_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;

/** A path immediately preceded by `//`, a scheme colon, or a word char is not a local file. */
const NOT_AFTER_URL = '(?<![/:\\w])';

/** A URL run whose inner `/`s the `NOT_AFTER_URL` rule cannot see around. */
const URL_RUN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

/**
 * Blank out URL runs, preserving length so every match index still maps to the original
 * text. A URL like `https://host/app.ts:10` would otherwise yield `host/app.ts:10`, because
 * the path body cannot contain the `//` that precedes it.
 */
function maskUrls(text: string): string {
  return text.replace(URL_RUN, (url) => ' '.repeat(url.length));
}

/**
 * A file path ending in a known-source extension, followed by `:line[:col]`.
 *
 * The path body allows Windows drive prefixes, `\` or `/` separators, spaces (a quoted or
 * plain path), and the usual path characters. Requiring a dotted, non-numeric extension is
 * what stops `12:30:45` in a timestamp and `http://host:8080` from matching.
 */
const EXTENSION = /[A-Za-z0-9_+-]+/;
const PATH_BODY = String.raw`(?:[A-Za-z]:)?(?:[^\s|<>"'()\[\]:]+[\\/])*[^\s|<>"'()\[\]:]+`;
const LOCATION = new RegExp(
  NOT_AFTER_URL +
    String.raw`(` +
    PATH_BODY +
    String.raw`\.` +
    EXTENSION.source +
    String.raw`):(\d+)(?::(\d+))?`,
  'g',
);

/**
 * Node/V8 style stack frame: `at fn (path:line:col)` or `at path:line:col`. The parenthesised
 * form is matched first so the frame's own text is skipped before the generic rule sees it.
 */
const FRAME_WITH_FN = new RegExp(
  String.raw`\bat\s+[^\s(]+[^\r\n(]*?\((` + PATH_BODY + String.raw`\.` + EXTENSION.source + String.raw`):(\d+):(\d+)\)`,
  'g',
);

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function hasNoise(file: string): boolean {
  const lower = file.toLowerCase();
  return NOISE_SEGMENTS.some((segment) => lower.includes(`${segment}/`) || lower.includes(`\\${segment}\\`));
}

function resolveRaw(root: string | undefined, file: string): string {
  // POSIX-normalised before the join so a Windows drive path resolves correctly on any host
  // and a relative match anchors at the repository root.
  const native = file.replace(/\//g, path.sep);
  if (!root) {
    return path.isAbsolute(native) ? path.normalize(native) : native;
  }
  if (path.isAbsolute(native)) {
    return path.normalize(native);
  }
  return path.resolve(root, native);
}

/**
 * Find `file:line[:col]` references and stack frames in terminal output.
 *
 * Matches are normalised to POSIX, filtered for URLs and dependency/build noise, deduped by
 * `file:line:col`, and returned in first-seen order, capped at {@link MAX_CITATIONS}. This is
 * pure string work — no filesystem access — so it is cheap to call on every output frame and
 * trivial to unit-test.
 */
export function findCitations(text: string, options: FindCitationsOptions = {}): Citation[] {
  if (!text) {
    return [];
  }
  // Indices stay aligned with `text` because masking preserves length.
  const searchable = maskUrls(text);
  const found: Citation[] = [];
  const seen = new Set<string>();
  const consumed: Array<{ start: number; end: number }> = [];

  const push = (file: string, lineText: string, colText?: string): void => {
    if (found.length >= MAX_CITATIONS) {
      return;
    }
    if (URL_PREFIX.test(file) || hasNoise(file)) {
      return;
    }
    const line = Number.parseInt(lineText, 10);
    if (!Number.isFinite(line) || line < 1) {
      return;
    }
    const col = colText === undefined ? undefined : Number.parseInt(colText, 10);
    if (colText !== undefined && (!Number.isFinite(col) || (col as number) < 1)) {
      return;
    }
    const normalised = toPosix(file);
    const key = `${normalised}:${line}:${col ?? ''}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    found.push({
      file: normalised,
      line,
      ...(col !== undefined ? { col } : {}),
      raw: resolveRaw(options.root, normalised),
    });
  };

  // Frames first: record their spans so the generic pass cannot re-match the inner path.
  for (const match of searchable.matchAll(FRAME_WITH_FN)) {
    const file = match[1];
    if (file === undefined) {
      continue;
    }
    push(file, match[2] ?? '', match[3]);
    if (match.index !== undefined) {
      consumed.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  for (const match of searchable.matchAll(LOCATION)) {
    const index = match.index;
    if (index !== undefined && consumed.some((span) => index >= span.start && index < span.end)) {
      continue;
    }
    const file = match[1];
    if (file === undefined) {
      continue;
    }
    push(file, match[2] ?? '', match[3]);
  }

  return found;
}

/**
 * Split text into literal runs and citation runs, in order.
 *
 * Server-side and self-contained: it demonstrates the intended presentation so the browser
 * can mirror it, but the UI module owns its own renderer. Each `citation` run carries the
 * full {@link Citation}; the UI wraps `text` in a link.
 */
export function linkifyCitations(text: string): Array<{ text: string; citation?: Citation }> {
  if (!text) {
    return [];
  }
  const segments: Array<{ text: string; citation?: Citation }> = [];
  // Masking URLs keeps positions aligned with `text`; findCitations re-filters the slice.
  const searchable = maskUrls(text);
  const matches = [...searchable.matchAll(LOCATION)];
  let cursor = 0;
  for (const match of matches) {
    const index = match.index;
    const file = match[1];
    if (index === undefined || file === undefined) {
      continue;
    }
    const citations = findCitations(match[0]);
    const citation = citations[0];
    if (!citation) {
      continue;
    }
    if (index > cursor) {
      segments.push({ text: text.slice(cursor, index) });
    }
    segments.push({ text: match[0], citation });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor) });
  }
  return segments;
}
