/**
 * Builds and mounts the chrome for one floating window: the section, its draggable header
 * (grip, title, collapse and close buttons), the body the panel element moves into, and the
 * resize handle.
 *
 * DOM construction only; placement, gestures, and controller behaviour live in their own
 * modules.
 */

import { DEFAULT_WIDTH } from './strabo-float-geometry.js';

export function buildWindowChrome({ config, width = config.width ?? DEFAULT_WIDTH, height = null }) {
  const element = config.element;

  const win = document.createElement('section');
  win.className = 'float-window';
  win.dataset.panel = config.key;
  win.hidden = true;
  win.style.width = `${width}px`;
  if (height) {
    win.style.height = `${height}px`;
  }

  const header = document.createElement('header');
  header.className = 'float-header';
  header.tabIndex = 0;
  header.title = 'Drag to move · double-click to collapse';

  const grip = document.createElement('span');
  grip.className = 'float-grip';
  grip.setAttribute('aria-hidden', 'true');
  grip.textContent = '⠿';

  const title = document.createElement('span');
  title.className = 'float-title';
  title.textContent = config.title ?? config.key;

  // A floating panel is a non-modal dialog: it can be focused, it names itself, and
  // Escape closes it. `tabIndex = -1` lets the window take focus on open without joining
  // the tab order (the dock chip remains the tab stop).
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-label', title.textContent);
  win.tabIndex = -1;

  const spacer = document.createElement('span');
  spacer.className = 'float-spacer';

  const collapseButton = document.createElement('button');
  collapseButton.type = 'button';
  collapseButton.className = 'float-button float-collapse';

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'float-button float-close';
  closeButton.setAttribute('aria-label', 'Close panel');
  closeButton.title = 'Close';
  closeButton.textContent = '×';

  const body = document.createElement('div');
  body.className = 'float-body';

  const resizeHandle = document.createElement('span');
  resizeHandle.className = 'float-resize';
  resizeHandle.setAttribute('aria-hidden', 'true');
  resizeHandle.title = 'Drag to resize';

  header.append(grip, title, spacer, collapseButton, closeButton);
  win.append(header, body, resizeHandle);

  element.parentNode.insertBefore(win, element);
  body.append(element);

  return { win, header, title, collapseButton, closeButton, resizeHandle };
}
