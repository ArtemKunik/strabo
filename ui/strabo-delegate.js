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
 * `items` are `{ label, hint?, action? }`; an item without an action renders
 * as a non-interactive header. The menu closes on any click, scroll, resize,
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
