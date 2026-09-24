/**
 * Delegating to an agent from a right-click: the recorded facts for a node, edge, group,
 * diagnostic, commit, review, member, or view, and the context menu that launches an agent
 * session on them or copies the prompt. Targets carry recorded evidence only.
 */

import { buildAgentPrompt, edgeEvidenceFor, graphSummary, passportFor } from './strabo-core.js';
import {
  closeContextMenu,
  copyText,
  launchAgent,
  showContextMenu,
  showPromptReview,
  showToast,
} from './strabo-delegate.js';
import { writeIslandLayout } from './strabo-island-layout.js';

export function createDelegation(app) {
  const { state, view, elements } = app;

  /** Recorded facts for a node, from the passport the scan computed. */
  function nodeDelegateTarget(id) {
    const passport = app.current ? passportFor(app.current, id) : null;
    const node = app.current?.nodes.find((candidate) => candidate.id === id);
    const evidence = [];
    if (passport) {
      for (const metric of passport.metrics) {
        evidence.push(`${metric.label}: ${metric.value}`);
      }
      for (const entry of passport.imports.slice(0, 8)) {
        evidence.push(`imports ${entry.id} (L${entry.line ?? '?'} ${entry.specifier ?? ''})`.replace(' )', ')'));
      }
      for (const entry of passport.usedBy.slice(0, 8)) {
        evidence.push(`imported by ${entry.id} (L${entry.line ?? '?'} ${entry.specifier ?? ''})`.replace(' )', ')'));
      }
    } else {
      evidence.push('Node is not in the current graph (it may be filtered out).');
    }
    return { kind: 'node', id, label: node?.label ?? id, evidence };
  }

  /** Combine every selected node's passport into one delegation target. */
  function groupDelegateTarget() {
    const items = app.groupSelection.map((id) => nodeDelegateTarget(id));
    return { kind: 'group', label: `${items.length} file(s)`, items };
  }

  /** Reflect cytoscape's native selection in the toolbar chip and delegate button. */
  function updateGroupUI(ids) {
    app.groupSelection = ids ?? [];
    const count = app.groupSelection.length;
    // A plain click already selects its one node in cytoscape's terms — that's not a
    // "group" a person meant to build, so the toolbar stays quiet until there are two.
    const active = count >= 2;
    elements.groupCount.hidden = !active;
    elements.groupCount.textContent = active ? `${count} selected` : '';
    elements.tbDelegateGroup.hidden = !active;
  }

  view.onGroupChange(updateGroupUI);

  elements.tbDelegateGroup.addEventListener('click', () => {
    // Anchor to the button itself rather than the event's coordinates: the keyboard
    // shortcut (G) dispatches a synthetic click with no real pointer position.
    const rect = elements.tbDelegateGroup.getBoundingClientRect();
    openDelegateMenu(groupDelegateTarget(), rect.left, rect.bottom + 4);
  });

  /** Recorded facts for an edge, from the evidence the scanner recorded. */
  function edgeDelegateTarget(edgeId) {
    const evidence = app.current ? edgeEvidenceFor(app.current, edgeId) : null;
    if (!evidence) {
      return null;
    }
    return {
      kind: 'edge',
      id: edgeId,
      label: `${evidence.source} → ${evidence.target}`,
      evidence: [
        `relationship: ${evidence.kind}`,
        `specifier: ${evidence.specifier ?? 'not recorded'}`,
        `line: ${evidence.line ?? 'not recorded'}`,
        `resolution: ${evidence.resolutionLabel}`,
      ],
    };
  }

  /** A diagnostic line has the controlled form `file:line message`. */
  function diagnosticDelegateTarget(text) {
    const match = /^(.+):(\d+)\s?(.*)$/.exec(String(text ?? '').trim());
    return {
      kind: 'diagnostic',
      id: match ? `${match[1]}:${match[2]}` : String(text ?? 'diagnostic'),
      label: String(text ?? 'diagnostic').slice(0, 120),
      detail: String(text ?? ''),
      evidence: match
        ? [`file: ${match[1]}`, `line: ${match[2]}`, `message: ${match[3] || '—'}`]
        : [String(text ?? '')],
    };
  }

  /**
   * Recorded facts for the currently shown Git review: which files changed, by how much,
   * and what depends on them — the same evidence rendered in the panel, nothing more.
   */
  function reviewDelegateTarget(result) {
    const label =
      result.kind === 'branch' && result.branch
        ? `branch ${result.branch.branch} against ${result.branch.base}`
        : result.kind === 'commit' && result.commit
          ? `commit ${result.commit.shortHash}`
          : 'pending working tree';
    const evidence = [];
    if (result.branch) {
      const branch = result.branch;
      evidence.push(
        `branch: ${branch.branch} is ${branch.ahead} commit(s) ahead of ${branch.base} and ${branch.behind} behind; merge base ${branch.mergeBase}`,
      );
      if (branch.conflicts.available) {
        evidence.push(
          branch.conflicts.clean
            ? `trial merge into ${branch.base}: clean`
            : `trial merge into ${branch.base}: conflicts in ${branch.conflicts.paths.join(', ')}`,
        );
      }
      for (const entry of branch.movedUnderneath.slice(0, 30)) {
        evidence.push(`changed on ${branch.base} since the merge base, imported by ${entry.via}: ${entry.id}`);
      }
    } else if (result.commit) {
      evidence.push(`commit: ${result.commit.shortHash} · ${result.commit.author} · ${result.commit.subject}`);
    }
    for (const file of result.files ?? []) {
      const counts =
        file.insertions === null || file.deletions === null
          ? 'line counts unavailable'
          : `+${file.insertions} -${file.deletions}`;
      evidence.push(`${file.status} (${file.group}): ${file.path} — ${counts}${file.inGraph ? '' : ' (outside scanned graph)'}`);
    }
    const affected = (result.impact?.affected ?? []).filter((entry) => entry.distance > 0);
    for (const entry of affected.slice(0, 30)) {
      evidence.push(`potentially affected: ${entry.id} (distance ${entry.distance})`);
    }
    if (affected.length > 30) {
      evidence.push(`…and ${affected.length - 30} more affected file(s) (truncated).`);
    }
    return { kind: 'review', label, evidence };
  }

  function commitDelegateTarget(button) {
    const meta = button.parentElement?.querySelector('.evidence')?.textContent ?? '';
    return {
      kind: 'commit',
      id: button.dataset.hash ?? button.textContent,
      label: button.textContent.trim().slice(0, 120),
      detail: meta ? `${button.textContent.trim()} (${meta.trim()})` : button.textContent.trim(),
      evidence: meta ? [`commit: ${button.textContent.trim()}`, `meta: ${meta.trim()}`] : [],
    };
  }

  function memberDelegateTarget(card) {
    const name = card.dataset.member ?? 'member';
    const file = app.memberData?.file ?? app.selected;
    const facts = [...card.querySelectorAll('.card-signature, .card-tag, .card-metrics')]
      .map((part) => part.textContent.trim())
      .filter(Boolean);
    return {
      kind: 'member',
      id: file ? `${file}#${name}` : name,
      label: `${name} (${file ?? 'unknown file'})`,
      evidence: [`member: ${name}`, `file: ${file ?? 'unknown'}`, ...facts],
    };
  }

  function overlayDelegateTarget(item) {
    const heading = document.querySelector('#overlay-panel h3')?.textContent ?? 'Review overlay';
    return {
      kind: 'view',
      label: heading.trim().slice(0, 120),
      detail: item.dataset.delegateOverlayItem ?? item.textContent.trim(),
      evidence: [`overlay: ${heading.trim()}`, `item: ${(item.dataset.delegateOverlayItem ?? item.textContent).trim()}`],
    };
  }

  function viewDelegateTarget(detail) {
    return {
      kind: 'view',
      label: detail ?? graphSummary(app.current ?? { nodes: [], edges: [] }),
      detail: detail ?? undefined,
      evidence: [
        app.current ? graphSummary(app.current) : 'No scan loaded.',
        state.filter ? `active filter: ${state.filter}` : 'no active filter',
        state.overlay !== 'none' ? `active review: ${state.overlay}` : 'no active review overlay',
        state.mode === 'block'
          ? `directory view${state.prefix ? ` at ${state.prefix}` : ''}`
          : state.mode === 'system'
            ? 'system view'
            : 'file view',
      ],
    };
  }

  function fallbackDelegateTarget() {
    return app.selected ? nodeDelegateTarget(app.selected) : viewDelegateTarget();
  }

  function resolveDomDelegateTarget(node) {
    if (!node?.closest) {
      return null;
    }
    const byNode = node.closest('[data-delegate-node]');
    if (byNode?.dataset.delegateNode) {
      return nodeDelegateTarget(byNode.dataset.delegateNode);
    }
    const diagnostic = node.closest('[data-delegate-diagnostic]');
    if (diagnostic?.dataset.delegateDiagnostic) {
      return diagnosticDelegateTarget(diagnostic.dataset.delegateDiagnostic);
    }
    const commit = node.closest('#timeline-panel .commit');
    if (commit) {
      return commitDelegateTarget(commit);
    }
    const reviewPanel = node.closest('#review-panel');
    if (reviewPanel && app.currentReview?.available) {
      return reviewDelegateTarget(app.currentReview);
    }
    const overlayItem = node.closest('#overlay-panel [data-delegate-overlay-item]');
    if (overlayItem) {
      return overlayDelegateTarget(overlayItem);
    }
    const edgePanel = node.closest('#edge-panel');
    if (edgePanel && app.selectedEdgeId) {
      return edgeDelegateTarget(app.selectedEdgeId);
    }
    const card = node.closest('#member-view .member-card');
    if (card) {
      return memberDelegateTarget(card);
    }
    if (node.closest('#inspector') && app.selected) {
      return nodeDelegateTarget(app.selected);
    }
    const chip = node.closest('.strip-chip');
    if (chip) {
      return viewDelegateTarget(`filter: ${chip.dataset.filter || 'all'}`);
    }
    const crumb = node.closest('#breadcrumb .crumb');
    if (crumb) {
      return viewDelegateTarget(`directory: ${crumb.textContent.trim()}`);
    }
    return null;
  }

  /**
   * Seed an in-app agent session on the delegated item, after the prompt is reviewed.
   * The delegate module attaches the returned session through the registered opener.
   */
  async function delegateToAgent(agent, target) {
    const repository = app.current?.repository ?? null;
    const prompt = buildAgentPrompt({ agent, repository, target });
    const title = (target.label ?? target.id ?? 'repository view').slice(0, 80);
    const reviewed = await showPromptReview({ agent, title, prompt });
    if (reviewed === null) {
      return;
    }
    try {
      const result = await launchAgent(agent, {
        repository: state.repository ?? repository?.root,
        target: { kind: target.kind, id: target.id, label: target.label },
        prompt: reviewed,
        title,
      });
      showToast(
        result?.sessionId
          ? `Opened ${agent} in the Terminal on ${title} — edit the prefilled task, then send.`
          : `Prepared ${agent} on ${title}.`,
      );
    } catch (error) {
      showToast(`Could not open an agent session (${error.message}).`, {
        label: 'Copy prompt',
        onClick: async () => {
          await copyText(reviewed);
          showToast('Prompt copied — paste it into your agent.');
        },
      });
    }
  }

  /** Drop every stored island move for the current repository and repaint the computed layout. */
  function resetMapLayout() {
    view.resetIslandOffsets();
    writeIslandLayout(state.repository, {});
    // A re-render drops the visible set the filter published, so republish it.
    app.applyFilterToView();
    showToast('Map layout reset to the computed arrangement.');
  }

  /** A reset entry, offered only where a view actually has a moved layout to restore. */
  function layoutMenuItems(target) {
    if (target?.kind !== 'view' || Object.keys(view.islandOffsets()).length === 0) {
      return [];
    }
    return [
      { label: '↺ Reset map layout', hint: 'computed positions', action: resetMapLayout },
      { separator: true },
    ];
  }

  /** Right-click menu for one delegated item: launch, or copy the prompt. */
  function openDelegateMenu(target, x, y) {
    if (!target) {
      return;
    }
    const repository = app.current?.repository ?? null;
    const menuTitle = (target.label ?? target.id ?? 'repository view').slice(0, 80);
    const promptFor = (agent) => buildAgentPrompt({ agent, repository, target });
    showContextMenu({
      x,
      y,
      title: menuTitle,
      items: [
        ...app.narration.narrateMenuItems(target),
        ...layoutMenuItems(target),
        { label: '▶ Delegate to OpenCode', hint: 'opens agent session', action: () => delegateToAgent('opencode', target) },
        { label: '▶ Delegate to Claude', hint: 'opens agent session', action: () => delegateToAgent('claude', target) },
        { separator: true },
        {
          label: '⧉ Copy prompt',
          action: async () => {
            await copyText(promptFor('opencode'));
            showToast('Prompt copied — paste it into your agent.');
          },
        },
        ...(target.id
          ? [{
            label: '⧉ Copy path',
            action: async () => {
              await copyText(target.id);
              showToast('Path copied.');
            },
          }]
          : []),
        ...(Array.isArray(target.items) && target.items.length > 0
          ? [{
            label: '⧉ Copy paths',
            action: async () => {
              await copyText(target.items.map((entry) => entry.id ?? entry.label).join('\n'));
              showToast(`${target.items.length} path(s) copied.`);
            },
          }]
          : []),
      ],
    });
  }

  view.onContext((target, originalEvent) => {
    app.selection.hideTooltip();
    const x = originalEvent?.clientX ?? window.innerWidth / 2;
    const y = originalEvent?.clientY ?? window.innerHeight / 2;
    // Right-clicking a node that's part of the current multi-selection acts on the whole
    // group, same as most desktop apps; right-clicking outside it targets just that node,
    // leaving the group selection as-is underneath.
    if (target.kind === 'node' && target.id && app.groupSelection.length >= 2 && app.groupSelection.includes(target.id)) {
      openDelegateMenu(groupDelegateTarget(), x, y);
    } else if (target.kind === 'node' && target.id) {
      openDelegateMenu(nodeDelegateTarget(target.id), x, y);
    } else if (target.kind === 'edge' && target.id) {
      openDelegateMenu(edgeDelegateTarget(target.id) ?? viewDelegateTarget('edge'), x, y);
    } else {
      openDelegateMenu(fallbackDelegateTarget(), x, y);
    }
  });

  document.addEventListener('contextmenu', (event) => {
    // Editable fields and dialogs keep the native menu (copy/paste, close).
    if (event.target.closest?.('input, select, textarea, [contenteditable="true"], dialog')) {
      return;
    }
    // The terminal owns its right-click menu (copy/paste); the delegate menu is noise there.
    if (event.target.closest?.('.terminal-screen')) {
      return;
    }
    // The canvas menu comes from cytoscape's cxttap; just suppress the browser one.
    if (event.target.closest?.('#graph')) {
      event.preventDefault();
      return;
    }
    // Everywhere else in the app shell, offer the delegate menu; outside it, stay native.
    if (!event.target.closest?.('.workspace, .statusbar, #member-view, #diagnostics, #breadcrumb, .toolbar')) {
      return;
    }
    // Read before anything else runs: opening the menu must not be able to disturb it.
    const selection = window.getSelection?.()?.toString().trim() ?? '';
    event.preventDefault();
    closeContextMenu();
    app.selection.hideTooltip();
    const resolved = resolveDomDelegateTarget(event.target);
    openDelegateMenu(withSelection(resolved, selection), event.clientX, event.clientY);
  });

  /**
   * Add highlighted text to a delegation target. With no specific target under the cursor the
   * selection is the subject, and the fallback view or node becomes its context, rather than
   * the generic overview the menu would otherwise be titled with.
   */
  function withSelection(resolved, selection) {
    if (!selection) {
      return resolved ?? fallbackDelegateTarget();
    }
    if (resolved) {
      return { ...resolved, selection };
    }
    const context = fallbackDelegateTarget();
    const excerpt = selection.replace(/\s+/g, ' ');
    return {
      kind: 'selection',
      label: `“${excerpt.length > 60 ? `${excerpt.slice(0, 60)}…` : excerpt}”`,
      evidence: context.evidence,
      selection,
    };
  }

  return {
    resetMapLayout,
  };
}
