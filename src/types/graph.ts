import type { DependencyEcosystem, EdgeKind, EdgeRelationship, NodeKind } from './enums.ts';

/** A node in the repository graph. `id` is repository-relative and POSIX-normalised. */
export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** Parent directory, or the repository root marker. */
  directory: string;
  /** Optional display label; falls back to the file name when absent. */
  label?: string;
  /** Optional language tag derived during scanning. */
  language?: string;
  /** Why this node is an entry point, when a manifest declares it as one. */
  entryReason?: string;
  /** Line count of the file as read during the scan; absent on aggregate nodes. */
  lines?: number;
}

/** Evidence attached to an edge so the UI can explain why the link exists. */
export interface EdgeEvidence {
  /** 1-based line where the reference was found. */
  line: number;
  /** The raw specifier or symbol as authored. */
  specifier: string;
  /** How the reference was resolved, for transparency. */
  resolution:
    | 'exact'
    | 'extension'
    | 'index'
    | 'index-of-package'
    | 'module-tree'
    | 'index-packed'
    | 'alias'
    | 'root'
    | 'subpath-import';
}

/**
 * A resolved, directed relationship. An edge exists only when both endpoints resolve
 * inside the scanned repository.
 */
export interface GraphEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  evidence: EdgeEvidence;
  /**
   * Whether the edge is a real dependency for fan-in/fan-out (`use`) or only a declaration
   * of the module tree (`declare`): a Rust `mod x;`, a Python `__init__.py` layout edge, or
   * a TypeScript barrel `index.ts` re-export. A `declare` edge is drawn and left out of
   * direct fan-in/fan-out, but a re-export is still followed when impact and blast radius
   * opt in (see `buildAdjacency`). Absent means `use`.
   */
  role?: 'use' | 'declare';
  /**
   * The explicit relationship kind. `role` is the coarse counted/not-counted flag kept for
   * backward compatibility; this names what the edge actually is. Absent means `import`.
   */
  relationship?: EdgeRelationship;
}

/** A fact Strabo could not turn into an edge. Diagnostics are evidence, not errors. */
export interface Diagnostic {
  file: string;
  line: number;
  message: string;
  severity: 'info' | 'warning' | 'error';
  kind: 'unresolved' | 'ambiguous' | 'parse-failure' | 'unsupported' | 'read-failure';
  specifier?: string;
}

/** Why a path was left out of the graph. */
export interface Exclusion {
  path: string;
  reason:
    | 'generated'
    | 'vendor'
    | 'build'
    | 'fixture'
    | 'gitignored'
    | 'minified'
    | 'unsupported'
    | 'symlink'
    | 'lockfile';
  detail?: string;
}

/** A complete repository scan. */
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  diagnostics: Diagnostic[];
  excluded: Exclusion[];
  /**
   * Bare imports of external packages, recorded per file.
   *
   * These are deliberately not edges: their target is outside the repository, so an edge
   * would violate the graph contract. They exist so a dependency-level finding can name
   * the files that actually import the affected package.
   */
  externalImports?: ExternalImport[];
}

/** One external package reference, as authored in a source file. */
export interface ExternalImport {
  file: string;
  line: number;
  /** The specifier as written, e.g. `lodash/fp` or `serde::Deserialize`. */
  specifier: string;
  /** The package or crate the specifier belongs to, e.g. `lodash` or `serde`. */
  package: string;
  ecosystem: DependencyEcosystem;
  kind: EdgeKind | 'use' | 'extern-crate';
}
