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
export { scanPolyglotEdges, languageOf, isPolyglotSource } from './scan/scan-polyglot.ts';
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
  SymbolExtraction,
} from './scan/languages/symbols.ts';
export { collectFunctionMetrics } from './scan/languages/function-metrics.ts';
export type { FunctionRules } from './scan/languages/function-metrics.ts';
export { SYMBOL_EXTRACTORS, symbolExtractorFor } from './scan/languages/registry.ts';
export type { SymbolExtractor, SymbolContext } from './scan/languages/registry.ts';
export { collectRelatedSources } from './analysis/related-sources.ts';
export { addNamespacePrefixes, namespaceDepth, looksInternal } from './scan/languages/namespace.ts';
export { classifyExclusion, looksMinified } from './scan/exclusions.ts';

export { resolveRelative, normalize as normalizePath, tryCandidates } from './resolve/index.ts';
export { loadAliasTables, resolveAliased } from './resolve/aliases.ts';
export type { AliasTables, AliasClaim } from './resolve/aliases.ts';

export {
  buildAdjacency,
  computeGraphMetrics,
  rankHubs,
  findDirectedPath,
  neighbourhood,
} from './analysis/analysis.ts';
export { buildPositions } from './analysis/layout.ts';
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
} from './analysis/units.ts';
export type { SystemUnit, SystemUnitEcosystem, Periphery } from './analysis/units.ts';
export { buildSystemReport } from './analysis/system.ts';
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
export type { ReviewFile, ReviewResult, ReviewStatus, ReviewGroup, ReviewTotals } from './analysis/review.ts';
export { computeChangePassport } from './analysis/change-passport.ts';
export type { ChangePassport, CohesionChange } from './analysis/change-passport.ts';
export { computeCoverage } from './analysis/coverage.ts';
export { computeCycles } from './analysis/cycles.ts';
export { computeArchitectureHealth } from './analysis/health.ts';
export { computeFileHealth, computeMemberCohesion } from './analysis/file-health.ts';
export type { FileHealthReport, FileHealthMetrics, MemberCohesion } from './analysis/file-health.ts';
export { buildMemberMap } from './analysis/member-map.ts';
export type { MemberMap, MemberMapType, DataFlowPanels } from './analysis/member-map.ts';
export { buildFunctions } from './analysis/functions.ts';
export type { FunctionEntry, FunctionCallSite, FunctionsReport } from './analysis/functions.ts';
export { computeSignals, SIGNAL_THRESHOLDS } from './analysis/signals.ts';
export type { FunctionSignal, FunctionSignalKind } from './analysis/signals.ts';
export { rankHotspots } from './analysis/hotspots.ts';
export type { Hotspot, HotspotReport } from './analysis/hotspots.ts';
export { getTimeline, parseTimeline } from './analysis/timeline.ts';
export { computeOwnership, getFileAuthorHistory } from './analysis/ownership.ts';
export { computeQualityScorecard } from './analysis/quality.ts';
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
} from './analysis/quality.ts';
export { computeRepositoryPassport } from './analysis/passport.ts';
export type {
  RepositoryPassport,
  PassportLanguage,
  PassportTopFile,
  PassportLayer,
  PassportEntryPoint,
  PassportCycle,
} from './analysis/passport.ts';
export { applyPersistedSettings, createSettingsRouter, resolveScanCeiling } from './api/routes/settings.ts';
export type { StraboSettings } from './api/routes/settings.ts';

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

export { buildViewModel, buildSystemViewModel } from './view/view-model.ts';

export {
  getCachedGraph,
  fingerprint,
  clearMemoryCache,
  clearDiskCache,
  cacheArtifactPath,
  CACHE_ARTIFACT_VERSION,
  MEMORY_TTL_MS,
} from './cache/graph-cache.ts';

export { createStraboRouter } from './api/router.ts';

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
