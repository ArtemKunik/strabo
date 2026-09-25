/**
 * Git review: change metrics, structural diff, and the change passport.
 *
 * Split out of strabo-panels.js.
 */

import {
  changeMetricSummary,
  cohesionDelta,
  metricDelta,
  orderMetricFiles,
  reviewGroups,
} from './strabo-core.js';

import {
  riskScoreText,
  riskSignalEntries,
} from './strabo-impact.js';

import { backButton, button, wiring } from './strabo-panel-kit.js';

import { appendNarratorBlock } from './strabo-panel-narrative.js';

import { renderBranchDivergence } from './strabo-panel-branches.js';

import { renderImpactPassport } from './strabo-panel-risk.js';

import { passportProvenanceText } from './strabo-panel-workspace.js';


/**
 * Show that a review is being computed. The panel's window opens before the request
 * settles, and a full review of a large change can take tens of seconds, so without this
 * the window would show whatever the previous render left behind.
 */
export function renderReviewLoading(container, handlers = {}) {
  container.replaceChildren();
  const title = document.createElement('h3');
  title.textContent = 'Review';
  container.append(title);
  if (handlers.onBack) {
    title.prepend(backButton(handlers, 'Back to the previous review'));
  }
  if (handlers.onClose) {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'panel-dismiss';
    dismiss.setAttribute('aria-label', 'Close review');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => handlers.onClose());
    title.append(dismiss);
  }
  const note = document.createElement('p');
  note.className = 'evidence';
  note.dataset.role = 'review-loading';
  note.textContent = 'Reviewing changes…';
  container.append(note);
}


/**
 * The Structure section's rows: the structural diff between the reviewed base and HEAD,
 * grouped for reading. Pure, so the browser and the headless report agree on the events.
 */
export function structuralDiffGroups(structural) {
  if (!structural || structural.available === false) {
    return [];
  }
  const diff = structural.diff ?? {};
  return [
    { key: 'edges-added', label: 'Dependency edges added', items: (diff.edgesAdded ?? []).map(structuralEdgeLabel) },
    { key: 'edges-removed', label: 'Dependency edges removed', items: (diff.edgesRemoved ?? []).map(structuralEdgeLabel) },
    { key: 'cycles-introduced', label: 'Cycles introduced', items: (diff.cyclesIntroduced ?? []).map(structuralCycleLabel) },
    { key: 'cycles-resolved', label: 'Cycles resolved', items: (diff.cyclesResolved ?? []).map(structuralCycleLabel) },
    { key: 'tier-edges-added', label: 'Wrong-way tier edges added', items: (diff.tierEdgesAdded ?? []).map(structuralTierEdgeLabel) },
    { key: 'entry-points-added', label: 'Entry points added', items: [...(diff.entryPointsAdded ?? [])] },
    { key: 'newly-unreached', label: 'Newly unreached', items: [...(diff.newlyUnreached ?? [])] },
  ].filter((group) => group.items.length > 0);
}


/** One dependency edge as a single line. */
export function structuralEdgeLabel(edge) {
  return `${edge.source} → ${edge.target} (${edge.kind})`;
}


/** One cycle as its members in order. */
export function structuralCycleLabel(cycle) {
  return (cycle.members ?? []).join(' → ');
}


/** One wrong-way tier edge with its unit. */
export function structuralTierEdgeLabel(edge) {
  return `${edge.source} → ${edge.target} (${edge.kind}, ${edge.unit})`;
}


/**
 * The Scope fence section's rows: whether a change set stayed inside the zone it declared,
 * and where it crossed out of it. Pure, so the browser and the headless report agree.
 */
export function scopeFenceGroups(scopeFence) {
  if (!scopeFence || scopeFence.available === false) {
    return scopeFence?.reason
      ? [{ key: 'reason', label: 'Scope fence', items: [scopeFence.reason] }]
      : [];
  }
  return [
    { key: 'outside', label: 'Outside the declared zone', items: (scopeFence.outside ?? []).map(scopeFenceOutsideLabel) },
    { key: 'crossing', label: 'Inside with outside importers', items: (scopeFence.crossing ?? []).map(scopeFenceCrossingLabel) },
  ].filter((group) => group.items.length > 0);
}


