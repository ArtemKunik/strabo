/**
 * Agent delegation UI for Strabo.
 *
 * Framework-free helpers: a custom right-click menu, toast notifications, and
 * the POST /api/strabo/delegate call that opens a real terminal window running
 * opencode or claude on the server. No DOM is touched at import time; the menu
 * and toast containers are created lazily so this module stays inert until used.
 */

import { API_PATH } from './strabo-core.js';

let menuElement = null;
let toastStack = null;
let promptDialog = null;
let promptDialogResolve = null;

const AGENT_LABELS = { opencode: 'OpenCode', claude: 'Claude' };

function ensureMenu() {
  if (!menuElement) {
    menuElement = document.createElement('div');
    menuElement.id = 'agent-menu';
    menuElement.className = 'agent-menu';
    menuElement.setAttribute('role', 'menu');
    menuElement.hidden = true;
    document.body.append(menuElement);
  }
  return menuElement;
}

function ensureToasts() {
  if (!toastStack) {
    toastStack = document.createElement('div');
    toastStack.id = 'toast-stack';
    toastStack.className = 'toast-stack';
    toastStack.setAttribute('aria-live', 'polite');
    document.body.append(toastStack);
  }
  return toastStack;
}

/** Close the context menu. Safe to call when none is open. */
export function closeContextMenu() {
  if (menuElement) {
    menuElement.hidden = true;
    menuElement.replaceChildren();
  }
}

/**
 * Show a custom context menu at viewport coordinates.
 * `items` are `{ label, hint?, title?, action? }`; an item without an action renders
 * as an inactive entry, with `title` as the tooltip saying why. The menu closes on any click, scroll, resize,
 * or Escape. Returns a cleanup function.
 */
export function showContextMenu({ x, y, title, items }) {
  const menu = ensureMenu();
  menu.replaceChildren();

  if (title) {
    const header = document.createElement('div');
    header.className = 'agent-menu-title';
    header.textContent = title;
    menu.append(header);
  }

  for (const item of items ?? []) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'agent-menu-sep';
      sep.setAttribute('aria-hidden', 'true');
      menu.append(sep);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'agent-menu-item';
    button.setAttribute('role', 'menuitem');
    if (item.title) {
      button.title = item.title;
    }
    const label = document.createElement('span');
    label.textContent = item.label;
    button.append(label);
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'agent-menu-hint';
      hint.textContent = item.hint;
      button.append(hint);
    }
    if (typeof item.action === 'function') {
      button.addEventListener('click', () => {
        closeContextMenu();
        item.action();
      });
    } else {
      button.disabled = true;
    }
    menu.append(button);
  }

  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;

  const first = menu.querySelector('.agent-menu-item:not(:disabled)');
  first?.focus();

  const onPointerDown = (event) => {
    if (!menu.contains(event.target)) {
      cleanup();
    }
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      cleanup();
    }
  };
  const onScroll = () => cleanup();
  function cleanup() {
    closeContextMenu();
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('resize', onScroll);
    document.removeEventListener('scroll', onScroll, true);
  }
  // Defer so the right-click pointerdown that opened the menu cannot close it.
  setTimeout(() => {
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onScroll);
    document.addEventListener('scroll', onScroll, true);
  }, 0);
  return cleanup;
}

/**
 * Show a transient toast. `action` is an optional `{ label, onClick }` button,
 * e.g. "Copy prompt" when a terminal launch fails.
 */
export function showToast(message, action = null, { timeout = 6000 } = {}) {
  const stack = ensureToasts();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = message;
  toast.append(text);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      action.onClick?.();
      toast.remove();
    });
    toast.append(button);
  }
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'toast-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss notification');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => toast.remove());
  toast.append(dismiss);
  stack.append(toast);
  setTimeout(() => toast.remove(), timeout);
  return toast;
}

/** Copy text to the clipboard, with a textarea fallback for older contexts. */
export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

/** Resolve the open review dialog, if any, with `value` and forget it. */
function settlePromptReview(value) {
  const resolve = promptDialogResolve;
  promptDialogResolve = null;
  resolve?.(value);
}

/** Build the review dialog once, wiring its static chrome to the current session's fields. */
function ensurePromptDialog() {
  if (promptDialog) {
    return promptDialog;
  }
  const dialog = document.createElement('dialog');
  dialog.id = 'prompt-dialog';
  dialog.className = 'dialog prompt-dialog';
  dialog.setAttribute('aria-label', 'Review the task before sending it to an agent');

  const header = document.createElement('header');
  header.className = 'dialog-header';
  const heading = document.createElement('strong');
  heading.className = 'prompt-dialog-title';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'dialog-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.addEventListener('click', () => dialog.close());
  header.append(heading, close);

  const target = document.createElement('p');
  target.className = 'dialog-path prompt-dialog-target';

  const text = document.createElement('textarea');
  text.className = 'prompt-dialog-text';
  text.spellcheck = false;
  text.setAttribute('aria-label', 'Task prompt');

  const footer = document.createElement('footer');
  footer.className = 'dialog-footer';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    await copyText(text.value);
    copy.textContent = 'Copied';
    setTimeout(() => {
      copy.textContent = 'Copy';
    }, 1500);
  });
  const actions = document.createElement('span');
  actions.className = 'dialog-footer-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => dialog.close());
  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'primary prompt-dialog-send';
  send.addEventListener('click', () => {
    const reviewed = text.value;
    settlePromptReview(reviewed);
    dialog.close();
  });
  actions.append(cancel, send);
  footer.append(copy, actions);

  dialog.append(header, target, text, footer);
  dialog.addEventListener('close', () => settlePromptReview(null));
  document.body.append(dialog);
  promptDialog = dialog;
  return dialog;
}

/**
 * Show the built prompt in a modal so the operator can read and edit it before it
 * is handed to an agent. Resolves with the reviewed prompt when confirmed, or null
 * when dismissed (Cancel, Escape, or the backdrop is not used here). `agent` names
 * the confirm button so it is obvious which tool will open.
 */
export function showPromptReview({ agent, title, prompt }) {
  const dialog = ensurePromptDialog();
  settlePromptReview(null);
  const agentName = AGENT_LABELS[agent] ?? agent;
  dialog.querySelector('.prompt-dialog-title').textContent = `Review task for ${agentName}`;
  dialog.querySelector('.prompt-dialog-target').textContent = title;
  const text = dialog.querySelector('.prompt-dialog-text');
  text.value = prompt;
  dialog.querySelector('.prompt-dialog-send').textContent = `Open ${agentName}`;
  const pending = new Promise((resolve) => {
    promptDialogResolve = resolve;
  });
  if (!dialog.open) {
    dialog.showModal();
  }
  text.focus();
  text.setSelectionRange(text.value.length, text.value.length);
  return pending;
}

/**
 * Ask the server to open a new terminal running `agent` on the delegated item.
 * Throws with the server's error message so callers can offer a copy fallback.
 */
export async function launchAgent(agent, { repository, target, prompt, title }) {
  const response = await fetch(`${API_PATH}/delegate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent, repository, target, prompt, title }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error ?? `Delegate failed (${response.status})`);
  }
  return body;
}
