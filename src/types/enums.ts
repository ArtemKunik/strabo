/** The kind of a graph node. `unit` and `shelf` are the System-view roll-ups. */
export type NodeKind = 'module' | 'test' | 'entry' | 'unit' | 'shelf';

/**
 * The explicit relationship an edge records.
 *
 * `import` is an ordinary dependency (a static or dynamic import, `require`, or a call).
 * `re-export` forwards the target's names (`export … from`, Rust `pub use`).
 * `module-declaration` declares a child module (Rust `mod x;`).
 * `executable-module` runs the target when the source is imported (a Python package `__init__`).
 *
 * Absent means `import`, so a graph recorded before this field existed still reads.
 */
export type EdgeRelationship = 'import' | 're-export' | 'module-declaration' | 'executable-module';

/** The kind of relationship an edge represents. */
export type EdgeKind =
  | 'import'
  | 'require'
  | 'dynamic-import'
  | 're-export'
  | 'call'
  | 'package'
  | 'namespace'
  | 'table'
  | 'program'
  | 'copybook'
  | 'propath';

/** The package ecosystem a dependency belongs to. */
export type DependencyEcosystem = 'npm' | 'maven' | 'cargo';

export type AdvisorySeverity = 'low' | 'moderate' | 'high' | 'critical' | 'unknown';

/** How an SPDX license is classified for policy purposes. */
export type LicenseRisk = 'permissive' | 'weak-copyleft' | 'strong-copyleft' | 'unknown' | 'unavailable';

export type CacheStatus = 'memory' | 'disk' | 'refreshed' | 'miss';

export type SqlDialect = 'postgres' | 'mysql' | 'sqlite';

export type UnavailableReason =
  | 'not-configured'
  | 'not-authenticated'
  | 'provider-error'
  | 'no-domain-pack';
