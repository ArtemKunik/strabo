/**
 * Every auxiliary panel as a floating window, and the floating canvas toolbar. The panels
 * keep their ids and `hidden` semantics; these handlers only supply app-aware open/close,
 * so the dock can restore a panel without desyncing overlay or selection state.
 */

import { initFloatingWindows } from './strabo-float.js';
import { renderShortcuts } from './strabo-panels.js';
import { initFloatingToolbar } from './strabo-float-toolbar.js';

export function createFloatingPanels(app) {
  const { state, view, elements } = app;

  /** Show the keyboard cheat-sheet in its own floating window. Declared with `function` so
   * the key handler above can call it before `floatingWindows` is assigned. */
  function toggleShortcuts() {
    app.floatingWindows?.find?.((controller) => controller.key === 'shortcuts')?.toggle();
  }

  /**
   * Turn every auxiliary panel into a floating window. The panels keep their ids and
   * `hidden` semantics; these handlers only supply app-aware open/close so the dock can
   * restore a panel without desyncing overlay or selection state.
   */
  app.floatingWindows = initFloatingWindows({
    dock: document.getElementById('float-dock'),
    panels: [
      {
        key: 'review',
        element: elements.reviewPanel,
        title: 'Review',
        dockLabel: 'Review',
        dock: false, // Review is a screen tab, and R toggles this panel
        width: 400,
        // The heading's own text, without the dismiss button's `×`.
        titleFrom: (panel) => panel.querySelector('h3')?.firstChild?.textContent?.trim() ?? '',
        onOpen: () => {
          if (elements.reviewPanel.hidden) app.git.toggleReview();
        },
        onClose: () => {
          app.git.closeReview();
          view.overlay(null);
        },
      },
      {
        key: 'risk',
        element: elements.riskPanel,
        title: 'Dependency risk',
        dockLabel: 'Risk',
        glyph: '⚠',
        width: 400,
        onOpen: () => {
          if (elements.riskPanel.hidden) app.git.toggleRisk();
        },
        onClose: () => app.git.closeRisk(),
      },
      {
        key: 'timeline',
        element: elements.timelinePanel,
        title: 'Timeline',
        dockLabel: 'Timeline',
        dock: false, // History is a screen tab, and T toggles this panel
        width: 380,
        onOpen: () => {
          if (elements.timelinePanel.hidden) {
            app.git.toggleTimeline().catch((error) => {
              elements.status.textContent = `Error: ${error.message}`;
            });
          }
        },
        onClose: () => {
          elements.timelinePanel.hidden = true;
        },
      },
      {
        key: 'branches',
        element: elements.branchesPanel,
        title: 'Branches',
        dockLabel: 'Branches',
        glyph: '⑂',
        width: 420,
        onOpen: () => {
          if (elements.branchesPanel.hidden) {
            app.git.toggleBranches().catch((error) => {
              elements.status.textContent = `Error: ${error.message}`;
            });
          }
        },
        onClose: () => {
          elements.branchesPanel.hidden = true;
        },
      },
      {
        key: 'narration',
        element: elements.narrationPanel,
        title: 'Narrator',
        dockLabel: 'Narrator',
        glyph: '✦',
        width: 420,
        canOpen: () => elements.narrationPanel.childElementCount > 0,
        blockedTitle: 'Right-click a file or unit and choose Narrate first',
        onBlocked: () => {
          elements.status.textContent = 'Right-click a file or unit and choose Narrate first.';
        },
        onClose: () => {
          elements.narrationPanel.hidden = true;
        },
      },
      {
        key: 'overlay',
        element: elements.overlayPanel,
        title: 'Overlay',
        dockLabel: 'Overlay',
        glyph: '◐',
        pinned: 5,
        width: 360,
        titleFrom: (panel) => (panel.querySelector('h3')?.textContent ?? '').split(' · ')[0].trim(),
        canOpen: () => state.overlay !== 'none',
        blockedTitle: 'Select an overlay (Review dropdown) to open Overlay',
        onBlocked: () => {
          elements.status.textContent = 'Select an overlay first — Overlay has nothing to show.';
        },
        onClose: () => app.lenses.clearOverlay(),
      },
      {
        key: 'edge',
        element: elements.edgePanel,
        title: 'Edge',
        dockLabel: 'Edge',
        glyph: '⟷',
        pinned: 6,
        width: 360,
        titleFrom: (panel) => panel.querySelector('h3')?.textContent?.trim() ?? '',
        canOpen: () => Boolean(app.selectedEdgeId),
        blockedTitle: 'Click an edge in the graph to open Edge',
        onBlocked: () => {
          elements.status.textContent = 'Click an edge in the graph first — no edge selected.';
        },
        onClose: () => app.selection.selectEdge(null),
      },
      {
        key: 'source',
        element: elements.sourcePanel,
        title: 'Source',
        dockLabel: 'Source',
        glyph: '‹›',
        pinned: 3,
        width: 720,
        height: 640,
        canOpen: () => app.source.hasSourceTarget(),
        blockedTitle: 'Select a file to view its source',
        onBlocked: () => {
          elements.status.textContent = 'Select a file first — no source to show.';
        },
        onOpen: () => app.source.sourceRender(),
        onClose: () => app.source.closeSource(),
      },
      {
        key: 'legend',
        element: elements.legend,
        title: 'Legend',
        dockLabel: 'Legend',
        glyph: '≡',
        pinned: 1,
        width: 340,
      },
      {
        key: 'inspector',
        element: elements.inspector,
        title: 'Module passport',
        dockLabel: 'Passport',
        glyph: 'ⓘ',
        pinned: 2,
        width: 384,
        canOpen: () => Boolean(app.selected),
        blockedTitle: 'Select a module in the graph to open Passport',
        onBlocked: () => {
          elements.status.textContent = 'Select a module first — no passport to show.';
        },
        onClose: () => {
          elements.inspector.hidden = true;
        },
      },
      {
        key: 'diagnostics',
        element: elements.diagnostics,
        title: 'Diagnostics',
        dockLabel: 'Diagnostics',
        dock: false, // the header's Diagnostics icon opens it
        width: 420,
        titleFrom: (panel) => panel.querySelector('h3')?.textContent?.trim() ?? '',
        onOpen: () => {
          app.runtime.startRuntimeReadout();
        },
        onClose: () => {
          elements.diagnostics.hidden = true;
          elements.diagnosticsToggle.setAttribute('aria-expanded', 'false');
          app.runtime.stopRuntimeReadout();
        },
      },
      {
        key: 'settings',
        element: elements.settingsPanel,
        title: 'Settings',
        dockLabel: 'Settings',
        dock: false, // the header's Settings icon opens it
        width: 420,
        onOpen: () => {
          if (elements.settingsPanel.hidden) {
            app.settings.openSettings().catch((error) => {
              elements.status.textContent = `Error: ${error.message}`;
            });
          }
          elements.settingsToggle?.setAttribute('aria-expanded', 'true');
        },
        onClose: () => {
          elements.settingsPanel.hidden = true;
          elements.settingsToggle?.setAttribute('aria-expanded', 'false');
        },
      },
      {
        key: 'shortcuts',
        element: elements.shortcuts,
        title: 'Keyboard shortcuts',
        dockLabel: 'Shortcuts',
        dock: false, // ? opens it
        width: 320,
        onOpen: () => renderShortcuts(elements.shortcuts),
        onClose: () => {
          elements.shortcuts.hidden = true;
        },
      },
      {
        key: 'member',
        element: elements.memberView,
        title: 'Member map',
        dockLabel: 'Member map',
        glyph: '▦',
        pinned: 4,
        width: 900,
        height: 700,
        center: true,
        canOpen: () => Boolean(app.memberData),
        blockedTitle: 'Open a member map from a module passport first',
        onBlocked: () => {
          elements.status.textContent = 'Open a member map from a module passport first.';
        },
        onOpen: () => app.memberMap.renderMemberMapView(),
        onClose: () => app.memberMap.closeMemberMap(),
      },
      {
        key: 'workspace',
        element: elements.workspacePanel,
        title: 'Workspace',
        dockLabel: 'Workspace',
        glyph: '⧉',
        width: 460,
        onOpen: () => {
          app.panels.showWorkspace().catch(() => {});
        },
        onClose: () => app.panels.closeWorkspace(),
      },
      {
        key: 'passport',
        element: elements.passportPanel,
        title: 'Repository passport',
        dockLabel: 'Repo',
        glyph: '⌂',
        width: 460,
        onOpen: () => {
          app.panels.showPassport().catch(() => {});
        },
        onClose: () => app.panels.closePassport(),
      },
      {
        key: 'route',
        element: elements.routePanel,
        title: 'Reading route',
        dockLabel: 'Route',
        glyph: '➜',
        width: 440,
        onOpen: () => {
          app.panels.showRoute().catch(() => {});
        },
        onClose: () => app.panels.closeRoute(),
      },
      {
        key: 'blocks',
        element: elements.blocksPanel,
        title: 'Blocks',
        dockLabel: 'Blocks',
        glyph: '▣',
        width: 560,
        height: 620,
        onOpen: () => app.panels.showBlocks(),
        onClose: () => {
          elements.blocksPanel.hidden = true;
        },
      },
    ],
  });

  // The canvas action toolbar floats: drag its grip to move it, its edge to resize, and the
  // placement is remembered. It opens bottom-left, clear of the top chrome, and drags down
  // onto the bottom bar to dock there.
  initFloatingToolbar(elements.graphToolbar, { dock: document.getElementById('bottom-bar') });

  function refreshDock() {
    try {
      app.floatingWindows?.refresh?.();
    } catch {
      // Dock not yet initialized; initial renderDock() covers startup.
    }
  }

  elements.settingsToggle?.addEventListener('click', () => {
    app.floatingWindows.find((controller) => controller.key === 'settings')?.toggle();
  });

  return {
    refreshDock,
    toggleShortcuts,
  };
}
