/**
 * The reading route panel: steps through the server's outward route file by file.
 *
 * The DOM is thin; the shaping and the per-repository progress live in the pure helpers so
 * they can be exercised from Node. Progress is remembered in localStorage per repository, so
 * closing the panel and reopening it resumes where the reader stopped.
 */

import { narratorDisabledReason } from './strabo-narrator.js';
import { appendNarratorBlock, renderNarrativeReply } from './strabo-panel-narrative.js';

/** One localStorage key per repository, so two repositories never share a step. */
export const ROUTE_PROGRESS_PREFIX = 'strabo.route.progress.';

export function routeProgressKey(repository) {
  return `${ROUTE_PROGRESS_PREFIX}${repository ?? 'default'}`;
}

/**
 * Flatten the per-unit routes into one step list, tagging each step with its unit summary.
 *
 * The server already returns a merged `order`; this walks `units` so a step can name the unit
 * it belongs to. It never invents a step: a missing route or empty units yields an empty list.
 */
export function routeSteps(route) {
  const steps = [];
  for (const unit of route?.units ?? []) {
    for (const step of unit.files ?? []) {
      steps.push({ ...step, unitName: unit.summary?.name ?? step.unit });
    }
  }
  return steps;
}

/** The position of a file in the flat route, or -1 when it is not routed. */
export function routeIndexOf(route, file) {
  if (!file) {
    return -1;
  }
  return routeSteps(route).findIndex((step) => step.file === file);
}

/** Clamp an index into `[0, length - 1]`, answering 0 for an empty route. */
export function clampRouteIndex(index, length) {
  if (!Number.isFinite(index) || length <= 0) {
    return 0;
  }
  return Math.min(Math.max(Math.trunc(index), 0), length - 1);
}

/** The one-line evidence for why a step is here. */
export function routeStepLabel(step) {
  if (!step) {
    return 'No file is on the route.';
  }
  const reached = step.from ? `reached from ${step.from}` : 'entry point';
  return `${step.file} · depth ${step.depth} · ${reached} · ${step.fanIn} importer(s) · ${step.tier}`;
}

/** Read the remembered step for a repository, or null when none was recorded. */
export function readRouteProgress(storage, repository) {
  try {
    const raw = storage?.getItem(routeProgressKey(repository));
    if (raw === null || raw === undefined) {
      return null;
    }
    const index = Number.parseInt(raw, 10);
    return Number.isFinite(index) ? index : null;
  } catch {
    return null;
  }
}

/** Remember the step for a repository. Storage is optional; a failure only costs persistence. */
export function writeRouteProgress(storage, repository, index) {
  try {
    storage?.setItem(routeProgressKey(repository), String(index));
  } catch {
    // A blocked or absent localStorage keeps the panel working without persistence.
  }
}

function heading(level, text) {
  const node = document.createElement(level);
  node.textContent = text;
  return node;
}

function note(text, className = 'overlay-note') {
  const node = document.createElement('p');
  node.className = className;
  node.textContent = text;
  return node;
}

/**
 * Draw the route: a step-through control, the current file's evidence, then each unit's
 * summary above its ordered files and the unreached list last.
 *
 * `state.index` is the current step; `handlers.onStep(index)` and `handlers.onFocus(file)`
 * are wired to the controls. A null route is a load failure when `state.error` is set (with a
 * Retry when `handlers.onRetry` is supplied) and an absent route otherwise. The opt-in narrator
 * is offered only when its handlers are given: a per-step control and a whole-route tour whose
 * status, Set up link, and reply come from the shared affordance. Nothing is drawn from thin air.
 */
