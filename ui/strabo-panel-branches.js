/**
 * Branches, their divergence, and the review-loading placeholder.
 *
 * Split out of strabo-panels.js.
 */

import { button } from './strabo-panel-kit.js';


/** Days since an ISO date, or null when it does not parse. */
function ageInDays(iso, now = Date.now()) {
  const time = Date.parse(iso ?? '');
  return Number.isFinite(time) ? Math.max(0, Math.floor((now - time) / 86_400_000)) : null;
}


/** A compact age: `today`, `3d`, `5w`, `8mo`, `2y`. */
export function formatAge(days) {
  if (days === null || days === undefined) return '';
  if (days < 1) return 'today';
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  if (days < 730) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}


/** Branches untouched this long are called stale. */
export const STALE_BRANCH_DAYS = 90;


/**
 * How a branch stands, as short tags, most actionable first. Every tag is read from the
 * listing; none is inferred beyond it.
 */
export function branchTags(branch, now = Date.now()) {
  const tags = [];
  if (branch.isBase) tags.push({ text: 'base', tone: 'none' });
  if (branch.current) tags.push({ text: 'checked out', tone: 'none' });
  if (branch.kind === 'remote') tags.push({ text: 'remote only', tone: 'none' });
  if (branch.againstBase?.merged) tags.push({ text: 'merged', tone: 'better' });
  if (branch.upstream?.gone) {
    tags.push({ text: 'upstream gone', tone: 'worse' });
  } else if (branch.upstream && (branch.upstream.ahead > 0 || branch.upstream.behind > 0)) {
    const parts = [];
    if (branch.upstream.ahead > 0) parts.push(`${branch.upstream.ahead} to push`);
    if (branch.upstream.behind > 0) parts.push(`${branch.upstream.behind} to pull`);
    tags.push({ text: parts.join(', '), tone: 'worse' });
  } else if (!branch.upstream && branch.kind === 'local' && !branch.isBase) {
    tags.push({ text: 'no upstream', tone: 'none' });
  }
  const age = ageInDays(branch.tip?.date, now);
  if (age !== null && age >= STALE_BRANCH_DAYS) tags.push({ text: 'stale', tone: 'worse' });
  return tags;
}


/**
 * Branches against a base: commits ahead and behind, sync with the upstream, and age.
 * Selecting one opens its branch review. Counts are as fresh as the last fetch, and the
 * panel says so rather than implying a live remote.
 */
export function renderBranches(container, result, handlers = {}) {
  container.replaceChildren();

  const title = document.createElement('h3');
  title.textContent = 'Branches';
  container.append(title);
  if (handlers.onClose) {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'panel-dismiss';
    dismiss.setAttribute('aria-label', 'Close branches');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => handlers.onClose());
    title.append(dismiss);
  }

  if (!result || result.available === false) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'branches-unavailable';
    note.textContent = result?.detail ? `No branches: ${result.detail}` : 'No Git branches available.';
    container.append(note);
    return;
  }

  const baseLine = document.createElement('p');
  baseLine.className = 'evidence branch-base';
  baseLine.dataset.role = 'branches-base';
  if (result.base) {
    const label = document.createElement('label');
    label.textContent = 'Compared with ';
    const select = document.createElement('select');
    select.dataset.role = 'branches-base-select';
    for (const name of new Set([result.base.name, ...result.branches.map((branch) => branch.name)])) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      option.selected = name === result.base.name;
      select.append(option);
    }
    select.addEventListener('change', () => handlers.onBase?.(select.value));
    label.append(select);
    baseLine.append(label);
    const why = result.base.source === 'remote-default'
      ? ' · the remote’s default branch'
      : result.base.source === 'current'
        ? ' · checked out, no trunk found'
        : '';
    baseLine.append(document.createTextNode(`${why} · as of the last fetch`));
  } else {
    baseLine.textContent = 'No base branch found; divergence is not measured.';
  }
  container.append(baseLine);

  const others = result.branches.filter((branch) => !branch.isBase);
  const unmerged = others.filter((branch) => branch.againstBase && !branch.againstBase.merged).length;
  const summary = document.createElement('p');
  summary.className = 'overlay-summary';
  summary.dataset.role = 'branches-summary';
  summary.textContent = `${others.length} branch(es) · ${unmerged} with unmerged work${
    result.capped ? ' · list capped' : ''
  }`;
  container.append(summary);

  const maxCount = Math.max(
    1,
    ...others.map((branch) => Math.max(branch.againstBase?.ahead ?? 0, branch.againstBase?.behind ?? 0)),
  );

  const list = document.createElement('ul');
  list.className = 'branch-list';
  list.dataset.role = 'branches-list';
  for (const branch of result.branches) {
    const item = document.createElement('li');
    item.className = 'branch-row';
    if (branch.current) item.classList.add('current-branch');
    if (handlers.selected && handlers.selected === branch.name) item.classList.add('selected-branch');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'branch';
    button.dataset.branch = branch.name;
    button.textContent = branch.name;
    if (branch.isBase) {
      button.disabled = true;
      button.title = 'The base every other branch is compared with';
    } else if (handlers.onSelect) {
      button.title = `Review ${branch.name} against ${result.base?.name ?? 'the base'}`;
      button.addEventListener('click', () => handlers.onSelect(branch));
    }
    item.append(button);

    if (branch.againstBase) {
      item.append(divergenceBar(branch.againstBase, maxCount));
    }

    const meta = document.createElement('span');
    meta.className = 'evidence branch-meta';
    const age = formatAge(ageInDays(branch.tip?.date));
    meta.textContent = `${branch.tip.shortHash} · ${branch.tip.author}${age ? ` · ${age}` : ''} · ${branch.tip.subject}`;
    item.append(meta);

    const tags = branchTags(branch);
    if (tags.length > 0) {
      const tagLine = document.createElement('span');
      tagLine.className = 'branch-tags';
      tagLine.dataset.role = 'branch-tags';
      for (const tag of tags) {
        const chip = document.createElement('span');
        chip.className = `metric-delta ${tag.tone}`;
        chip.textContent = tag.text;
        tagLine.append(chip);
      }
      item.append(tagLine);
    }

    const actions = branchActions(branch, handlers);
    if (actions) {
      item.append(actions);
    }
    list.append(item);
  }
  container.append(list);
}


