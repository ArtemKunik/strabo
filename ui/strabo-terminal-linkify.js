/**
 * Citation linkification for the terminal.
 *
 * The server's source viewer accepts `path:line[:col]` citations; the same shape shows up in
 * compiler output and stack frames. This module mirrors those rules so a path printed by a
 * tool is clickable and opens the file at its line. The matcher is pure and exported; the
 * xterm link provider is a thin adapter around it.
 *
 * Deliberately conservative: a URL (`https://host/a.ts:1`) and any `node_modules` path are
 * rejected, because those are not the repository's own files.
 */

// The leading guard rejects a match that starts mid-token or inside a URL: a `/`, `:`, or
// `.` immediately before the path means it is a host or a continuation, not a citation.
const CITATION_PATTERN =
  /(?<![\w:/.\\])((?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?(?:[\w.@~+-]+[\\/])*[\w.@~+-]+\.[A-Za-z0-9]+):(\d+)(?::(\d+))?/g;

/** Dependency and build noise the server also refuses to treat as a project file. */
const NOISE_SEGMENTS = ['node_modules', 'vendor', 'dist', 'build', '.git'];

/** True when a matched path is not a repository file the viewer can open. */
function isRejected(path) {
  const lower = path.toLowerCase();
  if (lower.includes('://')) {
    return true;
  }
  return NOISE_SEGMENTS.some(
    (segment) => lower.includes(`${segment}/`) || lower.includes(`${segment}\\`),
  );
}

/**
 * Every citation in `text`, in order. `index` and `length` are character offsets into `text`
 * so a link range can be built from them; `column` is null when the citation names only a line.
 */
export function findCitations(text) {
  if (typeof text !== 'string' || text === '') {
    return [];
  }
  const out = [];
  CITATION_PATTERN.lastIndex = 0;
  let match = CITATION_PATTERN.exec(text);
  while (match !== null) {
    const [full, path, line, column] = match;
    const lineNumber = Number(line);
    // A line number is 1-based, matching the server's citation rules.
    if (!isRejected(path) && lineNumber >= 1) {
      out.push({
        index: match.index,
        length: full.length,
        path,
        line: lineNumber,
        column: column === undefined ? null : Number(column),
        text: full,
      });
    }
    // A zero-length match cannot happen with this pattern, but guard the loop regardless.
    if (match.index === CITATION_PATTERN.lastIndex) {
      CITATION_PATTERN.lastIndex += 1;
    }
    match = CITATION_PATTERN.exec(text);
  }
  return out;
}

/**
 * Register an xterm link provider that turns citations into clickable ranges.
 *
 * `openSourceAt(file, line)` is the host hook; the provider passes the path exactly as it was
 * printed (the host resolves it against the repository). Returns a dispose function.
 */
export function registerCitationLinks(term, { openSourceAt } = {}) {
  if (!term || typeof term.registerLinkProvider !== 'function') {
    return () => {};
  }
  const provider = {
    provideLinks(bufferLineNumber, callback) {
      const buffer = term.buffer?.active;
      const line = buffer?.getLine?.(bufferLineNumber - 1);
      const text = line?.translateToString?.(true) ?? '';
      const citations = findCitations(text);
      if (citations.length === 0) {
        callback(undefined);
        return;
      }
      callback({
        links: citations.map((citation) => ({
          range: {
            start: { x: citation.index + 1, y: bufferLineNumber },
            end: { x: citation.index + citation.length, y: bufferLineNumber },
          },
          text: citation.text,
          decorations: { underline: true, pointerCursor: true },
          activate: () => openSourceAt?.(citation.path, citation.line),
        })),
      });
    },
  };
  const disposable = term.registerLinkProvider(provider);
  return () => disposable?.dispose?.();
}
