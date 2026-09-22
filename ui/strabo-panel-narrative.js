/**
 * The narrator affordance and reply rendering, reused by several panels.
 *
 * Split out of strabo-panels.js.
 */

import {
  NARRATOR_ATTRIBUTION,
  narrativeBlocks,
  narratorDisabledReason,
  narratorNeedsSetup,
  narratorReplyLabel,
  narratorStatusLabel,
} from './strabo-narrator.js';

import { button } from './strabo-panel-kit.js';


/**
 * Fill `target` with a narrator reply: prose blocks under the model-generated attribution, or
 * the reason the narrator is unavailable. Built from text nodes and elements only, so the
 * reply is never parsed as HTML.
 */
export function renderNarrativeReply(target, reply) {
  if (reply?.available !== true) {
    target.replaceChildren(narratorReplyLabel(reply));
    return;
  }
  const nodes = [];
  for (const block of narrativeBlocks(reply.text)) {
    const inline = (runs) =>
      runs.map((run) => {
        if (!run.code && !run.strong) {
          return document.createTextNode(run.text);
        }
        const element = document.createElement(run.code ? 'code' : 'strong');
        element.textContent = run.text;
        return element;
      });
    if (block.type === 'p') {
      const paragraph = document.createElement('p');
      paragraph.append(...inline(block.runs));
      nodes.push(paragraph);
    } else {
      const list = document.createElement(block.type);
      for (const item of block.items) {
        const entry = document.createElement('li');
        entry.append(...inline(item));
        list.append(entry);
      }
      nodes.push(list);
    }
  }
  const attribution = document.createElement('p');
  attribution.className = 'narrator-attribution';
  attribution.textContent = NARRATOR_ATTRIBUTION;
  target.replaceChildren(...nodes, attribution);
}


/**
 * The content of the right-click narration window: what is being narrated, then the reply.
 * `state` is `{ label, phase: 'loading' | 'done' | 'error', reply?, message? }`.
 */
export function renderNarrationPanel(container, state, handlers = {}) {
  const heading = document.createElement('h3');
  heading.textContent = `Narrator · ${state.label}`;
  const reply = document.createElement('div');
  reply.className = 'narrator-reply';
  reply.dataset.role = 'narrative';
  if (state.phase === 'loading') {
    reply.textContent = 'Asking the narrator…';
  } else if (state.phase === 'error') {
    reply.textContent = `Narrator unavailable: ${state.message}`;
  } else {
    renderNarrativeReply(reply, state.reply);
  }
  const nodes = [heading, reply];
  if (state.phase === 'done' && state.reply?.available !== true && handlers.onOpenNarratorSettings) {
    const setup = document.createElement('button');
    setup.type = 'button';
    setup.className = 'narrator-setup';
    setup.textContent = 'Open narrator settings →';
    setup.addEventListener('click', () => handlers.onOpenNarratorSettings());
    nodes.push(setup);
  }
  container.replaceChildren(...nodes);
}


/**
 * The opt-in narrator affordance: a status line, a button, and a reply under the
 * model-generated attribution. Shared by the Functions tab, a System-view unit, and the
 * Member map.
 */
export function appendNarratorBlock(container, handlers, { id, label }) {
  if (!handlers.onNarrate) {
    return;
  }
  const block = document.createElement('div');
  block.className = 'narrator-block';

  const note = document.createElement('p');
  note.className = 'narrator-note';
  note.textContent = narratorStatusLabel(handlers.narratorStatus);
  block.append(note);

  // One clear call to action where the narrator is off: the two old lines collapse into a
  // single "Set up →" that opens Settings at the Narrator section.
  if (narratorNeedsSetup(handlers.narratorStatus) && handlers.onOpenNarratorSettings) {
    const setup = document.createElement('button');
    setup.type = 'button';
    setup.className = 'narrator-setup';
    setup.dataset.role = 'narrator-setup';
    setup.textContent = 'Set up →';
    setup.title = 'Open Settings at the Narrator section';
    setup.addEventListener('click', () => handlers.onOpenNarratorSettings());
    block.append(setup);
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.id = id;
  button.className = 'narrator-button';
  button.textContent = label;
  // Disabled with the reason as its tooltip, instead of clickable and failing.
  const disabledReason = narratorDisabledReason(handlers.narratorStatus);
  if (disabledReason) {
    button.disabled = true;
    button.title = disabledReason;
  }
  block.append(button);

  const reply = document.createElement('div');
  reply.className = 'narrator-reply';
  reply.dataset.role = 'narrative';
  block.append(reply);

  button.addEventListener('click', async () => {
    button.disabled = true;
    reply.replaceChildren('Asking the narrator…');
    try {
      renderNarrativeReply(reply, await handlers.onNarrate());
    } catch (error) {
      reply.replaceChildren(`Narrator unavailable: ${error.message}`);
    } finally {
      button.disabled = false;
    }
  });

  container.append(block);
}
