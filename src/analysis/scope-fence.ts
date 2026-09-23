import { matchesGlob } from './glob.ts';

/**
 * The scope fence: whether a change set stayed inside the zone it declared, and where it
 * crossed out of it.
 *
 * Pure and deterministic: it reads only its input, so a caller can score a change set
 * against an expected zone without a scan or Git. A change is "inside" when any expected
 * glob matches its path or, for a rename, its previous path.
 */

export interface ScopeFenceInput {
  changed: ReadonlyArray<{ path: string; previousPath?: string }>;
  expected: ReadonlyArray<string>;
  importers: ReadonlyMap<string, readonly string[]>;
}

export interface ScopeFenceEntry {
  path: string;
  previousPath?: string;
  importers: string[];
}

export interface ScopeFence {
  available: boolean;
  reason?: string;
  expected: string[];
  inside: number;
  total: number;
  outside: ScopeFenceEntry[];
  crossing: ScopeFenceEntry[];
}

export function computeScopeFence(input: ScopeFenceInput): ScopeFence {
  const total = input.changed.length;
  if (input.expected.length === 0) {
    return {
      available: false,
      reason: 'no expected zone declared',
      expected: [],
      inside: 0,
      total,
      outside: [],
      crossing: [],
    };
  }

  const expected = [...input.expected];
  const inZone = (path: string, previousPath?: string): boolean =>
    expected.some(
      (glob) =>
        matchesGlob(path, glob) ||
        (previousPath !== undefined && matchesGlob(previousPath, glob)),
    );

  const outside: ScopeFenceEntry[] = [];
  const crossing: ScopeFenceEntry[] = [];
  let inside = 0;

  for (const change of input.changed) {
    const directImporters = [...new Set(input.importers.get(change.path) ?? [])].sort();
    const base: ScopeFenceEntry = {
      path: change.path,
      ...(change.previousPath !== undefined ? { previousPath: change.previousPath } : {}),
      importers: directImporters,
    };

    if (inZone(change.path, change.previousPath)) {
      inside += 1;
      const external = directImporters.filter((importer) => !inZone(importer));
      if (external.length > 0) {
        crossing.push({ ...base, importers: external });
      }
    } else {
      outside.push(base);
    }
  }

  outside.sort((a, b) => a.path.localeCompare(b.path));
  crossing.sort((a, b) => a.path.localeCompare(b.path));
  return { available: true, expected, inside, total, outside, crossing };
}
