/**
 * The in-page file viewer: content and diff bodies.
 *
 * Split out of strabo-panels.js.
 */

import {
  highlightIsolated,
  highlightLines,
  languageForFile,
} from './strabo-highlight.js';

import { button } from './strabo-panel-kit.js';


/* --------------------------------------------------------------- File viewer */

/** The most rendered lines before the viewer says it is truncating. */
const SOURCE_LINE_CAP = 2000;


/**
 * The in-page file viewer: a file's lines, or a change's hunks, each with its numbers.
 *
 * `view` is the controller's own state — `{ file, ref, mode, loading, error, content, diff,
 * status, line, hasDiff }`. It renders exactly what the server returned; a missing side is
 * named rather than shown as an empty file, so an empty view is never mistaken for "no lines".
 */
export function renderSource(container, view, handlers = {}) {
  container.replaceChildren();
  const data = view ?? {};

  const head = document.createElement('div');
  head.className = 'source-head';

  const path = document.createElement('span');
  path.className = 'source-path';
  path.textContent = data.file ?? 'No file selected';
  head.append(path);

  if (data.ref) {
    const ref = document.createElement('span');
    ref.className = 'source-ref';
    ref.textContent = `at ${data.ref}`;
    head.append(ref);
  }
  if (data.status) {
    const status = document.createElement('span');
    status.className = 'review-status';
    status.textContent = data.status;
    head.append(status);
  }
  if (data.mode === 'diff' && data.diff && !data.loading) {
    const counts = document.createElement('span');
    counts.className = 'source-counts';
    counts.textContent = `+${data.diff.added} −${data.diff.removed}`;
    head.append(counts);
  }

  if (data.hasDiff) {
    const modes = document.createElement('span');
    modes.className = 'source-modes';
    if (handlers.onShowFile) modes.append(sourceModeButton('File', 'content', handlers.onShowFile));
    if (handlers.onShowDiff) modes.append(sourceModeButton('Changes', 'diff', handlers.onShowDiff));
    if (modes.childElementCount > 0) head.append(modes);
  }

  if (handlers.onClose) {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'panel-dismiss';
    close.setAttribute('aria-label', 'Close source');
    close.textContent = '×';
    close.addEventListener('click', () => handlers.onClose());
    head.append(close);
  }
  container.append(head);

  if (data.loading) {
    container.append(sourceNote('Loading…', 'source-loading', 'source-loading'));
    return;
  }
  if (data.error) {
    container.append(sourceNote(`Unavailable: ${data.error}`, 'source-note', 'source-unavailable'));
    return;
  }

  const body = document.createElement('div');
  body.className = 'source-body';
  if (data.mode === 'diff') {
    renderDiffBody(body, data);
  } else {
    renderContentBody(body, data);
  }
  container.append(body);
}


function sourceModeButton(label, mode, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'source-mode';
  button.dataset.mode = mode;
  button.textContent = label;
  button.addEventListener('click', () => handler());
  return button;
}


function sourceNote(text, className, role) {
  const note = document.createElement('p');
  note.className = className;
  if (role) note.dataset.role = role;
  note.textContent = text;
  return note;
}


/**
 * One numbered line. `gutters` is `[old, new]` for a diff and `[line]` for a file; `tokens`
 * is the line's highlight tokens, or absent to show it plain.
 */
function sourceLine(kind, gutters, text, mark, tokens) {
  const row = document.createElement('div');
  row.className = `src-line src-${kind}`;
  if (mark) row.classList.add('src-mark');
  for (const gutter of gutters) {
    const number = document.createElement('span');
    number.className = 'src-no';
    number.textContent = gutter === null || gutter === undefined ? '' : String(gutter);
    row.append(number);
  }
  const code = document.createElement('span');
  code.className = 'src-code';
  code.textContent = text === '' ? '\u00a0' : text;
  row.append(code);
  return row;
}


function renderContentBody(body, data) {
  const content = typeof data.content === 'string' ? data.content : null;
  if (content === null || content === '') {
    body.append(sourceNote('This file is empty.', 'source-note', 'source-empty'));
    return;
  }
  const lines = content.replace(/\n$/, '').split('\n');
  const shown = lines.slice(0, SOURCE_LINE_CAP);
  const tokens = highlightLines(shown, languageForFile(data.file));
  shown.forEach((line, index) => {
    body.append(sourceLine('context', [index + 1], line, data.line === index + 1, tokens?.[index]));
  });
  if (lines.length > shown.length) {
    body.append(sourceNote(`Showing the first ${SOURCE_LINE_CAP} of ${lines.length} lines.`, 'source-note'));
  }
}


function renderDiffBody(body, data) {
  const diff = data.diff;
  if (!diff) {
    body.append(sourceNote('No change to show.', 'source-note'));
    return;
  }
  if (diff.binary) {
    body.append(sourceNote('Binary file — Git reports no textual diff.', 'source-note', 'source-binary'));
    return;
  }
  if (diff.hunks.length === 0) {
    body.append(sourceNote('No change between the two sides.', 'source-note', 'source-empty'));
    return;
  }
  const language = languageForFile(data.file);
  let budget = SOURCE_LINE_CAP;
  let truncated = false;
  for (const hunk of diff.hunks) {
    body.append(sourceNote(hunk.header, 'src-hunk'));
    // Diff lines are not consecutive source, so each is highlighted on its own.
    const tokens = highlightIsolated(
      hunk.lines.map((line) => line.text),
      language,
    );
    for (const [index, line] of hunk.lines.entries()) {
      if (budget <= 0) {
        truncated = true;
        break;
      }
      budget -= 1;
      const marked =
        data.line !== null &&
        data.line !== undefined &&
        (line.newLine === data.line || line.oldLine === data.line);
      body.append(sourceLine(line.kind, [line.oldLine, line.newLine], line.text, marked, tokens?.[index]));
    }
    if (truncated) break;
  }
  if (truncated) {
    body.append(sourceNote(`Showing the first ${SOURCE_LINE_CAP} lines of this change.`, 'source-note'));
  }
}
