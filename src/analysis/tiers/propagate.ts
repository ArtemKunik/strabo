import type { Tier, TierClassification, UnitRole } from './types.ts';

/** The layer tiers a neighbour may lend; support categories (tests, build, infra) do not. */
const PROPAGATABLE_TIERS: readonly Tier[] = ['frontend', 'api', 'domain', 'data', 'integration'];

/** Classified neighbours a file needs before the graph is allowed to vote on its tier. */
const MIN_NEIGHBOUR_VOTES = 2;

/**
 * Give an unclassified file the tier its recorded neighbours agree on.
 *
 * Only import edges are read (a call edge parallels an import), and only the layer tiers
 * vote: a module imported by many tests or build scripts is not itself a test or a script.
 * The winner must be a strict majority of at least two classified neighbours, so one edge
 * never forces a tier and the result stays evidence, not a guess.
 */
export function propagateTiers(
  files: readonly TierClassification[],
  edges: readonly { source: string; target: string; kind?: string }[],
): TierClassification[] {
  const present = new Set(files.map((entry) => entry.file));
  const seed = new Map<string, Tier>();
  for (const entry of files) {
    if (PROPAGATABLE_TIERS.includes(entry.tier)) {
      seed.set(entry.file, entry.tier);
    }
  }
  if (seed.size === 0) {
    return [...files];
  }

  const links = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    const set = links.get(from) ?? new Set<string>();
    set.add(to);
    links.set(from, set);
  };
  for (const edge of edges) {
    if (edge.kind === 'call' || edge.source === edge.target) {
      continue;
    }
    if (!present.has(edge.source) || !present.has(edge.target)) {
      continue;
    }
    link(edge.source, edge.target);
    link(edge.target, edge.source);
  }

  return files.map((entry) => {
    if (entry.tier !== 'unclassified') {
      return entry;
    }
    const votes = new Map<Tier, number>();
    let total = 0;
    for (const neighbour of links.get(entry.file) ?? []) {
      const tier = seed.get(neighbour);
      if (!tier) {
        continue;
      }
      total += 1;
      votes.set(tier, (votes.get(tier) ?? 0) + 1);
    }
    if (total < MIN_NEIGHBOUR_VOTES) {
      return entry;
    }
    const top = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!top) {
      return entry;
    }
    const [tier, count] = top;
    if (count * 2 <= total) {
      return entry;
    }
    return {
      ...entry,
      tier,
      evidence: [
        ...entry.evidence,
        {
          tier,
          strength: 'graph',
          detail: `${count} of ${total} recorded neighbours are ${tier}`,
        },
      ],
    };
  });
}

/** A build unit's role, from the tiers of its files and its recorded entry points. */
export function unitRole(
  unit: { id: string; name: string },
  files: readonly string[],
  tierOf: (file: string) => Tier,
): { role: UnitRole; evidence: string } {
  const within = files.filter((file) => unit.id === '.' || file === unit.id || file.startsWith(`${unit.id}/`));
  const frontend = within.filter((file) => tierOf(file) === 'frontend');
  const api = within.filter((file) => tierOf(file) === 'api');
  const underTools = within.some((file) => /(^|\/)(tools?|scripts?)\//.test(file));

  if (frontend.length > 0) {
    return { role: 'app', evidence: `frontend tier (${frontend.length} file(s))` };
  }
  if (api.length > 0) {
    return { role: 'service', evidence: `API tier (${api.length} file(s))` };
  }
  if (underTools) {
    return { role: 'tool', evidence: 'files under tools/ or scripts/' };
  }
  return { role: 'library', evidence: 'no frontend, API, or tool evidence' };
}
