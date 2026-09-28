/**
 * A glob matcher for the path patterns an operator declares (groups, expected zones).
 *
 * The behaviour is the one `units.ts` grew for `strabo.groups.yml`: a `**` followed by a
 * slash matches zero or more directories, `**` matches anything, `*` one segment, `?` one
 * character. It is copied
 * here rather than imported so this module stays dependency-free and the private helper in
 * `units.ts` can change without altering what a scope fence means.
 */

const MAX_CACHE_ENTRIES = 1000;
const GLOB_CACHE = new Map<string, RegExp>();

function compileGlobToRegExp(glob: string): RegExp {
  const pattern = glob.replace(/\\/g, '/');
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` matches zero or more directory segments safely without catastrophic backtracking
        if (pattern[index + 2] === '/') {
          source += '(?:[^/]+/)*';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(character)) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }
  return new RegExp(`^${source}$`);
}

/** Compile a glob to an anchored regular expression, with `\` normalised to `/`. */
export function globToRegExp(glob: string): RegExp {
  const cached = GLOB_CACHE.get(glob);
  if (cached) {
    return cached;
  }
  const compiled = compileGlobToRegExp(glob);
  if (GLOB_CACHE.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = GLOB_CACHE.keys().next().value;
    if (oldestKey !== undefined) {
      GLOB_CACHE.delete(oldestKey);
    }
  }
  GLOB_CACHE.set(glob, compiled);
  return compiled;
}

/** True when a repository-relative file path matches a glob, treating both separators alike. */
export function matchesGlob(file: string, glob: string): boolean {
  return globToRegExp(glob).test(file.replace(/\\/g, '/'));
}
