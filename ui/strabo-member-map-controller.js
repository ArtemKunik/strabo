/**
 * The Member map window: loading one file's members, health, and consumers, and the
 * find / order / step / play controls that drive its view state in the store.
 */

import { memberMapSteps, passportFor } from './strabo-core.js';
import { renderMemberMap } from './strabo-panels.js';

export function createMemberMapController(app) {
  const { store, state, memberUI, elements } = app;

  let memberTimer = null;

  /** Step the Member map back to the Module Passport it was opened from. */
  function memberMapBack() {
    const file = app.memberData?.file;
    closeMemberMap();
    if (file) {
      app.selection.selectNode(file);
    }
  }

  /** Load the member map, repository health, and consumers, then open the full view. */
  async function openMemberMap(id) {
    const params = new URLSearchParams({ file: id });
    if (state.repository) {
      params.set('repository', state.repository);
    }
    const result = await app.request(`/symbols?${params.toString()}`);
    const healthParams = new URLSearchParams({ file: id });
    if (state.repository) {
      healthParams.set('repository', state.repository);
    }
    let health = await app.request(`/analysis/file-health?${healthParams.toString()}`).catch(() => null);
    if (!health) {
      const healthQuery = state.repository ? `?repository=${encodeURIComponent(state.repository)}` : '';
      health = await app.request(`/analysis/architecture-health${healthQuery}`).catch(() => null);
    }
    const passport = passportFor(app.current, id);
    app.memberData = {
      file: id,
      repository: state.repository,
      memberMap: result.memberMap,
      symbols: result.symbols,
      health,
      metrics: health?.metrics ?? null,
      consumerIds: passport ? passport.usedBy.map((entry) => entry.id) : null,
      importIds: passport ? passport.imports.map((entry) => entry.id) : null,
      functions: result.functions,
    };
    // The member map's narrator affordance needs the status before it renders.
    if (app.narratorStatus === null) {
      app.narratorStatus = await app.narration.fetchNarratorStatus();
    }
    store.set('ui', { memberOpen: true, node: id });
    store.set('member', { stepIndex: 0, find: '' });
    // Open through the window controller, not `memberView.hidden = false` directly: the
    // controller raises the window above the passport and lands focus in it. Setting the
    // `hidden` attribute alone let the window appear behind the passport, silently.
    app.floatingWindows.find((controller) => controller.key === 'member')?.open();
    app.windows.refreshDock();
  }

  function memberStepCount() {
    return memberMapSteps(app.memberData?.memberMap, {
      consumers: app.memberData?.consumerIds ? app.memberData.consumerIds.length : null,
    }).length;
  }

  function renderMemberMapView() {
    if (!app.memberData) {
      return;
    }
    // The view layer reuses the find input, so its focus and caret survive a re-render.
    renderMemberMap(elements.memberView, app.memberData, memberUI, {
      onFind: (value) => store.set('member', { find: value }),
      onOrder: (value) => store.set('member', { order: value }),
      onWiring: (value) => store.set('member', { showWiring: value }),
      onZoom: (value) => store.set('member', { zoom: value }),
      onExplain: () => {
        store.set('member', { explain: !memberUI.explain });
        if (memberUI.explain) {
          revealMemberExplain();
        }
      },
      onNight: () => store.set('member', { dim: !memberUI.dim }),
      onCompare: () => {
        app.git.toggleTimeline().catch((error) => {
          elements.status.textContent = `Error: ${error.message}`;
        });
      },
      onOnlyFlow: () => store.set('member', { onlyFlow: !memberUI.onlyFlow }),
      onReset: () =>
        store.set('member', {
          order: 'source',
          find: '',
          showWiring: true,
          zoom: 'medium',
          dataFlow: true,
          onlyFlow: false,
          explain: false,
          stepIndex: 0,
          dim: false,
        }),
      onDataFlow: (value) => store.set('member', { dataFlow: value }),
      // The member map may ask the opt-in narrator to explain the recorded members and data flow.
      narratorStatus: app.narratorStatus,
      onNarrate: () => app.narration.narrateMemberMap(),
      onOpenNarratorSettings: app.settings.openNarratorSettings,
      onStep: (delta) => {
        stopMemberPlay();
        store.set('member', {
          stepIndex: Math.min(memberStepCount() - 1, Math.max(0, memberUI.stepIndex + delta)),
        });
      },
      onPlay: () => toggleMemberPlay(),
      onBack: () => memberMapBack(),
      onClose: () => closeMemberMap(),
    });
  }

  /**
   * Bring the explanation into view when it is switched on.
   *
   * The summary sits above the member list, so a panel scrolled down to the methods would insert
   * it off-screen and the toggle would look like it did nothing. It is scrolled to just below the
   * sticky toolbar, which the panel scrolls under.
   */
  function revealMemberExplain() {
    const container = elements.memberView;
    const explain = container.querySelector('[data-role="explain"]');
    if (!explain) {
      return;
    }
    const toolbar = container.querySelector('.member-toolbar');
    const containerTop = container.getBoundingClientRect().top;
    const offset = (toolbar?.offsetHeight ?? 0) + 8;
    const top = explain.getBoundingClientRect().top;
    if (top < containerTop + offset) {
      container.scrollTop = Math.max(0, container.scrollTop + (top - containerTop - offset));
    }
  }

  function stopMemberPlay() {
    if (memberTimer) {
      clearInterval(memberTimer);
      memberTimer = null;
    }
    elements.memberView.classList.remove('is-playing');
  }

  function toggleMemberPlay() {
    if (memberTimer) {
      stopMemberPlay();
      return;
    }
    elements.memberView.classList.add('is-playing');
    memberTimer = setInterval(() => {
      if (memberUI.stepIndex >= memberStepCount() - 1) {
        store.set('member', { stepIndex: 0 });
        stopMemberPlay();
        return;
      }
      store.set('member', { stepIndex: memberUI.stepIndex + 1 });
    }, 1400);
  }

  function closeMemberMap() {
    stopMemberPlay();
    elements.memberView.hidden = true;
    memberUI.dim = false;
    store.set('ui', { memberOpen: false });
    app.windows.refreshDock();
  }

  return {
    closeMemberMap,
    memberStepCount,
    openMemberMap,
    renderMemberMapView,
  };
}