/**
 * The write actions a branch row offers, as explicit buttons. Push appears on a local branch
 * with unpublished or ahead work; Create MR on any local branch; Drop on a branch the listing
 * already calls stale. Every action is optional, so a read-only embedding renders none.
 */
function branchActions(branch, handlers) {
  const buttons = [];
  if (branch.kind === 'local' && !branch.isBase) {
    const publish = !branch.upstream || branch.upstream.gone;
    if (handlers.onPush && (publish || branch.upstream.ahead > 0)) {
      buttons.push({
        label: publish ? 'Publish' : 'Push',
        role: 'branch-push',
        title: publish
          ? `Publish ${branch.name} and set its upstream`
          : `Push ${branch.name} to ${branch.upstream.name}`,
        run: () => handlers.onPush(branch.name),
      });
    }
    if (handlers.onMergeRequest) {
      buttons.push({
        label: 'Create MR',
        role: 'branch-merge-request',
        title: `Open a new merge request for ${branch.name}`,
        run: () => handlers.onMergeRequest(branch.name),
      });
    }
    const stale = branch.upstream?.gone === true || branch.againstBase?.merged === true;
    if (handlers.onDrop && stale && !branch.current) {
      buttons.push({
        label: 'Drop',
        role: 'branch-drop',
        title: branch.upstream?.gone
          ? `Drop ${branch.name}: its upstream is gone`
          : `Drop ${branch.name}: merged into the base`,
        run: () => handlers.onDrop(branch.name),
      });
    }
  }
  if (buttons.length === 0) {
    return null;
  }
  const row = document.createElement('span');
  row.className = 'branch-actions';
  row.dataset.role = 'branch-actions';
  for (const spec of buttons) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = `branch-action ${spec.role}`;
    action.dataset.role = spec.role;
    action.dataset.branch = branch.name;
    action.textContent = spec.label;
    action.title = spec.title;
    action.addEventListener('click', (event) => {
      event.stopPropagation();
      spec.run();
    });
    row.append(action);
  }
  return row;
}


/**
 * Behind on the left, ahead on the right, of a centre line that stands for the base, each
 * scaled to the largest count in the list so branches compare at a glance.
 */
