import type { CacheStatus, DependencyEcosystem } from './enums.ts';
import type { Graph } from './graph.ts';

/** Extra scan metadata returned alongside the graph. */
export interface ScanReport {
  graph: Graph;
  /** Count of retained source files per extension, e.g. `{ ".ts": 42 }`. */
  extensionCounts: Record<string, number>;
  /** Count of skipped non-source files per extension, e.g. `{ ".png": 320 }`. */
  unsupportedExtensionCounts: Record<string, number>;
  parseFailures: number;
  unresolvedReferences: number;
  scannedAt: string;
  durationMs: number;
}

export interface ScanCacheMetadata {
  status: CacheStatus;
  fingerprint: string | null;
  artifactVersion: string;
  generatedAt: string;
  /** True when a stale entry was served while a refresh runs in the background. */
  stale?: boolean;
}

export interface RepositoryDescriptor {
  name: string;
  root: string;
  head: string | null;
  dirty: boolean;
  gitUrl: string | null;
}

/** The coordinate a repository publishes, read from its own manifest. */
export interface PublishedCoordinate {
  ecosystem: DependencyEcosystem;
  /** npm package name, Cargo crate name, or Maven `groupId:artifactId`. */
  name: string;
  /** Manifest that declared it, repository-relative. */
  source: string;
}
