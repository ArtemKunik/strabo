/**
 * Panel rendering for the workspace UI: the Module Passport, workspace and repository
 * passports, change review, branches, risk, the member map, and the file viewer.
 *
 * This module is the public entry point; the implementations live in the sibling
 * `strabo-panel-*.js` modules and are re-exported here so importers and tests keep a
 * single, stable surface.
 */

export {
  renderInspector,
  renderChangesWith,
} from './strabo-panel-inspector.js';

export {
  renderFunctions,
} from './strabo-panel-functions.js';

export {
  renderNarrativeReply,
  renderNarrationPanel,
} from './strabo-panel-narrative.js';

export {
  renderWorkspace,
  renderWorkspaceTools,
  renderRepositoryPassport,
  passportProvenanceText,
} from './strabo-panel-workspace.js';

export {
  renderMembers,
  renderMemberMap,
} from './strabo-panel-members.js';

export {
  renderReview,
  renderReviewLoading,
  structuralDiffGroups,
  structuralEdgeLabel,
  structuralCycleLabel,
  structuralTierEdgeLabel,
} from './strabo-panel-review.js';

export {
  renderBranches,
  formatAge,
  STALE_BRANCH_DAYS,
  branchTags,
} from './strabo-panel-branches.js';

export {
  renderImpactPassport,
  renderRisk,
} from './strabo-panel-risk.js';

export {
  renderOverlayPanel,
  renderEdgeEvidence,
  evidenceProvenanceText,
  renderTimeline,
} from './strabo-panel-overlay.js';

export {
  renderDiagnostics,
  renderLegend,
  renderShortcuts,
  renderTestsStrip,
  renderBreadcrumb,
  renderFolderList,
} from './strabo-panel-chrome.js';

export {
  renderSource,
} from './strabo-panel-source.js';

export { graphSummary } from './strabo-core.js';
