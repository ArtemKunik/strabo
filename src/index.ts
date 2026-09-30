/**
 * Public library surface for Strabo.
 *
 * @packageDocumentation
 */

export * from './types.ts';

export { resolveRepositoryRoot, assertReadable, isInside, StraboScopeError } from './boundary/repository-root.ts';
export { browseDirectories } from './boundary/browse.ts';

export { scanRepository, collectSourceFiles, isTestLike, isSourceExtension } from './scan/scan.ts';
export { detectEntryPoints } from './scan/entry-points.ts';
export type { EntryPoint } from './scan/entry-points.ts';
export { scanJsTsEdges } from './scan/scan-js.ts';
export { scanJsTsCalls } from './scan/calls.ts';
export type { CallGraphResult, CallGraphOptions } from './scan/calls.ts';
export { scanPolyglotEdges, serializeParserWork, languageOf, isPolyglotSource } from './scan/scan-polyglot.ts';
export {
  availableGrammarLanguages,
  grammarPath,
  loadLanguage,
  withParser,
  GrammarUnavailableError,
  GRAMMAR_LANGUAGES,
} from './scan/languages/parser-runtime.ts';
export { extractJavaFacts, resolveJava, extractJavaSymbols, JAVA_LANGUAGE } from './scan/languages/java.ts';
export { extractRustFacts, resolveRust, extractRustSymbols, RUST_LANGUAGE, moduleCoordinates, expandUse } from './scan/languages/rust.ts';
export { extractCSharpFacts, resolveCSharp, extractCSharpSymbols, CSHARP_LANGUAGE } from './scan/languages/csharp.ts';
export { extractKotlinFacts, resolveKotlin, extractKotlinSymbols, KOTLIN_LANGUAGE } from './scan/languages/kotlin.ts';
export { extractSqlFacts, resolveSql, extractSqlSymbols, SQL_LANGUAGE } from './scan/languages/sql.ts';
export { extractPythonFacts, resolvePython, extractPythonSymbols, PYTHON_LANGUAGE } from './scan/languages/python.ts';
export { extractCppFacts, resolveCpp, extractCppSymbols, CPP_LANGUAGE } from './scan/languages/cpp.ts';
export {
  extractTypeScriptSymbols,
  TYPESCRIPT_LANGUAGE,
  TSX_LANGUAGE,
} from './scan/languages/typescript.ts';
export type {
  CodeSymbol,
  CodeSymbolKind,
  FunctionCall,
  FunctionMetrics,
  MemberAccess,
  ReExport,
  SuperType,
  SuperTypeRelation,
  SymbolExtraction,
} from './scan/languages/symbols.ts';
export { collectFunctionMetrics } from './scan/languages/function-metrics.ts';
export type { FunctionRules } from './scan/languages/function-metrics.ts';
export { markEntries, isTestFrameworkCall, testBodyEvidence } from './scan/languages/entry.ts';
export type { EntryKind, FunctionEntryMark } from './scan/languages/entry.ts';
export { SYMBOL_EXTRACTORS, symbolExtractorFor } from './scan/languages/registry.ts';
export type { SymbolExtractor, SymbolContext } from './scan/languages/registry.ts';
export { collectRelatedSources } from './analysis/related-sources.ts';
export { addNamespacePrefixes, namespaceDepth, looksInternal } from './scan/languages/namespace.ts';
export { classifyExclusion, classifyLockfile, classifyViewExclusion, looksMinified } from './scan/exclusions.ts';

export { resolveRelative, normalize as normalizePath, tryCandidates } from './resolve/index.ts';
export { loadAliasTables, resolveAliased } from './resolve/aliases.ts';
export type { AliasTables, AliasClaim } from './resolve/aliases.ts';

