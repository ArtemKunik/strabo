/**
 * The opt-in narrator, as the map uses it: the status every narration affordance renders
 * from, and the requests that send recorded evidence for a unit, file, member map, review,
 * or reading-route step. Replies are narrative only; they never change the recorded view.
 */

import { API_PATH, passportFor } from './strabo-core.js';
import {
  buildGroupNamingEvidence,
  buildMemberNarratorEvidence,
  buildNarratorEvidence,
  buildReviewNarrationEvidence,
  buildRouteStepEvidence,
  GROUP_NAMING_INSTRUCTION,
  MEMBER_NARRATION_INSTRUCTION,
  narratorMenuState,
  REVIEW_NARRATION_INSTRUCTION,
  ROUTE_STEP_INSTRUCTION,
} from './strabo-narrator.js';
import { renderNarrationPanel } from './strabo-panels.js';

export function createNarrationController(app) {
  const { state, elements } = app;

  /** Handlers that let the Functions tab ask the opt-in narrator about the recorded evidence. */
  function functionsHandlers(result) {
    return {
      narratorStatus: app.narratorStatus,
      onNarrate: () => narrateFile(result),
      onOpenNarratorSettings: app.openNarratorSettings,
    };
  }

  /** Read the narrator status once; failures degrade to the unconfigured caption, not an error. */
  async function fetchNarratorStatus() {
    try {
      const response = await fetch(`${API_PATH}/narrator`);
      if (!response.ok) {
        return { configured: false, reason: 'not-configured' };
      }
      const body = await response.json();
      if (Array.isArray(body?.presets) && body.presets.length > 0) {
        app.narratorPresets = body.presets;
      }
      return body;
    } catch {
      return { configured: false, reason: 'not-configured' };
    }
  }

  /** Resolve the narrator status once, so a panel can render its narration controls honestly. */
  async function ensureNarratorStatus() {
    if (app.narratorStatus === null) {
      app.narratorStatus = await fetchNarratorStatus();
    }
    return app.narratorStatus;
  }

  /**
   * Ask the narrator to propose a name and purpose for one System-view unit.
   *
   * Only the unit's recorded facts are sent; the reply is narrative and never creates, merges,
   * or splits a group.
   */
  async function narrateGroup(id) {
    if (app.narratorStatus === null) {
      app.narratorStatus = await fetchNarratorStatus();
    }
    return postNarration(
      GROUP_NAMING_INSTRUCTION,
      buildGroupNamingEvidence(app.current, id),
    );
  }

  /**
   * Ask the narrator about one file's recorded evidence.
   *
   * Only recorded evidence is sent; the endpoint decides whether it is enabled. The reply is
   * narrative text, rendered apart from the recorded facts and never applied to the source.
   */
  async function narrateFile(result) {
    return postNarration(
      'Summarise the recorded complexity, signals, and call wiring in this file.',
      buildNarratorEvidence(result),
    );
  }

  /**
   * Ask the narrator to explain one file's recorded members and data flow.
   *
   * Only the recorded member map is sent; the reply is narrative, rendered under the
   * model-generated attribution, and never changes the recorded view.
   */
  async function narrateMemberMap() {
    return postNarration(
      MEMBER_NARRATION_INSTRUCTION,
      fileNarrationEvidence(app.memberData?.file, app.memberData, app.memberData?.importIds, app.memberData?.consumerIds),
    );
  }

  /**
   * Ask the narrator to explain one Git review's recorded change set.
   *
   * Only the recorded review is sent; the reply is narrative, rendered under the
   * model-generated attribution, and never changes the recorded view.
   */
  async function narrateReview(result) {
    return postNarration(REVIEW_NARRATION_INSTRUCTION, buildReviewNarrationEvidence(result));
  }

  /**
   * The recorded evidence for narrating one file: its members, wiring, functions, and import
   * neighbours when it declares members, else its function inventory. `source` is anything with
   * `memberMap` and `functions`, such as a `/symbols` result or the open member map's data.
   */
  function fileNarrationEvidence(file, source, imports, usedBy) {
    if (source?.memberMap?.types?.length > 0) {
      return buildMemberNarratorEvidence(source.memberMap, {
        file,
        imports: imports ?? undefined,
        usedBy: usedBy ?? undefined,
        functions: source.functions,
      });
    }
    return buildNarratorEvidence({ functions: source?.functions });
  }

  /** True when a graph node is something the narrator can describe: a file or a System unit. */
  function isNarratable(id) {
    if (!id || !app.current || state.mode === 'block' || id.endsWith('#support')) {
      return false;
    }
    return app.current.nodes.some((candidate) => candidate.id === id);
  }

  /**
   * Narrate one graph node from its right-click menu and show the reply in the Narrator window.
   *
   * A System unit is named from its recorded facts; a file is narrated from its recorded members,
   * functions, and import neighbours. The reply is model-generated and the window says so.
   */
  async function narrateNode(id) {
    const label = app.current?.nodes.find((candidate) => candidate.id === id)?.label ?? id;
    const showPanel = (panelState) => {
      renderNarrationPanel(elements.narrationPanel, panelState, { onOpenNarratorSettings: app.openNarratorSettings });
    };
    showPanel({ label, phase: 'loading' });
    app.floatingWindows.find((controller) => controller.key === 'narration')?.open();
    try {
      let reply;
      if (app.current?.system && !app.current?.systemUnit) {
        reply = await narrateGroup(id);
      } else {
        const params = new URLSearchParams({ file: id });
        if (state.repository) {
          params.set('repository', state.repository);
        }
        const result = await app.request(`/symbols?${params.toString()}`);
        const passport = passportFor(app.current, id);
        reply = await postNarration(
          MEMBER_NARRATION_INSTRUCTION,
          fileNarrationEvidence(
            id,
            result,
            passport?.imports.map((entry) => entry.id),
            passport?.usedBy.map((entry) => entry.id),
          ),
        );
      }
      showPanel({ label, phase: 'done', reply });
    } catch (error) {
      showPanel({ label, phase: 'error', message: error.message });
    }
  }

  /**
   * Ask the opt-in narrator for the guided tour: passport plus reading route become the evidence.
   *
   * The reply returns to the route panel's narrator block, which renders it inline under the
   * model-generated attribution; the tour never changes the route or the map. A failed request
   * throws so the shared affordance reports the reason.
   */
  async function narrateRouteTour() {
    const params = state.repository ? `?repository=${encodeURIComponent(state.repository)}` : '';
    const response = await fetch(`${API_PATH}/narrator/tour${params}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(state.repository ? { repository: state.repository } : {}),
    });
    const reply = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(reply.error ?? `Narrator request failed (${response.status}).`);
    }
    return reply;
  }

  /**
   * Ask the opt-in narrator to explain one file's place in the reading route.
   *
   * Only the recorded step and the route summary are sent; the reply renders inline in the route
   * panel and never reorders the route.
   */
  async function narrateRouteStep(step) {
    return postNarration(
      ROUTE_STEP_INSTRUCTION,
      buildRouteStepEvidence(step, app.currentRouteSummary()),
    );
  }

  /** POST recorded evidence to the narrator and return its reply. */
  async function postNarration(instruction, evidence) {
    const response = await fetch(`${API_PATH}/narrator`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction, evidence }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error ?? `Narrator request failed (${response.status}).`);
    }
    return body;
  }

  /**
   * The Narrate entry for a right-clicked node, listed first with a separator, or nothing for a
   * target the narrator cannot describe. While the narrator is off or failing the entry stays in
   * the menu but inactive, with the reason as its tooltip, like the Narrate buttons.
   */
  function narrateMenuItems(target) {
    if (target?.kind !== 'node') {
      return [];
    }
    const menuState = isNarratable(target.id)
      ? narratorMenuState(app.narratorStatus)
      : { enabled: false, hint: 'Narrate works on a file or a System unit — open the folder to reach its files.' };
    return [
      {
        label: '✦ Narrate',
        hint: menuState.enabled ? 'model-generated' : 'unavailable',
        ...(menuState.enabled
          ? { action: () => narrateNode(target.id) }
          : { title: menuState.hint }),
      },
      { separator: true },
    ];
  }

  return {
    ensureNarratorStatus,
    fetchNarratorStatus,
    functionsHandlers,
    narrateGroup,
    narrateMemberMap,
    narrateMenuItems,
    narrateReview,
    narrateRouteStep,
    narrateRouteTour,
  };
}
