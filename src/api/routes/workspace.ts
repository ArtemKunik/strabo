import { Router, type Request } from 'express';

import { openWorkspaceCache, type WorkspaceCache } from '../../cache/workspace-cache.ts';
import type {
  DatabaseConfig,
  LiveSchemaReport,
  PreflightReport,
  StraboConfig,
  WorkspaceReport,
} from '../../types.ts';
import { analyzeWorkspace } from '../../workspace/analyze.ts';
import { analyzeWorkspaceCompat } from '../../workspace/compat.ts';
import { readWorkspaceConfig, resolveWorkspaceRepositories } from '../../workspace/config.ts';
import { analyzePreflight, renderPreflightScript } from '../../workspace/preflight.ts';
import {
  compareLiveSchema,
  createPostgresDriver,
  databaseConfigured,
  introspectPostgres,
  ProbeError,
  runPreflight,
  scrub,
  type DatabaseDriver,
} from '../../workspace/probe.ts';
import { isSameOriginRequest, sendError } from '../http.ts';

export interface WorkspaceRouterOptions {
  /** Environment the probe reads connection strings from; defaults to the process. */
  env?: NodeJS.ProcessEnv;
  /** Database driver; defaults to PostgreSQL through the optional `pg` package. */
  driver?: DatabaseDriver;
  /** Fact cache; defaults to the persisted one. */
  cache?: WorkspaceCache;
}

/** A finished probe run, kept in memory so an operator can see what was asked of a database. */
interface ProbeRun {
  at: string;
  database: string;
  kind: 'preflight' | 'schema';
  repository?: string;
  checks?: number;
  violations?: number;
  errors?: number;
  error?: string;
}

const MAX_RUNS = 20;

/**
 * Multi-repository analysis.
 *
 * The workspace is the explicitly declared repository list (`STRABO_CONFIG`), or the single
 * configured root when none is given. Cross-repo flows are package publish/consume edges
 * resolved from recorded manifests and imports; contract drift compares the data contracts
 * repositories share; service flows join a recorded outbound HTTP call to an endpoint a
 * sibling declares in its OpenAPI document. All of them report only what the scan recorded.
 *
 * Compatibility and preflight compare two revisions of a repository. Nothing here touches a
 * database unless the operator declared one and a request asks: the two `POST` routes that
 * do accept only a database name and a revision, never SQL, and only from the page's own
 * origin.
 */