/** One file outside the declared zone, with its rename and the importers that reach it. */
function scopeFenceOutsideLabel(entry) {
  const rename = entry.previousPath ? ` (from \`${entry.previousPath}\`)` : '';
  const importers = (entry.importers ?? []).length > 0 ? ` — importers: ${entry.importers.join(', ')}` : '';
  return `\`${entry.path}\`${rename}${importers}`;
}


/** One in-zone file an outside importer still reaches. */
function scopeFenceCrossingLabel(entry) {
  return `\`${entry.path}\` — imported by ${(entry.importers ?? []).join(', ')}`;
}


/**
 * The Scope fence section of the Review panel: where a change left the zone it declared.
 * A fence with no declared zone names the reason rather than rendering as a pass.
 */
function renderScopeFence(container, scopeFence) {
  if (scopeFence === undefined) {
    return;
  }
  const section = document.createElement('section');
  section.dataset.role = 'review-scope-fence';
  const heading = document.createElement('h3');
  heading.textContent = 'Scope fence';
  section.append(heading);
  for (const group of scopeFenceGroups(scopeFence)) {
    const list = document.createElement('ul');
    list.dataset.role = `review-scope-fence-${group.key}`;
    for (const item of group.items) {
      const entry = document.createElement('li');
      entry.textContent = item;
      list.append(entry);
    }
    section.append(list);
  }
  container.append(section);
}


/**
 * The Structure section of the Review panel: what the change did to the architecture,
 * from the same document `strabo report` prints. An unreadable base says so rather than
 * rendering an empty diff as if nothing had changed.
 */
function renderStructuralDiff(container, structural) {
  const heading = document.createElement('h4');
  heading.textContent = 'Structure';
  container.append(heading);
  if (!structural || structural.available === false) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'review-structure-unavailable';
    note.textContent = structural?.detail
      ? `Structure unavailable: ${structural.detail}`
      : 'Structure unavailable: no base revision to compare.';
    container.append(note);
    return;
  }
  const groups = structuralDiffGroups(structural);
  if (groups.length === 0) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'review-structure-empty';
    note.textContent = 'No structural change between the base and HEAD.';
    container.append(note);
    return;
  }
  for (const group of groups) {
    const title = document.createElement('h5');
    title.textContent = `${group.label} (${group.items.length})`;
    container.append(title);
    const list = document.createElement('ul');
    list.dataset.role = `review-structure-${group.key}`;
    for (const item of group.items) {
      const entry = document.createElement('li');
      entry.textContent = item;
      list.append(entry);
    }
    container.append(list);
  }
}


/**
 * Render a Git review: what changed, by how much, and what the change can reach.
 *
 * A commit review names its revision; a working-tree review groups staged, unstaged, and
 * untracked files. Files outside the scanned graph are called out because no dependency
 * impact can be computed for them, and uncounted files are reported rather than shown
 * as zero lines.
 */
