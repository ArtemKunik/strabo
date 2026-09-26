/**
 * Tier classification: what role each file's code plays, cutting across build units.
 *
 * The implementation lives under `./tiers/` and is re-exported here so every importer keeps
 * using `./analysis/tiers.ts`:
 * - `types.ts` — the tier vocabulary, ordering, and the report shape.
 * - `rules.ts` — the per-language classification rule tables.
 * - `classify.ts` — the terminal classifier over one file's content and path.
 * - `table.ts` — data-table extraction from SQL and ORM constructs.
 * - `declared.ts` — tier overrides read from `strabo.groups.yml`.
 * - `propagate.ts` — graph tier propagation and build-unit roles.
 * - `read.ts` — bounded file reading and line counting.
 * - `report.ts` — the repository-wide report assembly.
 */

export { tierRank } from './tiers/types.ts';
export type {
  Tier,
  TierStrength,
  TierEvidence,
  TableReference,
  TierClassification,
  DeclaredTier,
  UnitRole,
  TierUnitReport,
  TierMatrixCell,
  TierMatrix,
  TierDirection,
  TableTraceEntry,
  TierCallSite,
  TierEndpointSite,
  TierTrace,
  TierReport,
} from './tiers/types.ts';

export { extractTables } from './tiers/table.ts';
export { classifyTierContent, classifyTiers } from './tiers/classify.ts';
export { readDeclaredTiers } from './tiers/declared.ts';
export { propagateTiers, unitRole } from './tiers/propagate.ts';
export { MAX_TIER_FILES, buildTierReport } from './tiers/report.ts';
