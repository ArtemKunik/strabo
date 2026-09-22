import type { PainPoint, Suggestion } from './report-types.ts';

/**
 * The deterministic suggestion for one pain point.
 *
 * A suggestion is a fixed reading of the recorded inputs, never model prose: each kind maps
 * to one template that cites the evidence the pain point already carries. A pain point with
 * no suggestion rule yields no suggestion, so the section never speculates beyond the scan.
 */
export function suggestionFor(painPoint: PainPoint): Suggestion {
  return {
    id: `suggestion:${painPoint.id}`,
    painPointId: painPoint.id,
    kind: painPoint.kind,
    location: painPoint.location,
    text: suggestionText(painPoint),
  };
}

function refs(location: readonly string[]): string {
  return location.map((id) => `\`${id}\``).join(', ');
}

function suggestionText(painPoint: PainPoint): string {
  const inputs = painPoint.inputs;
  switch (painPoint.kind) {
    case 'cycle':
      return `Break the cycle ${refs(painPoint.location)} by extracting the shared symbol into a module both sides import.`;
    case 'tier-leak':
      return `Move ${refs(painPoint.location)} so it no longer imports into a higher tier, or reclassify the edge's target.`;
    case 'god-module':
      return `Split ${refs(painPoint.location)} along its recorded clusters; it currently carries ${inputs.members ?? inputs.directImporters ?? 'many'} recorded responsibilities.`;
    case 'hub-dependency':
      return `${refs(painPoint.location)} is depended on by ${inputs.directImporters ?? 'many'} files; give it a stable interface and cover it with tests.`;
    case 'unstable-dependency':
      return `${refs(painPoint.location)} depends on a more unstable module than itself; invert the dependency or introduce a stable seam.`;
    case 'shotgun-surgery':
      return `Changes to ${refs(painPoint.location)} co-change with ${inputs.coChangePartners ?? 'several'} files it does not import; make the coupling explicit or consolidate.`;
    case 'hidden-coupling':
      return `${refs(painPoint.location)} changes with files it has no import path to; add the missing dependency edge or a shared boundary.`;
    case 'dead':
      return `${refs(painPoint.location)} is imported by nothing and is not an entry point; delete it or mark it an entry.`;
    case 'pass-through':
      return `${refs(painPoint.location)} mostly forwards to another module; collapse it into its target or widen its own interface.`;
    case 'untested-reach':
      return `Add a test that reaches ${refs(painPoint.location)}; ${inputs.dependents ?? 'some'} file(s) depend on it and no test does.`;
    case 'hotspot':
      return `Reduce the cost signals in ${refs(painPoint.location)}: ${inputs.signals ?? inputs.signalKinds ?? 'recorded thresholds were crossed'}.`;
    case 'bus-factor':
      return `${refs(painPoint.location)} has a single recorded author and ${inputs.transitiveDependents ?? 'several'} transitive dependents; widen review ownership.`;
    case 'advisory':
      return `Upgrade \`${inputs.package ?? 'the package'}\` past \`${inputs.advisory ?? ''}\`; ${inputs.importedBy ?? 0} file(s) import it.`;
    case 'denied-license':
      return `Replace or licence \`${inputs.package ?? 'the dependency'}\`; its licence (${inputs.license ?? 'denied'}) is denied by policy.`;
    case 'parse-failure':
      return `Fix the ${inputs.count ?? 'recorded'} parse failure(s) in ${refs(painPoint.location)} so the scan can resolve its dependencies.`;
    case 'stale-graph':
      return 'Re-scan the repository (Refresh) so the report reflects the current working tree.';
    default:
      return `Review ${refs(painPoint.location)}.`;
  }
}