export function renderReview(container, result, handlers = {}) {
  container.replaceChildren();

  const title = document.createElement('h3');
  title.textContent =
    result?.kind === 'commit'
      ? 'Commit review'
      : result?.kind === 'branch'
        ? `Branch review · ${result.ref}`
        : 'Working tree review';
  container.append(title);
  if (handlers.onBack) {
    title.prepend(backButton(handlers, 'Back to the previous review'));
  }
  if (handlers.onClose) {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'panel-dismiss';
    dismiss.setAttribute('aria-label', 'Close review');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => handlers.onClose());
    title.append(dismiss);
  }

  if (!result || result.available === false) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'review-unavailable';
    note.textContent = result?.detail
      ? `Review unavailable: ${result.detail}`
      : 'Review unavailable: no Git metadata.';
    container.append(note);
    return;
  }

  if (result.commit) {
    const meta = document.createElement('p');
    meta.className = 'evidence';
    meta.dataset.role = 'review-commit';
    meta.textContent = `${result.commit.shortHash} · ${result.commit.author} · ${result.commit.date.slice(0, 10)} · ${result.commit.subject}`;
    container.append(meta);
  }

  // T6: the graph fingerprint and scan time behind the review's figures. A served graph older
  // than the working tree is labelled stale, so a number read from a stale scan says so.
  const provenance = passportProvenanceText(result.provenance);
  if (provenance) {
    const line = document.createElement('p');
    line.className = result.provenance?.stale === true ? 'evidence is-stale' : 'evidence';
    line.dataset.role = 'review-provenance';
    line.textContent = provenance;
    container.append(line);
  }

  // A working-tree review taken from a linked worktree names it, so the change set is not
  // mistaken for the repository's main checkout.
  if (result.worktree) {
    const line = document.createElement('p');
    line.className = 'evidence';
    line.dataset.role = 'review-worktree';
    line.textContent = result.worktree.branch
      ? `Worktree ${result.worktree.branch} · ${result.worktree.path}`
      : `Worktree ${result.worktree.path}`;
    container.append(line);
  }

  const totals = result.totals ?? { files: 0, insertions: 0, deletions: 0, uncounted: 0 };
  const summary = document.createElement('p');
  summary.className = 'overlay-summary';
  summary.dataset.role = 'review-summary';
  summary.textContent = `${totals.files} file(s) · +${totals.insertions} −${totals.deletions}${
    totals.uncounted > 0 ? ` · ${totals.uncounted} uncounted` : ''
  }`;
  container.append(summary);

  // The opt-in narrator may explain the change set; it never alters the recorded review.
  const narrator = document.createElement('div');
  narrator.className = 'review-narrator';
  appendNarratorBlock(narrator, handlers, { id: 'narrate-change', label: 'Narrate change' });
  if (narrator.childElementCount > 0) {
    container.append(narrator);
  }

  if (result.branch) {
    renderBranchDivergence(container, result.branch, handlers);
  }

  if ((result.files ?? []).length === 0) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent =
      result.kind === 'commit'
        ? 'This commit recorded no file changes.'
        : result.kind === 'branch'
          ? 'This branch has no changes the base lacks.'
          : 'No pending changes.';
    container.append(note);
  }

  for (const [group, files] of reviewGroups(result.files)) {
    const heading = document.createElement('h4');
    heading.textContent = `${REVIEW_GROUP_LABELS[group] ?? group} (${files.length})`;
    container.append(heading);

    const list = document.createElement('ul');
    list.dataset.role = `review-group-${group}`;
    for (const file of files) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link';
      button.dataset.path = file.path;
      button.textContent = file.path;
      if (handlers.onSelect && file.inGraph) {
        button.addEventListener('click', () => handlers.onSelect(file.path));
      } else {
        button.disabled = true;
        button.title = 'Not a node in the scanned graph';
      }
      item.append(button);
      const status = document.createElement('span');
      status.className = 'review-status';
      status.textContent = file.status;
      item.append(status);
      const counts = document.createElement('span');
      counts.className = 'evidence';
      counts.textContent =
        file.insertions === null || file.deletions === null
          ? 'line counts unavailable'
          : `+${file.insertions} −${file.deletions}`;
      item.append(counts);
      if (handlers.onOpenDiff) {
        const diff = document.createElement('button');
        diff.type = 'button';
        diff.className = 'link review-diff';
        diff.dataset.path = file.path;
        diff.textContent = 'Diff';
        diff.title = `Show the change to ${file.path}`;
        diff.addEventListener('click', () => handlers.onOpenDiff(file.path, file));
        item.append(diff);
      }
      list.append(item);
    }
    container.append(list);
  }

  if (result.structural !== undefined) {
    renderStructuralDiff(container, result.structural);
  }

  renderScopeFence(container, result.scopeFence);

  renderChangeMetrics(container, result.metrics, handlers);
  renderChangePassport(container, result.cohesion);
  if (result.impactPassport) {
    const impactSection = document.createElement('div');
    impactSection.className = 'impact-passport-section';
    container.append(impactSection);
    // R4: a change-set or revision passport is computed on the current graph, because no
    // graph for the compared revision was built; the cells are labelled an approximation.
    renderImpactPassport(impactSection, { ...result.impactPassport, graphApproximation: true }, handlers);
  }

  const affected = (result.impact?.affected ?? []).filter((entry) => entry.distance > 0);
  const impactHeading = document.createElement('h4');
  impactHeading.textContent = `Potentially affected (${affected.length})`;
  container.append(impactHeading);
  if (affected.length === 0) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'review-impact-empty';
    note.textContent = 'Nothing depends on the changed files.';
    container.append(note);
  } else {
    const list = document.createElement('ul');
    list.dataset.role = 'review-impact';
    for (const entry of affected.slice(0, 100)) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link';
      button.textContent = entry.id;
      if (handlers.onSelect) {
        button.addEventListener('click', () => handlers.onSelect(entry.id));
      }
      item.append(button);
      const distance = document.createElement('span');
      distance.className = 'evidence';
      distance.textContent = `· distance ${entry.distance}`;
      item.append(distance);
      list.append(item);
    }
    container.append(list);
  }

  if ((result.impact?.outsideGraph ?? []).length > 0) {
    const outside = document.createElement('p');
    outside.className = 'unavailable';
    outside.dataset.role = 'review-outside';
    outside.textContent = `${result.impact.outsideGraph.length} changed path(s) are outside the scanned graph.`;
    container.append(outside);
  }
}


