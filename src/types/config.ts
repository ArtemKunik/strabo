import type { UnavailableReason } from './enums.ts';
import type { Graph } from './graph.ts';
import type { RepositoryDescriptor } from './scan.ts';

export interface Unavailable {
  available: false;
  reason: UnavailableReason;
  detail?: string;
}

/** Optional integration seams. Absence is explicit, never an implicit default. */
export interface StraboIntegrations {
  catalogueFetcher?: CatalogueFetcher;
  createVulnerabilityClient?: VulnerabilityClientFactory;
  lineagePack?: LineagePack;
}

export type CatalogueFetcher = (root: string) => Promise<RepositoryDescriptor[]>;

export interface VulnerabilityFinding {
  id: string;
  severity: 'low' | 'moderate' | 'high' | 'critical' | 'unknown';
  title: string;
  nodeId?: string;
}

export interface VulnerabilityClient {
  fetch(repository: RepositoryDescriptor): Promise<VulnerabilityFinding[]>;
}

export type VulnerabilityClientFactory = (
  root: string,
) => Promise<VulnerabilityClient> | VulnerabilityClient;

export interface LineagePack {
  name: string;
  /** Repositories the pack deliberately inspects. Never inferred implicitly. */
  repositories: string[];
  build(graphs: Map<string, Graph>): Promise<Graph>;
}

/** Configuration for the standalone server or an embedding host. */
export interface StraboConfig {
  workspaceRoot: string;
  configPath?: string;
  scanCeiling?: string;
  /**
   * Interface the standalone server binds. Defaults to loopback; set it (via
   * `STRABO_HOST` / `--host`) only to expose the server deliberately. Embedded hosts
   * listen themselves and leave this unset.
   */
  host?: string;
  /**
   * Permit `PUT /settings` to widen `scanCeiling` beyond its startup value.
   *
   * Startup-only: `STRABO_ALLOW_CEILING_WIDENING` or `--allow-ceiling-widening`. It is
   * reported by `GET /settings` but never accepted by `PUT /settings` and never read
   * from the persisted settings, so a request cannot grant itself a wider boundary —
   * not directly, and not by surviving a restart. Off by default, so a fresh process
   * cannot grow its own read boundary without an explicit opt-in.
   */
  allowCeilingWidening?: boolean;
  /**
   * Rebuild a stale graph in the background when a request observes that HEAD moved.
   * Defaults to true; `STRABO_AUTO_REBUILD=0` turns it off so a scan only runs on demand.
   */
  autoRebuild?: boolean;
  /**
   * Run terminal sessions in a detached `strabo-termd` daemon so they survive a server
   * restart. Off by default: the in-process registry is simpler, and an embedded host
   * or a machine without the native `node-pty` build should not spawn a background process.
   * `STRABO_TERMINAL_DAEMON=1` or `--terminal-daemon` turns it on.
   */
  terminalDaemon?: boolean;
  integrations?: StraboIntegrations;
  /**
   * Explicit coverage report paths (relative to the repository root, or absolute inside the
   * scan ceiling). When set, these replace the conventional auto-detected locations. Reports
   * are only ever read, never produced.
   */
  coverageReports?: string[];
  /**
   * Dependency-risk lookup. Online advisory/license calls are opt-in and off by default;
   * inventory and file mapping work without them.
   */
  risk?: RiskConfig;
  /**
   * Optional LLM narrator. Off unless an endpoint and model are supplied; only recorded
   * evidence is sent, and the API key is read from the environment, never the config.
   */
  narrator?: NarratorConfig;
  /**
   * Relaunch the server process on demand (`POST /settings/restart`).
   *
   * The standalone CLI wires this to a real process relaunch. An embedded host owns its own
   * process and leaves it unset, so the route reports `restartAvailable: false` and refuses
   * the request rather than pretending to restart. The route calls it only after the response
   * is flushed, so the operator sees the acknowledgement before the process goes away.
   */
  restart?: () => void | Promise<void>;
  serverLog?: (message: string, error?: unknown) => void;
}

export interface RiskConfig {
  /** Allow contacting OSV.dev and deps.dev. Defaults to false. */
  online?: boolean;
  /** SPDX identifiers the license policy denies, replacing the default strong-copyleft set. */
  deniedLicenses?: string[];
}

/**
 * Opt-in configuration for the LLM narrator.
 *
 * There is no default endpoint and no default model: without both, the narrator stays
 * unconfigured and nothing contacts a third party. The endpoint must be `https:` or a
 * loopback address, so a plaintext call off the machine is refused. The API key is never
 * held here — only the name of the environment variable that supplies it.
 */
export interface NarratorConfig {
  /** Chat-completions endpoint. Required to enable the narrator. Must be https: or loopback. */
  endpoint?: string;
  /** Model name to request. Required to enable the narrator. */
  model?: string;
  /** Environment variable holding the API key. Defaults to `STRABO_NARRATOR_API_KEY`. */
  apiKeyEnv?: string;
  /** Maximum narrated requests per server session. Defaults to 20. */
  requestBudget?: number;
  /** Send recorded source snippets as well as evidence. Defaults to false (evidence only). */
  sendSource?: boolean;
}

/** Options accepted by the graph endpoint. */
export interface GraphRequestOptions {
  repository?: string;
  path?: string;
  refresh?: boolean;
  blockDepth?: number;
  blockPrefix?: string;
}
