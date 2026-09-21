import { builtinModules } from 'node:module';

import type {
  AdvisorySeverity,
  Dependency,
  DependencyAdvisory,
  DependencyLicense,
  ExternalImport,
  Graph,
  LicenseRisk,
  RiskReport,
} from '../types.ts';
import { impactFromPaths } from '../analysis/impact.ts';
import { mavenCoordinateMatches } from '../scan/external-polyglot.ts';
import { findManifestFiles, readDependencies, readLocalCrates } from './inventory.ts';
import { classifyLicenseExpression, isDeniedLicense, type LicenseClient } from './licenses.ts';
import {
  fixedVersions,
  normalizeSeverity,
  type OsvClient,
  type OsvVulnerability,
} from './osv.ts';

export interface RiskOptions {
  /** When false, no network call is made; inventory and file mapping still run. */
  online: boolean;
  deniedLicenses?: ReadonlySet<string>;
  osv?: OsvClient;
  licenses?: LicenseClient;
}

const URL_BY_ID = 'https://osv.dev/vulnerability/';

/**
 * Build a dependency-risk report for one repository.
 *
 * Inventory and file mapping are always available; advisories and licenses require the
 * opt-in online lookup. A dependency whose version is unresolved is listed but not queried,
 * because OSV and deps.dev answer for exact versions. Findings are joined to the files
 * that import the package, so impact is shown only where the scan can prove the import.
 */
export async function computeRiskReport(
  root: string,
  graph: Graph,
  options: RiskOptions,
): Promise<RiskReport> {
  const manifests = findManifestFiles(root);
  const { dependencies, caveats } = readDependencies(root, manifests);
  // A workspace crate is this repository's own code, not a dependency to declare.
  const localCrates = readLocalCrates(root, manifests);
  const externalImports = (graph.externalImports ?? []).filter(
    (reference) => !(reference.ecosystem === 'cargo' && localCrates.has(reference.package)),
  );

  const importedBy = new Map<string, string[]>();
  const matched = new Set<string>();
  for (const dependency of dependencies) {
    const files = new Set<string>();
    for (const reference of externalImports) {
      if (matches(reference, dependency)) {
        files.add(reference.file);
        matched.add(reference.ecosystem + '\u0000' + reference.package);
      }
    }
    importedBy.set(key(dependency), [...files].sort());
  }

  const byEcosystem: Record<string, number> = {};
  for (const dependency of dependencies) {
    byEcosystem[dependency.ecosystem] = (byEcosystem[dependency.ecosystem] ?? 0) + 1;
  }

  const undeclared = [
    ...new Set(
      externalImports
        .filter((reference) => !matched.has(reference.ecosystem + '\u0000' + reference.package))
        // `fs` or `crypto` without the `node:` prefix is the runtime, unless a manifest
        // declares a same-named package (which `matched` already accounted for).
        .filter((reference) => !(reference.ecosystem === 'npm' && NODE_BUILTINS.has(reference.package)))
        .map((reference) => reference.package),
    ),
  ].sort();

  const imports = buildImportIndex(externalImports, matched);

  const resolvable = dependencies.filter((dependency) => dependency.version !== null);

  let advisories: DependencyAdvisory[] = [];
  let licenses: DependencyLicense[] = [];

  if (options.online && resolvable.length > 0) {
    const [osvResults, licenseResults] = await Promise.all([
      options.osv
        ? options.osv.query(
            resolvable.map((dependency) => ({
              ecosystem: dependency.ecosystem,
              name: dependency.name,
              version: dependency.version ?? '',
            })),
          )
        : Promise.resolve(resolvable.map(() => [])),
      options.licenses
        ? options.licenses.lookup(
            resolvable.map((dependency) => ({
              ecosystem: dependency.ecosystem,
              name: dependency.name,
              version: dependency.version ?? '',
            })),
          )
        : Promise.resolve(resolvable.map(() => null)),
    ]);

    advisories = resolvable.flatMap((dependency, index) =>
      (osvResults[index] ?? [])
        .map((vulnerability) => toAdvisory(vulnerability, dependency, graph, importedBy.get(key(dependency)) ?? []))
        .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id)),
    );

    licenses = resolvable.map((dependency, index): DependencyLicense => {
      const result = licenseResults[index];
      const spdx = result?.licenses?.filter((entry): entry is string => typeof entry === 'string') ?? [];
      const risk: LicenseRisk = spdx.length === 0 ? 'unavailable' : overallRisk(spdx);
      return {
        dependency: {
          ecosystem: dependency.ecosystem,
          name: dependency.name,
          version: dependency.version,
        },
        licenses: spdx,
        risk,
        denied: isDeniedLicense(spdx, options.deniedLicenses),
      };
    });
  } else if (!options.online) {
    caveats.push('Online advisory and license lookup is disabled (STRABO_RISK online lookup is off).');
  }

  const summary = {
    low: 0,
    moderate: 0,
    high: 0,
    critical: 0,
    unknown: 0,
    deniedLicenses: licenses.filter((entry) => entry.denied).length,
  } as RiskReport['summary'];
  for (const advisory of advisories) {
    summary[advisory.severity] += 1;
  }

  return {
    available: true,
    online: options.online,
    inventory: { total: dependencies.length, byEcosystem, undeclared },
    advisories,
    licenses,
    imports,
    summary,
    caveats,
  };
}