/**
 * Change metrics: complexity and coupling before and after, per change set and per file.
 * Complexity is the summed decision points of each file's functions; coupling is the file's
 * resolved imports. A side that was not measured shows a dash, not a zero.
 */
function renderChangeMetrics(container, metrics, handlers = {}) {
  if (!metrics || metrics.available === false) {
    return;
  }

  const heading = document.createElement('h4');
  heading.textContent = 'Change metrics';
  container.append(heading);

  const summary = document.createElement('p');
  summary.className = 'overlay-summary';
  summary.dataset.role = 'change-metrics-summary';
  summary.textContent = changeMetricSummary(metrics.totals);
  container.append(summary);

  const files = orderMetricFiles(metrics.files);
  if (files.length === 0) {
    return;
  }

  const table = document.createElement('table');
  table.className = 'change-metrics';
  table.dataset.role = 'change-metrics';
  const head = document.createElement('tr');
  for (const [label, title] of [
    ['File', ''],
    ['Cx', 'Complexity: net change in summed function decision points'],
    ['Out', 'Fan-out: resolved in-repository imports, before → after'],
    ['In', 'Fan-in change from importers inside this change set'],
    ['Lines', 'Line count, net'],
  ]) {
    const cell = document.createElement('th');
    cell.textContent = label;
    if (title) cell.title = title;
    head.append(cell);
  }
  table.append(head);

  for (const file of files) {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'link';
    link.textContent = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
    if (handlers.onSelect && file.status !== 'deleted') {
      link.addEventListener('click', () => handlers.onSelect(file.path));
    } else {
      link.disabled = true;
    }
    name.append(link);
    if (file.note) name.title = file.note;
    row.append(name);

    const churn = file.complexityChange;
    const complexity = churn ? metricDelta(0, churn.added - churn.removed) : metricDelta(null, null);
    row.append(
      metricCell(
        complexity,
        churn
          ? [
              `${file.before?.complexity ?? '—'} → ${file.after?.complexity ?? '—'} (+${churn.added} −${churn.removed})`,
              ...file.functions
                .slice(0, 8)
                .map((fn) => `${fn.owner ? `${fn.owner}.` : ''}${fn.name}: ${fn.before ?? 'new'} → ${fn.after ?? 'removed'}`),
            ].join('\n')
          : (file.note ?? 'not measured'),
      ),
    );
    row.append(
      metricCell(
        file.fanOut ? metricDelta(file.fanOut.before, file.fanOut.after) : metricDelta(null, null),
        file.fanOut
          ? [
              `${file.fanOut.before} → ${file.fanOut.after}`,
              ...file.importsAdded.map((target) => `+ ${target}`),
              ...file.importsRemoved.map((target) => `− ${target}`),
            ].join('\n')
          : (file.note ?? 'imports not resolved'),
      ),
    );
    row.append(metricCell(metricDelta(0, file.fanInDelta ?? 0), 'Importers gained or lost within this change set'));
    const lines = metricDelta(file.before?.lines ?? 0, file.after?.lines ?? 0);
    row.append(metricCell({ ...lines, tone: lines.delta ? 'flat' : lines.tone }, `${file.before?.lines ?? 0} → ${file.after?.lines ?? 0}`));
    table.append(row);
  }
  container.append(table);

  if (metrics.capped) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent = 'Only the first files in the change set were measured.';
    container.append(note);
  }
}