export {
  buildAdjacency,
  computeGraphMetrics,
  rankHubs,
  findDirectedPath,
  neighbourhood,
  relationshipOf,
} from './analysis/analysis.ts';
export type { Adjacency, AdjacencyOptions } from './analysis/analysis.ts';
export { buildPositions, buildSystemPositions } from './analysis/layout.ts';
export {
  blockRegion,
  topLevelDirectory,
  parentDirectory,
  directoriesOf,
  compressDirectoryChains,
  unitAnchoredLabel,
} from './analysis/directory.ts';
export type { UnitAnchor } from './analysis/directory.ts';
export { buildBlockViewModel } from './analysis/blocks.ts';
export {
  detectUnits,
  assignUnits,
  classifyPeriphery,
  classifyPeripheryAll,
  buildDirectoryLabels,
  buildBlockLabels,
  readDeclaredGroups,
  applyDeclaredGroups,
  DECLARED_GROUPS_FILE,
} from './analysis/units.ts';
export type { SystemUnit, SystemUnitEcosystem, Periphery, DeclaredGroup } from './analysis/units.ts';
export { buildSystemReport } from './analysis/system.ts';
export {
  classifyTierContent,
  classifyTiers,
  readDeclaredTiers,
  buildTierReport,
  unitRole,
  MAX_TIER_FILES,
} from './analysis/tiers.ts';
export type {
  Tier,
  TierStrength,
  TierEvidence,
  TierClassification,
  DeclaredTier,
  UnitRole,
  TierUnitReport,
  TierReport,
  TierMatrix,
  TierMatrixCell,
  TierDirection,
  TableReference,
} from './analysis/tiers.ts';
export type {
  SystemReport,
  SystemNode,
  SystemEdge,
  SystemLayer,
  SystemCommunity,
  SystemPeriphery,
} from './analysis/system.ts';
export { analyzeModuleDepth } from './analysis/depth.ts';
export { computeImpact, getChangedFiles, impactFromPaths } from './analysis/impact.ts';
export type { ImpactResult, ChangedFile } from './analysis/impact.ts';
export {
  reviewCommit,
  reviewWorkingTree,
  getCommit,
  parseNameStatus,
  parseNumstat,
} from './analysis/review.ts';
export type { BranchDivergence, ReviewFile, ReviewResult, ReviewStatus, ReviewGroup, ReviewTotals } from './analysis/review.ts';
export { listWorktrees, parseWorktrees, resolveWorktree } from './analysis/worktrees.ts';
export type { WorktreeSummary, WorktreesResult } from './analysis/worktrees.ts';
export { CHANGE_RISK_WEIGHTS, computeChangePassport } from './analysis/change-passport.ts';
export type { ChangePassport, CohesionChange, FunctionChange, PublicSurfaceChange, TieredImpact } from './analysis/change-passport.ts';
export { IMPACT_TIER_LABELS } from './analysis/review-types.ts';
export type { ChangeEdge, ChangeRisk, ChangeRiskSignal, GraphProvenance } from './analysis/review-types.ts';
export {
  buildFileImpactPassport,
  computeFileImpactPassport,
  computeRisk,
  functionFacts,
  riskBandFor,
  rollUpImpactPassports,
} from './analysis/impact-passport.ts';
export type {
  ComplexitySummary,
  CoherenceSummary,
  FileImpactPassport,
  ImpactFunction,
  ImpactPassportSet,
  ImpactRisk,
  ImpactSignal,
  ImpactSnapshot,
  ImpactTotals,
  RiskBand,
  SymbolReferences,
} from './analysis/impact-passport.ts';
export {
  computeCommitMetrics,
  computeRangeMetrics,
  computeWorkingTreeMetrics,
  computeMetricsHistory,
  clearChangeMetricsCache,
  readBlobs,
} from './analysis/change-metrics.ts';
export type {
  ChangeMetrics,
  ChangeMetricsResult,
  FileMeasures,
  FileMetricDelta,
  FunctionDelta,
  MetricTotals,
  MetricsHistoryEntry,
} from './analysis/change-metrics.ts';
export {
  computeCoverage,
  computeDetailedTestReachByFile,
  computeTestReachByFile,
  reachedFiles,
} from './analysis/coverage.ts';
export type { TestReachDetail, TestReachResult } from './analysis/coverage.ts';
export {
  fileCoverage,
  summariseFileCoverage,
  isUntested,
  UNDER_COVERED_THRESHOLD,
} from './analysis/file-coverage.ts';
export type { FileCoverage, FileCoverageAggregate } from './analysis/file-coverage.ts';
export {
  projectCoverageReport,
  folderCoverageReport,
  fileCoverageReport,
  normaliseFolder,
  ROOT_FOLDER,
} from './analysis/coverage-report.ts';
export type {
  CoverageScope,
  CoverageReport,
  CoverageTotals,
  CoverageFileEntry,
  CoverageFolderEntry,
} from './analysis/coverage-report.ts';
export {
  computeChangedLineCoverage,
  summariseChangedCoverage,
} from './analysis/changed-coverage.ts';
export type {
  ChangedLineCoverage,
  UncoveredFunctionChange,
  ChangedCoverageTotals,
} from './analysis/changed-coverage.ts';
export {
  PARSE_CACHE_VERSION,
  clearParseCache,
  parseCacheKey,
  parseCacheStats,
  readParseCache,
  withParseCache,
  writeParseCache,
} from './scan/parse-cache.ts';
export { DEFAULT_POOL_SIZE, extractWithPool, workersAvailable } from './scan/languages/extract-pool.ts';
export type { ExtractTask, ExtractOutcome } from './scan/languages/extract-pool.ts';
export { computeRiskyUntested, riskyUntestedCaption } from './analysis/coverage-risk.ts';
export type {
  RiskyUntestedInput,
  RiskyUntestedReport,
  RiskyUntestedRow,
} from './analysis/coverage-risk.ts';
export { computeCoverageGaps } from './analysis/coverage-gaps.ts';
export type {
  CoverageGap,
  CoverageGapReport,
  CoverageGapOptions,
} from './analysis/coverage-gaps.ts';
export {
  collectCoverageTrend,
  computeCoverageTrendMeasures,
  COVERAGE_TREND_MEASURES,
} from './analysis/coverage-trend.ts';
export type {
  CoverageTrendReport,
  CoverageTrendPoint,
  CoverageTrendMeasure,
  CoverageTrendDelta,
  CoverageTrendOptions,
} from './analysis/coverage-trend.ts';
export { parseCommitLog, readCommits, COMMIT_LOG_FORMAT } from './analysis/git-log.ts';
export type { CommitRow, CommitLogResult } from './analysis/git-log.ts';
export {
  computeMeasuredCoverage,
  parseCoverageText,
  parseLcov,
  parseCobertura,
  parseJacoco,
  parseCoveragePy,
  detectCoverageFormat,
  measuredFileFigure,
  coverageProvenance,
  clearMeasuredCoverageCache,
  formatAge,
  mapReportPath,
  percent,
  DEFAULT_COVERAGE_REPORT_PATHS,
} from './analysis/measured-coverage.ts';
export type {
  CoverageFormat,
  CoverageUnavailableReason,
  MeasuredFunctionCoverage,
  MeasuredFileCoverage,
  MeasuredCoverageSummary,
  MeasuredCoverageOptions,
  CoverageProvenance,
  FileCoverageFigure,
  ParsedCoverageReport,
  ParsedFileCoverage,
} from './analysis/measured-coverage.ts';
export {
  detectCoverageCommand,
  detectCoverageEcosystems,
  refreshCoverage,
  runCoverageScript,
  clearCoverageCommandCache,
  COVERAGE_SCRIPT_NAMES,
} from './analysis/coverage-refresh.ts';
export type {
  CoverageRunner,
  CoverageCommand,
  CoverageCommandSuggestion,
  CoverageRefreshHint,
  CoverageRefreshResult,
  CoverageRefreshReason,
  CoverageRefreshOptions,
} from './analysis/coverage-refresh.ts';
export {
  diffGraphs,
  structuralContext,
  computeStructuralDiff,
  clearStructuralDiffCache,
} from './analysis/structural-diff.ts';
export type {
  StructuralContext,
  StructuralDiff,
  StructuralDiffResult,
  StructuralEdge,
  StructuralCycle,
  StructuralTierEdge,
  StructuralUnavailableReason,
} from './analysis/structural-diff.ts';
export { computeCycles } from './analysis/cycles.ts';
export { computeArchitectureHealth } from './analysis/health.ts';
export { computeFileHealth, computeMemberCohesion } from './analysis/file-health.ts';
export type { FileHealthReport, FileHealthMetrics, MemberCohesion } from './analysis/file-health.ts';
export { buildMemberMap } from './analysis/member-map.ts';
export type { MemberMap, MemberMapType, DataFlowPanels } from './analysis/member-map.ts';
export { buildFunctions } from './analysis/functions.ts';
export type { FunctionEntry, FunctionCallSite, FunctionsReport } from './analysis/functions.ts';
export { computeSignals, SIGNAL_THRESHOLDS, CHANGE_RISK_THRESHOLDS, CHANGE_RISK_SIGNAL_LABELS } from './analysis/signals.ts';
export type { FunctionSignal, FunctionSignalKind } from './analysis/signals.ts';
export { rankHotspots } from './analysis/hotspots.ts';
export type { Hotspot, HotspotReport } from './analysis/hotspots.ts';
export { getTimeline, parseTimeline } from './analysis/timeline.ts';
export {
  listBranches,
  reviewBranch,
  movedUnderneath,
  parseMergeTreeConflicts,
  parseRefs,
  parseTrack,
} from './analysis/branches.ts';
export type { BranchBase, BranchesResult, BranchSummary, BranchSync } from './analysis/branches.ts';
export {
  dropBranches,
  fetchBranches,
  forgeMergeRequestUrl,
  isSafeBranch,
  mergeRequest,
  parseRemoteUrl,
  pullBranch,
  pushBranch,
  syncBranch,
} from './analysis/branch-actions.ts';
export type {
  BranchActionFailure,
  BranchActionName,
  BranchActionReason,
  BranchDropResult,
  BranchFetchResult,
  BranchPullResult,
  BranchPushResult,
  BranchSyncResult,
  DropResult,
  DropSkip,
  FetchResult,
  MergeRequestFailure,
  MergeRequestResult,
  MergeRequestSuccess,
  PullResult,
  PushResult,
  SyncResult,
} from './analysis/branch-actions.ts';
export { buildCommitEvidence, commitWorkingTree, normalizeCommitMessage } from './analysis/commit.ts';
export type { CommitFailure, CommitReason, CommitResult, CommitSuccess } from './analysis/commit.ts';
export { computeOwnership, getFileAuthorHistory } from './analysis/ownership.ts';
export { computeQualityScorecard, smellsFromScorecard, SMELL_RULES } from './analysis/quality.ts';
export type {
  QualityScorecard,
  QualityPercentile,
  ModuleQuality,
  ComplexityMeasures,
  ShapeMeasures,
  CentralityMeasures,
  EvolutionMeasures,
  ProtectionMeasures,
  PercentileMeasure,
  CompositeScores,
  Smell,
  SmellRule,
  SmellsReport,
} from './analysis/quality.ts';
export { computeReadingRoute, DEFAULT_ROUTE_LAYER_LIMIT } from './analysis/route.ts';
export type {
  ReadingRoute,
  ReadingRouteOptions,
  RouteEntryPoint,
  RouteStep,
  RouteTier,
  RouteUnreached,
  RouteUnit,
  RouteUnitSummary,
} from './analysis/route.ts';
export {
  buildCoChangeEdges,
  DEFAULT_MIN_COMMITS,
  DEFAULT_MIN_RATIO,
  DEFAULT_MAX_COMMITS_PER_EDGE,
  DEFAULT_MAX_EDGES,
} from './analysis/co-change.ts';
export type {
  CoChangeEdge,
  CoChangeOptions,
  CoChangeReport,
  CoChangeSkippedCommit,
} from './analysis/co-change.ts';
export { parseHistory, collectHistory, clearHistoryCache } from './analysis/history.ts';
export type {
  CoChangeCommit,
  CoChangePair,
  HistoryOptions,
  HistorySummary,
  SkippedCommit,
} from './analysis/history.ts';
export { globToRegExp, matchesGlob } from './analysis/glob.ts';
export { computeScopeFence } from './analysis/scope-fence.ts';
export type { ScopeFence, ScopeFenceEntry, ScopeFenceInput } from './analysis/scope-fence.ts';
export { computePublicApiDiff } from './analysis/public-api-diff.ts';
export type { PublicApiDiffFile, PublicApiDiffReport } from './analysis/public-api-diff.ts';
export { computeClones, normaliseTokens } from './analysis/clones.ts';
export type { CloneCluster, CloneMember, CloneOptions, CloneReport } from './analysis/clones.ts';
export { computeStringEdges } from './analysis/string-edges.ts';
export type {
  StringEdge,
  StringEdgeDiagnostic,
  StringEdgeKind,
  StringEdgeReport,
  StringEdgeSite,
} from './analysis/string-edges.ts';
export { checkDeclaredRules, readDeclaredRules, DECLARED_RULES_FILE } from './analysis/rules.ts';
export type { DeclaredRule, RuleAllow, RuleViolation, RulesReport } from './analysis/rules.ts';
export { clearDriftCache, collectDrift, computeDriftMeasures, DRIFT_MEASURES } from './analysis/drift.ts';
export type { DriftMeasure, DriftOptions, DriftPoint, DriftReport, DriftSeries } from './analysis/drift.ts';
export { computeRepositoryPassport } from './analysis/passport.ts';
export type {
  RepositoryPassport,
  PassportLanguage,
  PassportTopFile,
  PassportTopDirectory,
  PassportLayer,
  PassportEntryPoint,
  PassportCycle,
} from './analysis/passport.ts';
export { buildRepositoryReport, DEFAULT_REPORT_LIMITS, SEVERITY_ORDER } from './report/repository-report.ts';
export type {
  PainPoint,
  PainPointKind,
  RepositoryChangeSection,
  RepositoryContractsSection,
  RepositoryCoverageSection,
  RepositoryDataSection,
  RepositoryReportDocument,
  RepositoryReportInputs,
  RepositoryStructureSection,
  ReportEvidence,
  ReportLimits,
  ReportRevision,
  Severity,
  Suggestion,
} from './report/repository-report.ts';
export { suggestionFor } from './report/suggestions.ts';
export { renderReportMarkdown } from './report/render-markdown.ts';
export { applyPersistedSettings, createSettingsRouter, resolveScanCeiling } from './api/routes/settings.ts';
export type { StraboSettings, NarratorSettingsView, SettingsRouterOptions } from './api/routes/settings.ts';

