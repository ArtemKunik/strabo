import { mavenCoordinateMatches } from '../scan/external-polyglot.ts';
import type { CrossRepoFlow, DependencyEcosystem, Graph, PublishedCoordinate } from '../types.ts';

/** The per-repository facts a cross-repo flow is resolved from. */
export interface RepoFlowFact {
  name: string;
  publishes: PublishedCoordinate | null;
  graph: Graph;
}

interface Publisher {
  name: string;
  coordinate: PublishedCoordinate;
}

/**
 * Resolve flows between repositories from recorded declarations only.
 *
 * A flow exists when repository A's manifest publishes a coordinate and repository B's
 * source records an import of it. Nothing is inferred from names, proximity, or a shared
 * word: the join is the exact npm/crate coordinate, or the Maven groupId rule the risk
 * report already uses. A self-import inside one repository is not a cross-repo flow.
 */
export function computeCrossRepoFlows(facts: RepoFlowFact[]): CrossRepoFlow[] {
  const publishers = new Map<string, Publisher[]>();
  for (const fact of facts) {
    if (fact.publishes) {
      const key = coordinateKey(fact.publishes.ecosystem, fact.publishes.name);
      const list = publishers.get(key) ?? [];
      list.push({ name: fact.name, coordinate: fact.publishes });
      publishers.set(key, list);
    }
  }

  const flows: CrossRepoFlow[] = [];
  for (const consumer of facts) {
    const byTarget = new Map<string, CrossRepoFlow>();
    for (const reference of consumer.graph.externalImports ?? []) {
      for (const publisher of findPublishers(publishers, reference.ecosystem, reference.package)) {
        if (publisher.name === consumer.name) {
          continue;
        }
        const key = `${publisher.name}\u0000${reference.ecosystem}\u0000${publisher.coordinate.name}`;
        let flow = byTarget.get(key);
        if (!flow) {
          flow = {
            from: consumer.name,
            to: publisher.name,
            ecosystem: reference.ecosystem,
            package: publisher.coordinate.name,
            files: [],
            publishedBy: publisher.coordinate.source,
          };
          byTarget.set(key, flow);
        }
        flow.files.push({ file: reference.file, line: reference.line, specifier: reference.specifier });
      }
    }
    for (const flow of byTarget.values()) {
      flow.files = dedupeFiles(flow.files);
      flows.push(flow);
    }
  }

  return flows.sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      a.package.localeCompare(b.package),
  );
}

/**
 * Every publisher of a coordinate. Two repositories can declare the same name; both are
 * recorded publishers, so both flows are emitted rather than silently picking one.
 */
function findPublishers(
  publishers: Map<string, Publisher[]>,
  ecosystem: DependencyEcosystem,
  pkg: string,
): Publisher[] {
  if (ecosystem === 'maven') {
    // A JVM package is not a Maven coordinate 1:1, so only a groupId prefix matches.
    return [...publishers.values()]
      .flat()
      .filter(
        (publisher) =>
          publisher.coordinate.ecosystem === 'maven' &&
          mavenCoordinateMatches(pkg, publisher.coordinate.name),
      );
  }
  return publishers.get(coordinateKey(ecosystem, pkg)) ?? [];
}

function coordinateKey(ecosystem: DependencyEcosystem, name: string): string {
  return `${ecosystem}\u0000${name}`;
}

function dedupeFiles(files: CrossRepoFlow['files']): CrossRepoFlow['files'] {
  const seen = new Set<string>();
  return files
    .filter((entry) => {
      const key = `${entry.file}\u0000${entry.line}\u0000${entry.specifier}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
