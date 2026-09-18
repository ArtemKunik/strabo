/**
 * Public library surface for Strabo.
 *
 * @packageDocumentation
 */

export * from './types.ts';

export { resolveRepositoryRoot, assertReadable, isInside, StraboScopeError } from './boundary/repository-root.ts';
export { browseDirectories } from './boundary/browse.ts';

export { scanRepository, collectSourceFiles, isTestLike, isSourceExtension } from './scan/scan.ts';
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
export type {
  CodeSymbol,
  CodeSymbolKind,
  MemberAccess,
  SymbolExtraction,
} from './scan/languages/symbols.ts';
export { SYMBOL_EXTRACTORS, symbolExtractorFor } from './scan/languages/registry.ts';
export type { SymbolExtractor } from './scan/languages/registry.ts';
export { addNamespacePrefixes, namespaceDepth, looksInternal } from './scan/languages/namespace.ts';
export { classifyExclusion, looksMinified } from './scan/exclusions.ts';

export { resolveRelative, normalize as normalizePath } from './resolve/index.ts';

export {
  buildAdjacency,
  computeGraphMetrics,
  rankHubs,
  findDirectedPath,
  neighbourhood,
} from './analysis/analysis.ts';
export { buildPositions } from './analysis/layout.ts';
export { buildBlockViewModel } from './analysis/blocks.ts';
export { analyzeModuleDepth } from './analysis/depth.ts';
export { computeImpact, getChangedFiles } from './analysis/impact.ts';
export { computeCoverage } from './analysis/coverage.ts';
export { computeCycles } from './analysis/cycles.ts';
export { computeArchitectureHealth } from './analysis/health.ts';
export { computeFileHealth } from './analysis/file-health.ts';
export type { FileHealthReport, FileHealthMetrics } from './analysis/file-health.ts';
export { buildMemberMap } from './analysis/member-map.ts';
export type { MemberMap, MemberMapType, DataFlowPanels } from './analysis/member-map.ts';
export { getTimeline, parseTimeline } from './analysis/timeline.ts';
export { computeOwnership, getFileAuthorHistory } from './analysis/ownership.ts';

export { buildViewModel } from './view/view-model.ts';

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
export { getVulnerabilities } from './integrations/vulnerability.ts';
export { getLineage } from './integrations/lineage-pack.ts';

export { readEnv, configFromEnv } from './config.ts';
export { describeRepository } from './repository.ts';