export { readWorkspaceConfig, resolveWorkspaceRepositories } from './workspace/config.ts';
export type { WorkspaceConfig } from './workspace/config.ts';
export { readPublishedCoordinate } from './workspace/coordinate.ts';
export { computeCrossRepoFlows } from './workspace/flows.ts';
export type { RepoFlowFact } from './workspace/flows.ts';
export { extractContracts, computeContractDrift, findContractFiles } from './workspace/contracts.ts';
export { extractLanguageContracts, findSourceFiles } from './workspace/dto.ts';
export {
  extractServiceEndpoints,
  extractServiceCalls,
  computeServiceFlows,
  locateTarget,
} from './workspace/services.ts';
export type { RepoServiceFact } from './workspace/services.ts';
export { extractSchema, buildSchema, findSqlFiles, normalizeType, constraintSignature } from './workspace/schema.ts';
export type { SqlSource } from './workspace/schema.ts';
export { extractDataUses, extractDataUsesFromSource } from './workspace/data-usage.ts';
export type { RawDataUse } from './workspace/data-usage.ts';
export { computeSchemaUsage, computeSchemaDrift } from './workspace/schema-usage.ts';
export { buildDataReport } from './analysis/data/report.ts';
export {
  buildContractBoundary,
  buildContractOverlay,
  buildBoundaryView,
  computeContractImpact,
  diffContractFields,
  contractChangeSeverity,
} from './analysis/data/contracts-graph.ts';
export type {
  ContractBoundaryDefinition,
  ContractBoundaryInput,
  ContractBoundaryReport,
  ContractBoundaryPlate,
  ContractBoundaryView,
  ContractOverlay,
  ContractOverlayFile,
  ContractImpact,
  ContractImpactInput,
  ContractFieldChange,
  ContractChangeSeverity,
  GovernedEdge,
  UncontractedBoundary,
} from './analysis/data/contracts-graph.ts';
export { buildProductLevel, buildDataOverlay, emptyProductLevel } from './analysis/data/product-level.ts';
export type {
  DataOverlay,
  DataOverlayFile,
  ProductLevel,
  ProductLevelNode,
  ProductLevelPort,
  ProductLevelEdge,
  ProductUnit,
} from './analysis/data/product-level.ts';
export type { DataReportInput, DataRepository } from './analysis/data/report.ts';
export { buildModel, buildEntities, buildTableDatasets, tableDatasetId, tableColumns } from './analysis/data/model.ts';
export {
  identifyContract,
  identifyContracts,
  qualifiedIdOf,
  shapeFingerprint,
  shapeTwins,
  bareNameOf,
} from './analysis/data/identity.ts';
export { buildEvents, eventContractId, topicDatasetId } from './analysis/data/events.ts';
export { buildCandidates } from './analysis/data/candidates.ts';
export type { CandidateInput } from './analysis/data/candidates.ts';
export { buildConformance, portSchema } from './analysis/data/conformance.ts';
export type { ConformanceInput } from './analysis/data/conformance.ts';
export { computeDataImpact } from './analysis/data/impact.ts';
export type { DataImpactFinding, DataImpactInput } from './analysis/data/impact.ts';
export { propagateClassification } from './analysis/data/classification.ts';
export type { ClassificationInput } from './analysis/data/classification.ts';
export { readCodeowners } from './analysis/data/codeowners.ts';
export type { Codeowners } from './analysis/data/codeowners.ts';
export { extractEventEndpoints, extractEventContracts } from './workspace/events.ts';
export type { RegistrySubject } from './workspace/events.ts';
export { extractDeclaredProducts } from './workspace/products.ts';
export { extractSqlLineage, extractPathIo } from './workspace/lineage.ts';
export type { RawLineage, RawPathIo, LineageColumn } from './workspace/lineage.ts';
export { extractDbt } from './workspace/dbt.ts';
export type { DbtExtraction, DbtModelColumn, DbtModelReference } from './workspace/dbt.ts';
export { extractCatalogDeclarations } from './workspace/catalog.ts';
export { buildOpenLineage } from './export/openlineage.ts';
export type { OpenLineageExport, OpenLineageOptions } from './export/openlineage.ts';
export { createDataRouter } from './api/routes/data.ts';
export type { DataRouterOptions } from './api/routes/data.ts';
export {
  analyzeCompat,
  analyzeWorkspaceCompat,
  diffContracts,
  diffSchemas,
  schemaTypeWidens,
  readRevisionFacts,
  readWorkingFacts,
} from './workspace/compat.ts';
export type { CompatInput, RevisionFacts } from './workspace/compat.ts';
export { materializeRevision, assertRef, RevisionError } from './workspace/revision.ts';
export type { MaterializedRevision } from './workspace/revision.ts';
export { analyzePreflight, buildPreflight, renderPreflightScript } from './workspace/preflight.ts';
export type { PreflightInput } from './workspace/preflight.ts';
export {
  createPostgresDriver,
  assertReadOnlyQuery,
  databaseConfigured,
  runPreflight,
  introspectPostgres,
  compareLiveSchema,
  scrub as scrubProbeError,
  ProbeError,
} from './workspace/probe.ts';
export type { DatabaseDriver, DatabaseSession, RunOptions } from './workspace/probe.ts';
export { createWorkspaceRouter } from './api/routes/workspace.ts';
export type { WorkspaceRouterOptions } from './api/routes/workspace.ts';
export { analyzeWorkspace } from './workspace/analyze.ts';
export type { AnalyzeWorkspaceOptions } from './workspace/analyze.ts';
export { openWorkspaceCache, clearWorkspaceCache, workspaceCachePath, WORKSPACE_CACHE_VERSION } from './cache/workspace-cache.ts';
export type { WorkspaceCache, CachedRepoFacts } from './cache/workspace-cache.ts';

