import { Router } from 'express';

import { createAnalysisContext } from './analysis-context.ts';
import { createGitRouter } from './analysis-git.ts';
import { createHistoryRouter } from './analysis-history.ts';
import { createQualityRouter } from './analysis-quality.ts';
import { createReviewRouter } from './analysis-review.ts';
import { createStructureRouter } from './analysis-structure.ts';
import type { StraboConfig } from '../../types.ts';

export { graphProvenance } from './analysis-context.ts';

/**
 * Review-focused analyses. All of them inherit the scanner's scope.
 *
 * The handlers are grouped into focused routers — overview/structure, change review, Git
 * actions, quality, and history — which share one `AnalysisContext` (repository resolution
 * and measured coverage) so every route resolves and reads the same way.
 */
export function createAnalysisRouter(config: StraboConfig): Router {
  const context = createAnalysisContext(config);

  const router = Router();
  router.use(createStructureRouter(context));
  router.use(createReviewRouter(context));
  router.use(createGitRouter(context));
  router.use(createQualityRouter(context));
  router.use(createHistoryRouter(context));
  return router;
}
