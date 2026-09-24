/**
 * The terminal→map control channel.
 *
 * The `strabo` shim on a session's PATH prints one marker line, `::strabo::<verb> <args>`, and
 * this module pulls those lines out of the session's output stream before it reaches xterm —
 * so the directive never shows on screen — and hands the parsed verb to the app. The verb set
 * is fixed here and enforced again by the host, so a session can only ask for safe,
 * read-only map actions, never execute anything.
 *
 * Extraction is line-oriented with a small carry buffer: only a trailing partial line that
 * could still become a marker is held back, so an ordinary prompt (which has no trailing
 * newline) is written immediately.
 */

export const CONTROL_PREFIX = '::strabo::';

const VERBS = new Set(['focus', 'open', 'highlight', 'review', 'note', 'screen']);
const MAX_ARGS = 64;
const MAX_ARG_LENGTH = 4096;
/** A partial marker longer than this is treated as ordinary output rather than held forever. */
const MAX_HOLD = 8192;

/** Parse one already-split line into a directive, or null when it is not a valid marker. */
export function parseControlLine(line) {
  const trimmed = typeof line === 'string' ? line.replace(/\r$/, '').trim() : '';
  if (!trimmed.startsWith(CONTROL_PREFIX)) {
    return null;
  }
  const rest = trimmed.slice(CONTROL_PREFIX.length).trim();
  if (!rest) {
    return null;
  }
  const [verb, ...args] = rest.split(/\s+/);
  if (!VERBS.has(verb)) {
    return null;
  }
  return { verb, args: args.slice(0, MAX_ARGS).map((arg) => arg.slice(0, MAX_ARG_LENGTH)) };
}

/** Whether a trailing partial line is still a possible prefix of the marker. */
function couldBeMarker(partial) {
  if (partial.length === 0 || partial.length > MAX_HOLD) {
    return false;
  }
  if (partial.startsWith(CONTROL_PREFIX)) {
    return true;
  }
  return partial.length < CONTROL_PREFIX.length && CONTROL_PREFIX.startsWith(partial);
}

/**
 * Split a chunk into visible text plus any control directives, carrying a partial trailing
 * marker to the next call. `text` is safe to write straight to the terminal.
 */
export function extractControl(carry, chunk) {
  const combined = `${carry ?? ''}${chunk ?? ''}`;
  const lines = combined.split('\n');
  const partial = lines.pop() ?? '';
  const directives = [];
  let text = '';
  for (const line of lines) {
    // The prefix reserves the namespace: a malformed or unknown marker is swallowed rather
    // than printed, but only a valid directive is dispatched.
    if (line.replace(/\r$/, '').trim().startsWith(CONTROL_PREFIX)) {
      const directive = parseControlLine(line);
      if (directive) {
        directives.push(directive);
      }
      continue;
    }
    text += `${line}\n`;
  }
  if (couldBeMarker(partial)) {
    return { text, directives, carry: partial };
  }
  return { text: text + partial, directives, carry: '' };
}