/** Group source imports by package, recording every file that cites it. */
function buildImportIndex(
  references: readonly ExternalImport[],
  matched: ReadonlySet<string>,
): RiskReport['imports'] {
  const byKey = new Map<string, { ecosystem: ExternalImport['ecosystem']; package: string; files: Set<string> }>();
  for (const reference of references) {
    const mapKey = `${reference.ecosystem}\u0000${reference.package}`;
    const entry = byKey.get(mapKey) ?? {
      ecosystem: reference.ecosystem,
      package: reference.package,
      files: new Set<string>(),
    };
    entry.files.add(reference.file);
    byKey.set(mapKey, entry);
  }
  return [...byKey.entries()]
    .map(([mapKey, entry]) => ({
      ecosystem: entry.ecosystem,
      package: entry.package,
      files: [...entry.files].sort(),
      declared: matched.has(mapKey),
    }))
    .sort(
      (a, b) =>
        a.ecosystem.localeCompare(b.ecosystem) || a.package.localeCompare(b.package),
    );
}

function toAdvisory(
  vulnerability: OsvVulnerability,
  dependency: Dependency,
  graph: Graph,
  files: readonly string[],
): DependencyAdvisory {
  const impact = impactFromPaths(graph, files);
  return {
    id: vulnerability.id,
    aliases: vulnerability.aliases ?? [],
    summary: vulnerability.summary ?? '',
    severity: normalizeSeverity(vulnerability),
    fixed: fixedVersions(vulnerability),
    url: `${URL_BY_ID}${vulnerability.id}`,
    dependency: {
      ecosystem: dependency.ecosystem,
      name: dependency.name,
      version: dependency.version,
    },
    importedBy: [...files],
    impactedFiles: impact.affected,
  };
}

/** True when an import references the dependency, by the strictest available rule. */
function matches(reference: ExternalImport, dependency: Dependency): boolean {
  if (reference.ecosystem !== dependency.ecosystem) {
    return false;
  }
  if (dependency.ecosystem === 'maven') {
    return (
      mavenCoordinateMatches(reference.package, dependency.name) ||
      knownJvmGroupMatches(reference.package, dependency.name)
    );
  }
  if (dependency.ecosystem === 'cargo') {
    // Imports normalise `_` to `-`; Cargo.lock keeps the crate's published spelling.
    return reference.package === dependency.name.replace(/_/g, '-');
  }
  return reference.package === dependency.name;
}

/**
 * Well-known libraries whose Java package root differs from their Maven groupId. Each is
 * an exact published fact about that library, not a heuristic, so the join stays provable.
 */
const JVM_PACKAGE_GROUPS: ReadonlyArray<readonly [packageRoot: string, groupId: string]> = [
  ['okhttp3', 'com.squareup.okhttp3'],
  ['okio', 'com.squareup.okio'],
  ['retrofit2', 'com.squareup.retrofit2'],
  ['kotlinx.coroutines', 'org.jetbrains.kotlinx'],
  ['kotlinx.serialization', 'org.jetbrains.kotlinx'],
  ['com.google.gson', 'com.google.code.gson'],
  ['com.google.common', 'com.google.guava'],
  ['org.junit', 'junit'],
  ['io.airlift.compress', 'io.airlift'],
];

function knownJvmGroupMatches(packageName: string, coordinate: string): boolean {
  const [groupId = ''] = coordinate.split(':');
  return JVM_PACKAGE_GROUPS.some(
    ([packageRoot, group]) =>
      group === groupId && (packageName === packageRoot || packageName.startsWith(`${packageRoot}.`)),
  );
}

const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules);

function overallRisk(licenses: readonly string[]): LicenseRisk {
  const order: LicenseRisk[] = ['permissive', 'weak-copyleft', 'strong-copyleft', 'unknown'];
  let risk: LicenseRisk = 'permissive';
  for (const expression of licenses) {
    const classified = classifyLicenseExpression(expression);
    if (order.indexOf(classified) > order.indexOf(risk)) {
      risk = classified;
    }
  }
  return risk;
}

function key(dependency: Dependency): string {
  return `${dependency.ecosystem}\u0000${dependency.name}`;
}

const SEVERITY_ORDER: AdvisorySeverity[] = ['unknown', 'low', 'moderate', 'high', 'critical'];

function severityRank(severity: AdvisorySeverity): number {
  return SEVERITY_ORDER.indexOf(severity);
}
