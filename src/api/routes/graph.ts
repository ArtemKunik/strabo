import { Router } from 'express';

import { buildBlockViewModel } from '../../analysis/blocks.ts';
import { computeMeasuredCoverage } from '../../analysis/measured-coverage.ts';
import { revisionBaseline } from '../../analysis/structural-diff.ts';
import { buildSystemReport } from '../../analysis/system.ts';
import { buildTierReport } from '../../analysis/tiers.ts';
import { buildTierDataFlow } from '../../analysis/tiers/data-flow.ts';
import { buildBlockLabels, buildDirectoryLabels } from '../../analysis/units.ts';
import { resolveRepositoryRoot } from '../../boundary/repository-root.ts';
import { CACHE_ARTIFACT_VERSION } from '../../cache/graph-cache.ts';
import { getCachedGraph } from '../../scan/graph.ts';
import { analyzeRepository } from '../../workspace/analyze.ts';
import { readWorkspaceConfig } from '../../workspace/config.ts';
import { describeRepository } from '../../repository.ts';
import type { ScanCacheMetadata, StraboConfig } from '../../types.ts';
import {
  buildStructureCellViewModel,
  buildStructureGridViewModel,
  buildStructureViewModel,
  buildSystemUnitViewModel,
  buildSystemViewModel,
  buildViewModel,
  type StructureViewOptions,
} from '../../view/view-model.ts';
import { parseBoolean, parsePositiveInt, sendError } from '../http.ts';

/**
 * Graph route: resolve a repository, get its graph through the cache, add
 * workspace-relative node paths, and derive the presentation model.
 *
 * Optional `blockDepth`/`blockPrefix` request a rolled-up path-block graph and permit
 * drill-down by one path segment; a normal file graph must not pay for roll-up work.
 * `system=1` rolls up to build units; `systemUnit=<id>` opens one unit's files, and
 * `outside=1` with `selected=<file>` attaches that file's cross-unit links.
 */
