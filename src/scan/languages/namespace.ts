/**
 * Shared package/namespace helpers for polyglot resolvers.
 *
 * Import-based resolution needs the same conservative question for every language: does
 * a reference that does not resolve to a file still look internal? For Java and C# the
 * answer is derived from the repository's own package/namespace prefixes.
 */

/** Record a dotted namespace and every prefix of it (`a.b.c` -> `a`, `a.b`, `a.b.c`). */
export function addNamespacePrefixes(namespaces: Set<string>, namespace: string): void {
  const segments = namespace.split('.').filter(Boolean);
  for (let index = 1; index <= segments.length; index += 1) {
    namespaces.add(segments.slice(0, index).join('.'));
  }
}

/**
 * Length (in dotted segments) of the longest repository namespace that is a prefix of
 * `name`. Zero means the reference shares no namespace with the repository.
 */
export function namespaceDepth(name: string, namespaces: Set<string>): number {
  const segments = name.split('.');
  for (let index = segments.length; index >= 1; index -= 1) {
    if (namespaces.has(segments.slice(0, index).join('.'))) {
      return index;
    }
  }
  return 0;
}

/**
 * Whether an unresolved reference looks internal.
 *
 * Requiring at least two leading segments prevents a common reverse-DNS root (`com`,
 * `io`, `org`) from being mistaken for proof that an external library belongs to the
 * repository.
 */
export function looksInternal(name: string, namespaces: Set<string>, minimumDepth = 2): boolean {
  return namespaceDepth(name, namespaces) >= minimumDepth;
}
