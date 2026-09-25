import fs from 'node:fs';
import path from 'node:path';

/**
 * The stylesheet is authored as parts under `ui/styles/`, listed in cascade order by the
 * `@import url("…")` lines of `ui/styles.css`. The build concatenates them into the one
 * `public/styles.css` the page loads, and the unit tests read the same concatenation, so
 * what is tested is what is served.
 */

const IMPORT = /^@import url\("([^"]+)"\);/gm;

/** The parts `ui/styles.css` lists, in order: `{ file, text }`, `file` relative to `ui/`. */
export function styleParts(uiDir) {
  const manifest = fs.readFileSync(path.join(uiDir, 'styles.css'), 'utf8');
  const files = [...manifest.matchAll(IMPORT)].map((match) => match[1]);
  if (files.length === 0) {
    throw new Error('ui/styles.css lists no @import parts.');
  }
  return files.map((file) => ({ file, text: fs.readFileSync(path.join(uiDir, file), 'utf8') }));
}

/** The served stylesheet: every part, in manifest order, with nothing added between them. */
export function bundleStyles(uiDir) {
  return styleParts(uiDir)
    .map((part) => part.text)
    .join('');
}