export function createGraphRouter(config: StraboConfig): Router {
  const router = Router();

  router.get('/graph', async (request, response) => {
    try {
      const repository = resolveRepositoryRoot({
        workspaceRoot: config.workspaceRoot,
        scanCeiling: config.scanCeiling ?? config.workspaceRoot,
        configPath: config.configPath,
        requested: asString(request.query.repository) ?? asString(request.query.path),
      });

      const cached = await getCachedGraph(repository.root, {
        refresh: parseBoolean(request.query.refresh),
      });
      const descriptor = await describeRepository(repository.root);
      const cache: ScanCacheMetadata = {
        status: cached.status,
        fingerprint: cached.fingerprint,
        artifactVersion: CACHE_ARTIFACT_VERSION,
        generatedAt: cached.report.scannedAt,
        stale: cached.stale,
      };

      // The Structure view rolls the file graph up into role tiers (Phase 35 Y3); `level=grid`
      // draws the unit × tier grid instead (Y4); `level=cell` drills down into a cell's files (Y5).
      // It is an explicit request and takes precedence over a stale URL's unit/block parameters.
      if (parseBoolean(request.query.structure)) {
        const report = buildTierReport(repository.root, repository.name, cached.report.graph);
        const level = asString(request.query.level);
        const cellParam = asString(request.query.cell);
        const unitParam = asString(request.query.unit) ?? asString(request.query.systemUnit);
        const tierParam = asString(request.query.tier);

        // `flow=data`: draw the Phase 37 data-flow reading instead of imports — the recorded
        // reads and writes routed through data hubs. It is opt-in and never mixes with imports,
        // and applies to the bands, the grid, and a cell drill-down alike.
        const wantsDataFlow = asString(request.query.flow) === 'data' || asString(request.query.overlay) === 'data-flow';
        let dataFlow: ReturnType<typeof buildTierDataFlow> | undefined;
        if (wantsDataFlow) {
          const data = await analyzeRepository(repository.name, repository.root, {
            qualifiedContracts: readWorkspaceConfig(config.configPath)?.contractsIdentity === 'qualified',
          });
          dataFlow = buildTierDataFlow(report, data, { repository: repository.name });
        }

        if (level === 'cell' || cellParam || (unitParam && tierParam)) {
          let cellUnit = unitParam;
          let cellTier = tierParam;
          if (cellParam) {
            const parts = cellParam.split('|');
            if (parts.length === 2) {
              cellUnit = parts[0] || undefined;
              cellTier = parts[1];
            } else if (cellParam.startsWith('shelf:')) {
              cellTier = cellParam.slice(6);
            } else {
              cellTier = cellParam;
            }
          }
          if (cellTier) {
            const cellModel = buildStructureCellViewModel(
              report,
              cached.report.graph,
              descriptor,
              cache,
              {
                unit: cellUnit,
                tier: cellTier as never,
                showOutside: parseBoolean(request.query.outside),
                selectedFile: asString(request.query.selected),
                dataFlow,
              },
            );
            if (cellModel) {
              response.json(cellModel);
              return;
            }
          }
        }

        const direction = asString(request.query.direction) ?? asString(request.query.orientation);
        const isHorizontal = direction === 'horizontal' || direction === 'lr';
        if (level === 'grid') {
          response.json(buildStructureGridViewModel(report, descriptor, cache, { dataFlow }));
          return;
        }
        // `since=<ref>`: read the stack against the graph at that revision, classified with
        // the same working-tree rules, so the deltas show what the change did to the layering.
        const since = asString(request.query.since);
        let baseline: StructureViewOptions['baseline'];
        if (since && !dataFlow) {
          const base = await revisionBaseline(repository.root, since, repository.name);
          baseline = base.available
            ? { ...base, report: buildTierReport(repository.root, repository.name, base.graph) }
            : base;
        }
        response.json(
          buildStructureViewModel(report, descriptor, cache, {
            direction: isHorizontal ? 'horizontal' : 'vertical',
            baseline,
            dataFlow,
          }),
        );
        return;
      }

      // The System view rolls the file graph up into build units; it takes precedence over
      // any block-depth parameters a stale URL still carries.
      const systemUnit = asString(request.query.systemUnit);
      if (parseBoolean(request.query.system) || systemUnit) {
        const report = buildSystemReport(repository.root, repository.name, cached.report.graph);
        // Unit cards sum lines, so per-file staleness (a `git log` per file) is not read here.
        const measured = await computeMeasuredCoverage(repository.root, cached.report.graph, {
          reportPaths: config.coverageReports,
          ceiling: config.scanCeiling ?? config.workspaceRoot,
          maxStalenessFiles: 0,
        });
        if (systemUnit) {
          const model = buildSystemUnitViewModel(
            report,
            cached.report.graph,
            systemUnit,
            descriptor,
            cache,
            {
              showOutside: parseBoolean(request.query.outside),
              selectedFile: asString(request.query.selected),
              expandedUnits: asString(request.query.expanded)?.split(',').filter(Boolean),
              measured,
            },
          );
          if (model) {
            response.json(model);
            return;
          }
        }
        response.json(buildSystemViewModel(report, descriptor, cache, cached.report.graph, measured));
        return;
      }

      const files = cached.report.graph.nodes.map((node) => node.id);

      const blockDepth = parsePositiveInt(request.query.blockDepth, 5);
      if (blockDepth) {
        const model = buildBlockViewModel(
          cached.report.graph,
          {
            depth: blockDepth,
            prefix: asString(request.query.blockPrefix),
          },
          { repository: descriptor, cache },
        );
        model.directoryLabels = buildBlockLabels(
          repository.root,
          files,
          repository.name,
          model.nodes.map((node) => node.id),
        );
        response.json(model);
        return;
      }

      const model = buildViewModel(repository.root, cached.report, descriptor, cache);
      model.directoryLabels = buildDirectoryLabels(repository.root, files, repository.name);
      response.json(model);
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