function divergenceBar(counts, maxCount) {
  const bar = document.createElement('span');
  bar.className = 'divergence';
  bar.dataset.role = 'branch-divergence';
  bar.title = `${counts.behind} commit(s) behind the base · ${counts.ahead} ahead`;
  const behind = document.createElement('span');
  behind.className = 'divergence-count';
  behind.textContent = `↓${counts.behind}`;
  const track = document.createElement('span');
  track.className = 'divergence-track';
  const left = document.createElement('span');
  left.className = 'divergence-fill behind';
  left.style.width = `${(counts.behind / maxCount) * 50}%`;
  const right = document.createElement('span');
  right.className = 'divergence-fill ahead';
  right.style.width = `${(counts.ahead / maxCount) * 50}%`;
  track.append(left, right);
  const ahead = document.createElement('span');
  ahead.className = 'divergence-count';
  ahead.textContent = `↑${counts.ahead}`;
  bar.append(behind, track, ahead);
  return bar;
}


/**
 * The branch half of a branch review: divergence, the trial-merge verdict, and the base's
 * newer changes that the branch's files build on.
 */
export function renderBranchDivergence(container, branch, handlers = {}) {
  const meta = document.createElement('p');
  meta.className = 'evidence';
  meta.dataset.role = 'review-branch';
  meta.textContent = `${branch.ahead} commit(s) ahead of ${branch.base} · ${branch.behind} behind · merge base ${branch.mergeBase.slice(0, 7)}`;
  container.append(meta);

  const merge = document.createElement('p');
  merge.dataset.role = 'review-merge';
  if (!branch.conflicts.available) {
    merge.className = 'unavailable';
    merge.textContent = `Trial merge unavailable (needs Git 2.38+): ${branch.conflicts.detail}`;
  } else if (branch.conflicts.clean) {
    merge.className = 'merge-verdict clean';
    merge.textContent =
      branch.behind > 0
        ? `Merges cleanly into ${branch.base}, which has moved ${branch.behind} commit(s) on.`
        : `Merges cleanly into ${branch.base}.`;
  } else {
    merge.className = 'merge-verdict conflicted';
    merge.textContent = `Conflicts with ${branch.base} in ${branch.conflicts.paths.length} file(s).`;
  }
  container.append(merge);

  const actions = document.createElement('p');
  actions.className = 'branch-actions review-branch-actions';
  actions.dataset.role = 'review-branch-actions';
  const addAction = (label, role, title, run) => {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = `branch-action ${role}`;
    action.dataset.role = role;
    action.dataset.branch = branch.branch;
    action.textContent = label;
    action.title = title;
    action.addEventListener('click', () => run(branch.branch));
    actions.append(action);
  };
  if (handlers.onPush) {
    addAction('Push', 'branch-push', `Push ${branch.branch} to its upstream`, handlers.onPush);
  }
  if (handlers.onMergeRequest) {
    addAction('Create MR', 'branch-merge-request', `Push ${branch.branch} and open a new merge request`, handlers.onMergeRequest);
  }
  if (actions.childElementCount > 0) {
    container.append(actions);
  }

  const fileList = (role, heading, entries, describe) => {
    if (entries.length === 0) return;
    const title = document.createElement('h4');
    title.textContent = `${heading} (${entries.length})`;
    container.append(title);
    const list = document.createElement('ul');
    list.dataset.role = role;
    for (const entry of entries.slice(0, 100)) {
      const id = typeof entry === 'string' ? entry : entry.id;
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link';
      button.dataset.path = id;
      button.textContent = id;
      if (handlers.onSelect) button.addEventListener('click', () => handlers.onSelect(id));
      item.append(button);
      const detail = describe?.(entry);
      if (detail) {
        const span = document.createElement('span');
        span.className = 'evidence';
        span.textContent = detail;
        item.append(span);
      }
      list.append(item);
    }
    container.append(list);
  };

  const conflicted = new Set(branch.conflicts.available ? branch.conflicts.paths : []);
  fileList('review-conflicts', 'Conflicting files', [...conflicted]);
  fileList(
    'review-overlap',
    'Also changed on the base',
    branch.overlap.filter((file) => !conflicted.has(file)),
    () => branch.conflicts.available ? 'merges without conflict' : null,
  );
  fileList(
    'review-moved-underneath',
    'Moved underneath the branch',
    branch.movedUnderneath,
    (entry) => `changed on the base · imported by ${entry.via}${entry.distance > 1 ? ` (distance ${entry.distance})` : ''}`,
  );

  if (!branch.checkedOut) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'review-branch-graph';
    note.textContent =
      'Impact is traced through the checked-out graph, not this branch’s own; check the branch out for its Change passport.';
    container.append(note);
  }
}