export { findManifestFiles, readDependencies, parseNpmLock, parseNpmManifest, parseCargoLock, parseMavenPom } from './risk/inventory.ts';
export { createOsvClient, normalizeSeverity, fixedVersions, createResponseCache, riskCacheDir } from './risk/osv.ts';
export type { OsvClient, OsvQuery, OsvVulnerability, ResponseCache, FetchLike } from './risk/osv.ts';
export { createLicenseClient, classifyLicenseExpression, isDeniedLicense, parseDeniedLicenses } from './risk/licenses.ts';
export type { LicenseClient, DepsDevVersion } from './risk/licenses.ts';
export { computeRiskReport } from './risk/report.ts';
export type { RiskOptions } from './risk/report.ts';
export {
  resolveNarratorConfig,
  isLoopbackHost,
  NARRATOR_DEFAULT_KEY_ENV,
  NARRATOR_DEFAULT_BUDGET,
} from './narrator/config.ts';
export type {
  NarratorResolution,
  ResolvedNarratorConfig,
  UnresolvedNarratorConfig,
  NarratorUnavailableReason,
} from './narrator/config.ts';
export {
  NARRATOR_PRESETS,
  narratorPresetById,
} from './narrator/presets.ts';
export type { NarratorPreset } from './narrator/presets.ts';
export {
  effectiveNarratorConfig,
  endpointHostOf,
  narratorLocks,
  NARRATOR_ENV_VARS,
} from './narrator/effective.ts';
export type { NarratorField, NarratorLocks } from './narrator/effective.ts';
export {
  createNarratorKeyStore,
  narratorKeyPath,
} from './narrator/key-store.ts';
export type { NarratorKeyStore, StoredNarratorKey } from './narrator/key-store.ts';
export {
  createNarratorClient,
  createMemoryNarratorCache,
  buildNarratorPrompt,
  frameUntrusted,
  NARRATOR_PROMPT_VERSION,
  NARRATOR_MAX_EVIDENCE_CHARS,
} from './narrator/client.ts';
export type {
  NarratorClient,
  NarratorClientOptions,
  NarratorCache,
  NarratorRequest,
  NarratorReply,
  NarratorNarrative,
  NarratorUnavailable,
  NarratorAuditEntry,
  NarratorStatus,
  NarratorPrompt,
} from './narrator/client.ts';
export { collectPolyglotExternalImports, mavenCoordinateMatches } from './scan/external-polyglot.ts';
export { buildTourRequest, TOUR_INSTRUCTION } from './narrator/tour.ts';
export type { TourRequest } from './narrator/tour.ts';
export {
  buildCoveragePlanRequest,
  COVERAGE_PLAN_INSTRUCTION,
  COVERAGE_PLAN_GAP_LIMIT,
  COVERAGE_PLAN_EVIDENCE_LIMIT,
} from './narrator/coverage-plan.ts';
export type { CoveragePlanRequest, CoveragePlanInput } from './narrator/coverage-plan.ts';
export {
  buildCoverageWeeklyRequest,
  COVERAGE_WEEKLY_INSTRUCTION,
  COVERAGE_WEEKLY_EVIDENCE_LIMIT,
} from './narrator/coverage-weekly.ts';
export type { CoverageWeeklyRequest, CoverageWeeklyInput } from './narrator/coverage-weekly.ts';