function metricCell(delta, title) {
  const cell = document.createElement('td');
  const value = document.createElement('span');
  value.className = `metric-delta ${delta.tone}`;
  value.textContent = delta.text;
  cell.append(value);
  if (title) cell.title = title;
  return cell;
}


const REVIEW_GROUP_LABELS = {
  commit: 'Changed',
  branch: 'Changed on the branch',
  staged: 'Staged',
  unstaged: 'Unstaged',
  untracked: 'Untracked',
};


/**
 * The Change passport: cohesion before and after each changed file, from recorded wiring.
 * A file whose side is missing names why instead of showing a number.
 */
function renderChangePassport(container, passport) {
  if (!passport || !Array.isArray(passport.files) || passport.files.length === 0) {
    return;
  }

  const heading = document.createElement('h4');
  heading.textContent = 'Change passport';
  container.append(heading);

  const caption = document.createElement('p');
  caption.className = 'unavailable';
  caption.textContent = passport.baseline
    ? `Cohesion from recorded member wiring, compared with ${passport.baseline}.`
    : 'Cohesion from recorded member wiring; no baseline revision was available.';
  container.append(caption);

  // T6: the graph fingerprint and scan time behind the passport, labelled stale when the
  // working tree has moved past the served graph.
  const provenance = passportProvenanceText(passport.provenance);
  if (provenance) {
    const line = document.createElement('p');
    line.className = passport.provenance?.stale === true ? 'evidence is-stale' : 'evidence';
    line.dataset.role = 'change-passport-provenance';
    line.textContent = provenance;
    container.append(line);
  }

  const list = document.createElement('ul');
  list.className = 'change-passport';
  list.dataset.role = 'change-passport';
  for (const change of passport.files) {
    const item = document.createElement('li');
    const path = document.createElement('span');
    path.className = 'passport-change-path';
    path.textContent = change.previousPath
      ? `${change.previousPath} → ${change.path}`
      : change.path;
    item.append(path);
    const delta = cohesionDelta(change);
    const value = document.createElement('span');
    value.className = `health-delta ${delta.tone}`;
    value.dataset.role = 'cohesion-delta';
    value.textContent = delta.text;
    value.title = change.note ?? '';
    item.append(value);
    item.append(changeRiskBlock(change));
    list.append(item);
  }
  container.append(list);

  if (passport.capped) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.textContent = 'Only the first files in the change set were measured.';
    container.append(note);
  }
}


/**
 * The pending-change risk for one changed file: the additive score with each contributing
 * signal's value and threshold (T4), plus the two-sided edge deltas the structural diff
 * recorded. The score is rendered only alongside the signals it summed from.
 */
function changeRiskBlock(change) {
  const block = document.createElement('div');
  block.className = 'change-risk';

  const edges = [...(change.edgesAdded ?? []).map((edge) => `+ ${edge.source} → ${edge.target} (${edge.kind})`),
    ...(change.edgesRemoved ?? []).map((edge) => `− ${edge.source} → ${edge.target} (${edge.kind})`)];
  if (edges.length > 0) {
    const list = document.createElement('ul');
    list.className = 'change-edges';
    list.dataset.role = 'change-edges';
    for (const edge of edges) {
      const item = document.createElement('li');
      item.textContent = edge;
      list.append(item);
    }
    block.append(list);
  }

  const risk = change.risk;
  if (!risk || !Array.isArray(risk.signals) || risk.signals.length === 0) {
    return block;
  }
  const score = document.createElement('p');
  score.className = 'overlay-summary';
  score.dataset.role = 'change-risk-score';
  score.textContent = riskScoreText(risk);
  block.append(score);

  const signals = document.createElement('ul');
  signals.className = 'change-risk-signals';
  signals.dataset.role = 'change-risk-signals';
  for (const signal of riskSignalEntries(risk.signals)) {
    const item = document.createElement('li');
    item.dataset.kind = signal.kind;
    const label = document.createElement('span');
    label.textContent = signal.label;
    item.append(label);
    const evidence = document.createElement('span');
    evidence.className = 'evidence';
    evidence.textContent = `· value ${signal.value} / threshold ${signal.threshold} · contribution ${signal.contribution}`;
    item.append(evidence);
    signals.append(item);
  }
  block.append(signals);
  return block;
}