export function renderRoutePanel(container, route, state = {}, handlers = {}) {
  container.replaceChildren();

  container.append(heading('h3', `Reading route — ${route?.repository ?? 'repository'}`));
  if (!route) {
    // A failed load and an empty route are different facts; only the failure offers a retry.
    if (state.error) {
      container.append(note('The reading route could not be loaded.', 'unavailable'));
      container.append(note(state.error, 'route-error-detail'));
      if (handlers.onRetry) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'route-retry';
        retry.dataset.role = 'route-retry';
        retry.textContent = 'Retry';
        retry.addEventListener('click', () => handlers.onRetry());
        container.append(retry);
      }
    } else {
      container.append(note('No reading route was recorded for this repository.', 'unavailable'));
    }
    return;
  }

  const steps = routeSteps(route);
  const index = clampRouteIndex(state.index ?? 0, steps.length);

  if (route.truncated) {
    container.append(note(route.truncated, 'route-truncated'));
  }

  const controls = document.createElement('div');
  controls.className = 'route-controls';
  controls.dataset.role = 'route-controls';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'route-back';
  back.textContent = 'Previous';
  back.disabled = index <= 0;
  back.addEventListener('click', () => handlers.onStep?.(index - 1));

  const counter = document.createElement('span');
  counter.className = 'route-counter';
  counter.dataset.role = 'route-counter';
  counter.textContent =
    steps.length > 0 ? `Step ${index + 1} of ${steps.length}` : 'No file is on the route.';

  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'route-next';
  next.textContent = 'Next';
  next.disabled = steps.length === 0 || index >= steps.length - 1;
  next.addEventListener('click', () => handlers.onStep?.(index + 1));

  const focus = document.createElement('button');
  focus.type = 'button';
  focus.className = 'route-focus';
  focus.dataset.role = 'route-focus';
  focus.textContent = 'Focus on map';
  focus.disabled = steps.length === 0;
  focus.addEventListener('click', () => {
    const step = steps[index];
    if (step) {
      handlers.onFocus?.(step.file);
    }
  });

  // Per-step narration is a control beside Focus, but its reply renders under the current card.
  const stepNarrate = handlers.onNarrateStep
    ? (() => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'route-narrate-step';
        button.dataset.role = 'route-narrate-step';
        button.textContent = 'Narrate this step';
        const reason = narratorDisabledReason(state.narratorStatus);
        button.disabled = steps.length === 0 || reason !== null;
        button.title = reason ?? 'Ask the opt-in narrator to explain the current file';
        return button;
      })()
    : null;
  const stepReply = stepNarrate ? document.createElement('div') : null;
  if (stepReply) {
    stepReply.className = 'narrator-reply route-step-narrative';
    stepReply.dataset.role = 'route-step-narrative';
    stepNarrate.addEventListener('click', async () => {
      const step = steps[index];
      if (!step) {
        return;
      }
      stepNarrate.disabled = true;
      stepReply.replaceChildren('Asking the narrator…');
      try {
        renderNarrativeReply(stepReply, await handlers.onNarrateStep(step));
      } catch (error) {
        stepReply.replaceChildren(`Narrator unavailable: ${error.message}`);
      } finally {
        stepNarrate.disabled = false;
      }
    });
  }

  controls.append(back, counter, next, focus);
  if (stepNarrate) {
    controls.append(stepNarrate);
  }
  container.append(controls);

  const current = steps[index];
  const currentCard = document.createElement('p');
  currentCard.className = 'route-current';
  currentCard.dataset.role = 'route-current';
  currentCard.textContent = routeStepLabel(current);
  if (current) {
    currentCard.dataset.file = current.file;
  }
  container.append(currentCard);
  if (stepReply) {
    container.append(stepReply);
  }

  const summary = route.summary ?? {};
  container.append(
    note(
      `${summary.entryPoints ?? 0} entry point(s) · ${summary.routed ?? 0} routed · ` +
        `${summary.unreached ?? 0} no entry point reaches · ${summary.units ?? 0} unit(s)`,
      'route-summary',
    ),
  );

  for (const unit of route.units ?? []) {
    const section = document.createElement('section');
    section.className = 'route-unit';
    section.dataset.role = 'route-unit';
    section.dataset.unit = unit.summary?.id ?? '';

    const unitName = unit.summary?.name ?? unit.summary?.id ?? 'unit';
    section.append(
      heading('h4', `${unitName} — ${unit.files.length} file(s)`),
    );
    if (unit.summary?.roleEvidence) {
      section.append(note(unit.summary.roleEvidence, 'route-unit-why'));
    }

    for (const step of unit.files ?? []) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'route-step';
      row.dataset.role = 'route-step';
      row.dataset.file = step.file;
      if (step.file === current?.file) {
        row.classList.add('is-current');
      }
      row.textContent = routeStepLabel(step);
      row.addEventListener('click', () => handlers.onStep?.(routeIndexOf(route, step.file)));
      section.append(row);
    }

    if ((unit.unreached ?? []).length > 0) {
      const unreached = document.createElement('details');
      unreached.className = 'route-unreached';
      unreached.dataset.role = 'route-unreached';
      const count = document.createElement('summary');
      count.textContent = `${unit.unreached.length} file(s) no entry point reaches`;
      unreached.append(count);
      for (const entry of unit.unreached) {
        const row = document.createElement('div');
        row.className = 'route-unreached-file';
        row.dataset.file = entry.file;
        row.textContent = `${entry.file} · ${entry.fanIn} importer(s) · ${entry.tier}`;
        unreached.append(row);
      }
      section.append(unreached);
    }

    container.append(section);
  }

  // The whole-route tour reuses the shared narrator affordance: status, a Set up link when the
  // narrator is off, and the reply inline under the model-generated attribution.
  if (handlers.onNarrateTour) {
    appendNarratorBlock(
      container,
      {
        narratorStatus: state.narratorStatus,
        ...(handlers.onOpenNarratorSettings
          ? { onOpenNarratorSettings: handlers.onOpenNarratorSettings }
          : {}),
        onNarrate: () => handlers.onNarrateTour(),
      },
      { id: 'narrate-tour', label: 'Narrate tour' },
    );
  }
}