export {
  buildViewModel,
  buildSystemViewModel,
  buildSystemUnitViewModel,
  buildStructureViewModel,
  buildStructureGridViewModel,
} from './view/view-model.ts';

export { getCachedGraph } from './scan/graph.ts';
export {
  fingerprint,
  clearMemoryCache,
  clearDiskCache,
  cacheArtifactPath,
  CACHE_ARTIFACT_VERSION,
  MEMORY_TTL_MS,
} from './cache/graph-cache.ts';

export { createStraboRouter } from './api/router.ts';
export { createApiDispatch } from './api/dispatch.ts';
export type { ApiDispatch, DispatchResult } from './api/dispatch.ts';
export { isAllowedHost, isSameOriginRequest } from './api/http.ts';

export { exportGraph, GRAPH_EXPORT_VERSION } from './export/graph-export.ts';
export type { GraphExportEnvelope, GraphExportFormat, GraphExportOptions } from './export/graph-export.ts';
export { renderViewModelSvg } from './export/svg.ts';
export type { SvgExportOptions } from './export/svg.ts';
export { selectViewModel } from './export/select-view.ts';
export type { ExportViewMode, SelectViewModelOptions } from './export/select-view.ts';
export { exportSite } from './export/site.ts';
export type { SiteExportOptions, SitePage } from './export/site.ts';
export {
  buildDriftChart,
  driftSeriesColour,
  recordedDriftSeries,
  renderDriftArtifact,
} from './export/drift-artifact.ts';
export type {
  DriftArtifactMeta,
  DriftChartModel,
  DriftChartOptions,
  DriftChartPoint,
  DriftChartSeries,
} from './export/drift-artifact.ts';