export function createWorkspaceRouter(config: StraboConfig, options: WorkspaceRouterOptions = {}): Router {
  const router = Router();
  const env = options.env ?? process.env;
  const driver = options.driver ?? createPostgresDriver();
  const runs: ProbeRun[] = [];
  const record = (run: Omit<ProbeRun, 'at'>): void => {
    runs.unshift({ at: new Date().toISOString(), ...run });
    runs.length = Math.min(runs.length, MAX_RUNS);
  };
  const analyze = async (): Promise<{
    name: string;
    repositories: ReturnType<typeof resolveWorkspaceRepositories>['repositories'];
    workspace: WorkspaceReport;
  }> => {
    const { name, repositories } = resolveWorkspaceRepositories(config);
    const workspace = await analyzeWorkspace(name, repositories, {
      cache: options.cache ?? openWorkspaceCache(),
    });
    return { name, repositories, workspace };
  };

  router.get('/workspace', async (_request, response) => {
    try {
      const { workspace } = await analyze();
      response.json(workspace);
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/workspace/contracts', async (_request, response) => {
    try {
      const { workspace: report } = await analyze();
      response.json({
        name: report.name,
        repositories: report.repositories.map((entry) => entry.name),
        contracts: report.contracts,
        drift: report.drift,
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/workspace/services', async (_request, response) => {
    try {
      const { workspace: report } = await analyze();
      response.json({
        name: report.name,
        repositories: report.repositories.map((entry) => entry.name),
        endpoints: report.serviceEndpoints,
        flows: report.serviceFlows,
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/workspace/schema', async (_request, response) => {
    try {
      const { workspace: report } = await analyze();
      response.json({
        name: report.name,
        repositories: report.repositories.map((entry) => entry.name),
        schemas: report.schemas,
        drift: report.usage.drift,
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/workspace/schema/usage', async (_request, response) => {
    try {
      const { workspace: report } = await analyze();
      response.json({
        name: report.name,
        repositories: report.repositories.map((entry) => entry.name),
        usage: report.usage,
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/workspace/compat', async (request, response) => {
    try {
      const { name, repositories, workspace } = await analyze();
      const reports = await analyzeWorkspaceCompat(workspace, repositories, {
        ...optionalString(request.query.base, 'base'),
        ...optionalString(request.query.head, 'head'),
        ...optionalString(request.query.repository, 'repository'),
      });
      response.json({ name, reports });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/workspace/preflight', async (request, response) => {
    try {
      const { name, reports } = await buildPreflights(request, undefined);
      if (request.query.format === 'sql') {
        response.type('text/plain').send(renderPreflightScript(reports));
        return;
      }
      response.json({ name, reports });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.get('/workspace/databases', async (_request, response) => {
    try {
      const declared = readWorkspaceConfig(config.configPath)?.databases ?? [];
      response.json({
        databases: declared.map((database) => ({
          name: database.name,
          dialect: database.dialect,
          urlEnv: database.urlEnv,
          configured: databaseConfigured(database, env),
        })),
        runs,
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  router.post('/workspace/preflight/run', async (request, response) => {
    const body = bodyOf(request);
    const database = declaredDatabase(config, body.database);
    try {
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: 'A database is probed only from the Strabo page.' });
        return;
      }
      if (!database) {
        response.status(404).json({ error: 'That database is not declared in the workspace config.' });
        return;
      }
      const { name, reports } = await buildPreflights(request, database);
      const results: PreflightReport[] = [];
      for (const report of reports) {
        const ran = report.checks.length > 0 ? await runPreflight(report, { database, driver, env }) : report;
        results.push(ran);
        const outcomes = ran.checks.map((check) => check.result);
        record({
          database: database.name,
          kind: 'preflight',
          repository: ran.repository,
          checks: ran.checks.length,
          violations: outcomes.filter((entry) => entry?.status === 'violations').length,
          errors: outcomes.filter((entry) => entry?.status === 'error').length,
        });
      }
      response.json({ name, database: database.name, reports: results });
    } catch (error) {
      if (error instanceof ProbeError) {
        if (database) {
          record({ database: database.name, kind: 'preflight', error: error.message });
        }
        response.status(400).json({ error: error.message });
        return;
      }
      sendError(response, error);
    }
  });

  router.post('/workspace/live/schema', async (request, response) => {
    const body = bodyOf(request);
    const database = declaredDatabase(config, body.database);
    try {
      if (!isSameOriginRequest(request)) {
        response.status(403).json({ error: 'A database is probed only from the Strabo page.' });
        return;
      }
      if (!database) {
        response.status(404).json({ error: 'That database is not declared in the workspace config.' });
        return;
      }
      const url = (env[database.urlEnv] ?? '').trim();
      if (url === '') {
        throw new ProbeError(`The environment variable ${database.urlEnv} is not set.`);
      }
      const { workspace } = await analyze();
      const session = await driver.connect(url, { statementTimeoutMs: 15_000 }).catch((error: unknown) => {
        throw error instanceof ProbeError ? error : new ProbeError(`Could not connect: ${scrub(error, url)}`);
      });
      let snapshot;
      try {
        snapshot = await introspectPostgres(session, database.name);
      } catch (error) {
        throw error instanceof ProbeError ? error : new ProbeError(`Could not read the schema: ${scrub(error, url)}`);
      } finally {
        await session.close();
      }
      const report: LiveSchemaReport = {
        database: database.name,
        capturedAt: snapshot?.capturedAt ?? new Date().toISOString(),
        tables: snapshot?.tables.length ?? 0,
        snapshot,
        drift: snapshot ? workspace.schemas.flatMap((schema) => compareLiveSchema(snapshot, schema)) : [],
      };
      record({ database: database.name, kind: 'schema', checks: report.tables });
      response.json(report);
    } catch (error) {
      if (error instanceof ProbeError) {
        if (database) {
          record({ database: database.name, kind: 'schema', error: error.message });
        }
        response.status(400).json({ error: error.message });
        return;
      }
      sendError(response, error);
    }
  });

  /** Preflight reports for the requested revisions, aimed at a database's dialect when one is given. */
  async function buildPreflights(
    request: Request,
    database: DatabaseConfig | undefined,
  ): Promise<{ name: string; reports: PreflightReport[] }> {
    const source = request.method === 'POST' ? bodyOf(request) : (request.query as Record<string, unknown>);
    const base = stringOf(source.base) ?? 'HEAD';
    const head = stringOf(source.head);
    const only = stringOf(source.repository);
    const requestedDialect = stringOf(source.dialect);
    const dialect =
      database?.dialect ??
      (requestedDialect === 'postgres' || requestedDialect === 'mysql' || requestedDialect === 'sqlite'
        ? requestedDialect
        : undefined);

    const { name, repositories, workspace } = await analyze();
    const reports: PreflightReport[] = [];
    for (const repository of only ? repositories.filter((entry) => entry.name === only) : repositories) {
      reports.push(
        await analyzePreflight({
          repository: repository.name,
          root: repository.root,
          base,
          ...(head ? { head } : {}),
          ...(dialect ? { dialect } : {}),
          uses: workspace.usage.uses,
        }),
      );
    }
    return { name, reports };
  }

  return router;
}

function bodyOf(request: Request): Record<string, unknown> {
  const body: unknown = request.body;
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function declaredDatabase(config: StraboConfig, name: unknown): DatabaseConfig | undefined {
  const wanted = stringOf(name);
  if (!wanted) {
    return undefined;
  }
  return readWorkspaceConfig(config.configPath)?.databases.find((entry) => entry.name === wanted);
}

function optionalString<K extends string>(value: unknown, key: K): { [P in K]?: string } {
  const text = stringOf(value);
  return text ? ({ [key]: text } as { [P in K]?: string }) : {};
}
