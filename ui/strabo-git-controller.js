/**
 * The Git-facing panels and screens: Timeline, Branches, Review (with its Back history),
 * Dependency risk, and the full-screen Review and History tabs. Reviews annotate the map
 * with the change and impact the server recorded; nothing here writes to the repository
 * except the explicit branch actions, which the server validates.
 */

import {
  renderBranches,
  renderReview,
  renderReviewLoading,
  renderRisk,
  renderTimeline,
} from './strabo-panels.js';
import { API_PATH, reviewOverlay, riskSummary } from './strabo-core.js';

export function createGitController(app) {
  const { store, state, view, elements, request } = app;

  let selectedCommitHash = null;
  let selectedBranchName = null;

  /** The base the Branches panel compares with; null lets the server pick the trunk. */
  let branchBase = null;

  /** True while a branch fetch/push/sync is in flight, so the panel disables its actions. */
  let branchesBusy = false;

  /** Reviews shown in the Review panel, oldest first, so Back can step down to one. */
  let reviewHistory = [];

  /** The review the panel is showing, so the next navigation can push it onto the history. */
  let currentReviewRequest = null;

  /** Show or hide recorded changes; selecting one compares it with the working tree. */
  async function toggleTimeline() {
    if (!elements.timelinePanel.hidden) {
      elements.timelinePanel.hidden = true;
      return;
    }
    elements.timelinePanel.hidden = false;
    const query = state.repository ? `?repository=${encodeURIComponent(state.repository)}` : '';
    const result = await request(`/analysis/timeline${query}`);
    const driftQuery = state.repository
      ? `?limit=20&repository=${encodeURIComponent(state.repository)}`
      : '?limit=20';
    const draw = (metrics, drift) =>
      renderTimeline(elements.timelinePanel, result, (commit) => {
        selectCommit(commit).catch((error) => {
          elements.status.textContent = `Error: ${error.message}`;
        });
      }, {
        selectedHash: selectedCommitHash,
        metrics,
        drift,
        onClose: () => {
          elements.timelinePanel.hidden = true;
        },
      });
    draw(null, null);
    if (result?.available === false) {
      return;
    }
    // Per-commit change metrics and the architecture-drift series arrive after the list:
    // uncached commits are measured on the server, so the timeline is usable first and the
    // badges and chart fill in when they are ready.
    const [history, drift] = await Promise.all([
      request(`/analysis/change-metrics/history${query}`).catch(() => null),
      request(`/analysis/drift${driftQuery}`).catch(() => null),
    ]);
    if (!elements.timelinePanel.hidden && (history?.available || drift !== null)) {
      draw(
        history?.available ? new Map(history.commits.map((entry) => [entry.commit.hash, entry.totals])) : null,
        drift,
      );
    }
  }

  /**
   * Show branches against a base; selecting one reviews its work since it left the base.
   * The base starts as the server's choice (the remote's default branch) and follows the
   * panel's picker after that.
   */
  async function toggleBranches() {
    if (!elements.branchesPanel.hidden) {
      elements.branchesPanel.hidden = true;
      return;
    }
    elements.branchesPanel.hidden = false;
    await loadBranches();
  }

  async function loadBranches() {
    const params = new URLSearchParams();
    if (state.repository) params.set('repository', state.repository);
    if (branchBase) params.set('base', branchBase);
    const query = params.toString() ? `?${params}` : '';
    const result = await request(`/analysis/branches${query}`);
    if (result?.available && result.base) branchBase = result.base.name;
    renderBranches(elements.branchesPanel, result, {
      selected: selectedBranchName,
      busy: branchesBusy,
      onSelect: (branch) => {
        selectBranch(branch.name).catch((error) => {
          elements.status.textContent = `Error: ${error.message}`;
        });
      },
      onBase: (name) => {
        branchBase = name;
        loadBranches().catch((error) => {
          elements.status.textContent = `Error: ${error.message}`;
        });
      },
      onFetch: () => runBranchAction('fetch', {}),
      onPull: () => runBranchAction('pull', { branch: result?.current }),
      onPullBranch: (branch) => runBranchAction('pull', { branch: branch.name }),
      onPush: (branch) => runBranchAction('push', { branch: branch.name }),
      onClose: () => {
        elements.branchesPanel.hidden = true;
      },
    });
  }

  /**
   * Run one branch action (fetch, pull, push, or fast-forward sync) and reload the listing.
   *
   * The server is the authority: it validates the ref, never force-pushes, and reports a
   * classified reason. The panel simply shows the message and refreshes its counts.
   */
  async function runBranchAction(action, payload) {
    if (branchesBusy) return;
    if ((action === 'sync' || action === 'pull') && !payload.branch) {
      elements.status.textContent = `${action === 'pull' ? 'Pull' : 'Sync'} needs a checked-out branch.`;
      return;
    }
    branchesBusy = true;
    await loadBranches().catch((error) => {
      elements.status.textContent = `Error: ${error.message}`;
    });
    try {
      const params = state.repository ? `?repository=${encodeURIComponent(state.repository)}` : '';
      const response = await fetch(`${API_PATH}/analysis/branches/${action}${params}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error ?? `${response.status} ${response.statusText}`);
      }
      elements.status.textContent = body.available === false
        ? `${action} failed: ${body.detail}`
        : body.message;
    } catch (error) {
      elements.status.textContent = `Error: ${error.message}`;
    } finally {
      branchesBusy = false;
      await loadBranches().catch((error) => {
        elements.status.textContent = `Error: ${error.message}`;
      });
    }
  }

  /** Review a branch against the panel's base and annotate the map with its impact. */
  async function selectBranch(name) {
    selectedBranchName = name;
    const against = branchBase ? `&against=${encodeURIComponent(branchBase)}` : '';
    await showReview(`?branch=${encodeURIComponent(name)}${against}`, null, name);
    for (const row of elements.branchesPanel.querySelectorAll('.branch-row')) {
      row.classList.toggle('selected-branch', row.querySelector('.branch')?.dataset.branch === name);
    }
  }

  /** Compare a revision with the working tree and annotate the map with the impact. */
  async function selectCommit(commit) {
    selectedCommitHash = commit.hash;
    await showReview(`?base=${encodeURIComponent(commit.hash)}`, commit);
  }

  /**
   * Load a Git review and annotate the map with its change and impact classes.
   *
   * `query` is either empty (working tree) or `?base=<ref>` (that commit's own changes).
   * The review result is rendered verbatim; a file outside the graph is reported as such
   * instead of being drawn as if it had impact. Each navigation pushes the review it
   * replaces, so the panel's Back steps down through the reviews this session has shown.
   */
  async function showReview(query, commit = null, branchName = null, { fromHistory = false } = {}) {
    const entry = { query, commit, branchName };
    if (!fromHistory && currentReviewRequest) {
      reviewHistory.push(currentReviewRequest);
    }
    currentReviewRequest = entry;
    const navigation = {
      canGoBack: reviewHistory.length > 0,
      onBack: reviewBack,
    };
    const separator = query ? '&' : '?';
    const repository = state.repository ? `${separator}repository=${encodeURIComponent(state.repository)}` : '';
    const ticket = ++reviewTicket;
    elements.reviewPanel.hidden = false;
    renderReviewLoading(elements.reviewPanel, { onClose: closeReview, ...navigation });
    let data;
    try {
      data = await request(`/analysis/review${query}${repository}`);
    } catch (error) {
      if (ticket === reviewTicket) {
        renderReview(elements.reviewPanel, { available: false, detail: error.message }, { onClose: closeReview, ...navigation });
      }
      throw error;
    }
    // The panel was closed, or another review started, while this one was computing.
    if (ticket !== reviewTicket) return;

    app.currentReview = data;
    if (data.available === false) {
      elements.reviewPanel.hidden = false;
      renderReview(elements.reviewPanel, data, { onClose: closeReview, ...navigation });
      return;
    }

    // A commit review compares two revisions, so the Structure section can name the
    // structural events. The document is the one `strabo report` prints.
    if (commit) {
      try {
        data.structural = await request(`/analysis/structural-diff?base=${encodeURIComponent(commit.hash)}${repository}`);
      } catch (error) {
        data.structural = { available: false, reason: 'git-error', detail: error.message };
      }
      if (ticket !== reviewTicket) return;
    }

    // The review's narrator affordance needs the status before it renders.
    if (app.narratorStatus === null) {
      app.narratorStatus = await app.narration.fetchNarratorStatus();
    }
    // The panel was closed, or another review started, during the status fetch.
    if (ticket !== reviewTicket) return;

    const overlay = reviewOverlay(data);
    view.overlay(overlay.classes);
    elements.reviewPanel.hidden = false;
    renderReview(elements.reviewPanel, data, reviewHandlers(data, navigation));
    // The full-screen Review tab mirrors the panel's evidence, so re-render it too when it is
    // the active screen; otherwise the tab would show the review it had before this one.
    if (store.get().ui.screen === 'review') {
      renderReview(elements.reviewScreenBody, data, reviewHandlers(data, navigation, () => app.setScreen('graph')));
    }
    const label = branchName ?? (commit ? commit.shortHash : 'working tree');
    elements.status.textContent = `Review ${label}: ${overlay.summary}`;
  }

  /** Step the Review panel down to the review it replaced, if any. */
  async function reviewBack() {
    const previous = reviewHistory.pop();
    if (!previous) {
      return;
    }
    try {
      await showReview(previous.query, previous.commit, previous.branchName, { fromHistory: true });
    } catch (error) {
      elements.status.textContent = `Error: ${error.message}`;
    }
  }

  /** Bumped by every review request and by closing, so a late response can tell it is stale. */
  let reviewTicket = 0;

  function closeReview() {
    reviewTicket += 1;
    app.currentReview = null;
    reviewHistory = [];
    currentReviewRequest = null;
    elements.reviewPanel.hidden = true;
    elements.reviewPanel.replaceChildren();
  }

  /** Forget which commit and branch the panels marked; a new scan starts unmarked. */
  function clearReviewMarks() {
    selectedCommitHash = null;
    selectedBranchName = null;
  }

  /** Review pending working-tree changes: staged, unstaged, and untracked. */
  async function toggleReview() {
    if (!elements.reviewPanel.hidden) {
      closeReview();
      view.overlay(null);
      return;
    }
    try {
      await showReview('');
    } catch (error) {
      elements.status.textContent = `Error: ${error.message}`;
    }
  }

  /**
   * Load the dependency-risk report: advisories, licenses, and imported files.
   *
   * This is the one endpoint that may contact a third party (OSV.dev, deps.dev). It is
   * opt-in server-side; when disabled the report still lists dependencies and imports.
   */
  async function showRisk() {
    const repository = state.repository ? `?repository=${encodeURIComponent(state.repository)}` : '';
    const report = await request(`/analysis/risk${repository}`);
    closeReview();
    elements.riskPanel.hidden = false;
    renderRisk(elements.riskPanel, report, {
      onClose: closeRisk,
      onSelect: (id) => app.selection.selectNode(id),
    });
    elements.status.textContent = riskSummary(report);
  }

  function closeRisk() {
    elements.riskPanel.hidden = true;
    renderRisk(elements.riskPanel, null, {});
  }

  async function toggleRisk() {
    if (!elements.riskPanel.hidden) {
      closeRisk();
      return;
    }
    try {
      await showRisk();
    } catch (error) {
      elements.status.textContent = `Error: ${error.message}`;
    }
  }

  /** Which two sides a review row's change is between. */
  function reviewDiffSpec(result, file) {
    if (result?.kind === 'commit' && result.ref) {
      return { ref: result.ref };
    }
    if (result?.kind === 'branch' && result.branch) {
      return { base: result.branch.mergeBase, head: result.branch.tipHash };
    }
    if (file?.group === 'staged') return { staged: 1 };
    if (file?.group === 'untracked') return { untracked: 1 };
    return {};
  }

  elements.tbBranches.addEventListener('click', () => {
    toggleBranches().catch((error) => {
      elements.status.textContent = `Error: ${error.message}`;
    });
  });

  elements.tbTimeline.addEventListener('click', () => {
    toggleTimeline().catch((error) => {
      elements.status.textContent = `Error: ${error.message}`;
    });
  });

  elements.tbReview.addEventListener('click', () => {
    toggleReview().catch((error) => {
      elements.status.textContent = `Error: ${error.message}`;
    });
  });

  elements.tbRisk.addEventListener('click', () => {
    toggleRisk().catch((error) => {
      elements.status.textContent = `Error: ${error.message}`;
    });
  });

  /**
   * The handler set a review render needs, shared by the floating Review panel and the
   * full-screen Review tab so the same evidence and actions appear in both.
   *
   * `onClose` differs by surface: the floating panel hides itself, while the full-screen tab
   * returns to the graph (there is no panel to hide).
   */
  function reviewHandlers(data, navigation, onClose = closeReview) {
    return {
      onClose,
      ...navigation,
      onSelect: (id) => selectFromReview(id),
      onOpenDiff: (file, entry) => openReviewDiff(data, file, entry),
      narratorStatus: app.narratorStatus,
      onNarrate: () => app.narration.narrateReview(data),
      onOpenNarratorSettings: app.settings.openNarratorSettings,
    };
  }

  /**
   * Select a file from a review. The full-screen Review tab hides the graph and every floating
   * window, so return to the graph first. Then raise the Module Passport: an already-open
   * passport would otherwise be re-rendered behind the Review window that asked for the
   * selection, and the click would look like it did nothing.
   */
  function selectFromReview(id) {
    if (store.get().ui.screen !== 'graph') {
      app.setScreen('graph');
    }
    app.selection.selectNode(id);
    if (!elements.inspector.hidden) {
      app.floatingWindows?.find((controller) => controller.key === 'inspector')?.raise?.();
    }
  }

  /**
   * Open a review row's Diff. The viewer is a floating window, and a full-screen Git tab hides
   * every floating window, so return to the graph first; from the floating Review panel the
   * graph is already showing and nothing changes.
   */
  function openReviewDiff(data, file, entry) {
    if (store.get().ui.screen !== 'graph') {
      app.setScreen('graph');
    }
    app.source.viewDiff(file, reviewDiffSpec(data, entry), { status: entry.status });
  }

  /**
   * The full-screen Review tab: show the working-tree change set, or the review this session
   * last opened (a commit or branch), rendered at the full width of the workspace.
   *
   * The floating Review panel owns the request; this simply re-renders whatever it already
   * loaded into the wider body, so switching tabs never triggers a second Git pass. With
   * nothing reviewed yet it starts the working-tree review.
   */
  function openReviewScreen() {
    const body = elements.reviewScreenBody;
    if (!body) {
      return;
    }
    if (!app.currentReview) {
      body.replaceChildren();
      const note = document.createElement('p');
      note.className = 'evidence';
      note.textContent = 'Reviewing the working tree…';
      body.append(note);
      showReview('').catch((error) => {
        elements.status.textContent = `Error: ${error.message}`;
      });
      return;
    }
    const navigation = { canGoBack: reviewHistory.length > 0, onBack: reviewBack };
    renderReview(body, app.currentReview, reviewHandlers(app.currentReview, navigation, () => app.setScreen('graph')));
    if (app.currentReview.available !== false) {
      const label = currentReviewRequest?.branchName
        ?? (currentReviewRequest?.commit ? currentReviewRequest.commit.shortHash : 'working tree');
      elements.status.textContent = `Review ${label}`;
    }
  }

  /** Recompute the change set currently shown in the full-screen Review tab. */
  function refreshReviewScreen() {
    const entry = currentReviewRequest ?? { query: '', commit: null, branchName: null };
    showReview(entry.query, entry.commit, entry.branchName, { fromHistory: true }).catch((error) => {
      elements.status.textContent = `Error: ${error.message}`;
    });
  }

  elements.reviewScreenPending?.addEventListener('click', () => {
    showReview('').catch((error) => {
      elements.status.textContent = `Error: ${error.message}`;
    });
  });

  elements.reviewScreenRefresh?.addEventListener('click', refreshReviewScreen);

  elements.historyScreenRefresh?.addEventListener('click', () => {
    loadTimelineScreen().catch((error) => {
      elements.status.textContent = `Error: ${error.message}`;
    });
  });

  /**
   * The full-screen History tab: the recorded commits and the architecture-drift chart,
   * rendered at full width and kept separate from the floating Timeline panel so opening the
   * tab never triggers a second history pass for the same repository.
   */
  async function loadTimelineScreen() {
    const body = elements.historyScreenBody;
    if (!body) {
      return;
    }
    body.replaceChildren();
    const note = document.createElement('p');
    note.className = 'evidence';
    note.textContent = 'Loading recorded history…';
    body.append(note);
    const query = state.repository ? `?repository=${encodeURIComponent(state.repository)}` : '';
    const driftQuery = state.repository
      ? `?limit=20&repository=${encodeURIComponent(state.repository)}`
      : '?limit=20';
    const [result, history, drift] = await Promise.all([
      request(`/analysis/timeline${query}`),
      request(`/analysis/change-metrics/history${query}`).catch(() => null),
      request(`/analysis/drift${driftQuery}`).catch(() => null),
    ]);
    renderTimeline(body, result, (commit) => {
      selectCommit(commit).catch((error) => {
        elements.status.textContent = `Error: ${error.message}`;
      });
    }, {
      selectedHash: selectedCommitHash,
      metrics: history?.available ? new Map(history.commits.map((entry) => [entry.commit.hash, entry.totals])) : null,
      drift,
    });
  }

  /**
   * Opening the History tab loads the recorded commits and the drift chart into the screen.
   * The server caches each commit's measured metrics on disk, so a repeat visit is fast.
   */
  function openHistoryScreen() {
    loadTimelineScreen().catch((error) => {
      elements.status.textContent = `Error: ${error.message}`;
    });
  }

  return {
    clearReviewMarks,
    closeReview,
    closeRisk,
    openHistoryScreen,
    openReviewScreen,
    showReview,
    showRisk,
    toggleBranches,
    toggleReview,
    toggleRisk,
    toggleTimeline,
  };
}