export { computeFreshness, revisionFromFingerprint } from './status.ts';
export type { Freshness } from './status.ts';

export { runCheck, buildBaseline, collectFindings, CHECK_RULES, FAIL_ON_ALIASES, parseFailOnRules, parseUncoveredChangeThreshold } from './check/check.ts';
export type { CheckFinding, CheckOptions, CheckResult, CheckRule, CheckWarning } from './check/check.ts';
export {
  readBaseline,
  writeBaseline,
  defaultBaselinePath,
  BASELINE_VERSION,
} from './check/baseline.ts';
export type { CheckBaseline } from './check/baseline.ts';

export { createMcpHandler, startMcpServer, MCP_PROTOCOL_VERSION, MCP_SERVER_NAME } from './mcp/server.ts';
export type { McpHandler } from './mcp/server.ts';
export { createTools } from './mcp/tools.ts';
export type { McpTool, McpToolResult } from './mcp/tools.ts';

export { main } from './cli.ts';
export { runExportCommand } from './cli/export.ts';
export type { ExportIo } from './cli/export.ts';
export { runCheckCommand } from './cli/check.ts';
export type { CheckIo } from './cli/check.ts';
export { runCoverageCommand } from './cli/coverage.ts';
export type { CoverageIo } from './cli/coverage.ts';
export { runReportCommand, renderMarkdown } from './cli/report.ts';
export type { ReportDocument, ReportChange, ReportHotspot, ReportIo } from './cli/report.ts';

export { createStraboServer } from './server.ts';

export { loadCatalogue } from './integrations/catalogue.ts';
export {
  createRepositoryStore,
  knownRepositoriesInside,
  repositoryStorePath,
  REPOSITORY_STORE_VERSION,
} from './state/repository-store.ts';
export type { KnownRepository, RepositoryStore } from './state/repository-store.ts';
export {
  createSettingsStore,
  settingsStorePath,
  SETTINGS_STORE_VERSION,
} from './state/settings-store.ts';
export type { PersistedSettings, SettingsStore } from './state/settings-store.ts';
export { getVulnerabilities } from './integrations/vulnerability.ts';
export { getLineage } from './integrations/lineage-pack.ts';

export { readEnv, configFromEnv } from './config.ts';
export { describeRepository } from './repository.ts';
