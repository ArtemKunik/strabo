/**
 * Pointer gestures for one floating window: dragging by the header, resizing by the
 * bottom-right handle, and double-clicking the header to collapse.
 *
 * All state stays in the caller; this module only wires listeners and reports what
 * happened through the callbacks it is given.
 */

import { clamp, sanitizeSize, MIN_WIDTH, MIN_HEIGHT, GAP } from './strabo-float-geometry.js';

export function wireWindowGestures({
  win,
  header,
  resizeHandle,
  place,
  raise,
  persist,
  onResized,
  isCollapsed,
  setCollapsed,
}) {
  header.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button') || event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = parseFloat(win.style.left) || 0;
    const startTop = parseFloat(win.style.top) || 0;
    header.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      place(
        startLeft + (moveEvent.clientX - startX),
        startTop + (moveEvent.clientY - startY),
      );
    };
    const end = () => {
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', end);
      header.removeEventListener('pointercancel', end);
      persist();
    };
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', end);
    header.addEventListener('pointercancel', end);
    raise();
    event.preventDefault();
  });

  resizeHandle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const rect = win.getBoundingClientRect();
    const startWidth = rect.width;
    const startHeight = rect.height;
    const left = parseFloat(win.style.left) || 0;
    const top = parseFloat(win.style.top) || 0;
    const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - left - GAP);
    const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - top - GAP);
    resizeHandle.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      win.style.width = `${clamp(startWidth + (moveEvent.clientX - startX), MIN_WIDTH, maxWidth)}px`;
      win.style.height = `${clamp(startHeight + (moveEvent.clientY - startY), MIN_HEIGHT, maxHeight)}px`;
    };
    const end = () => {
      resizeHandle.removeEventListener('pointermove', move);
      resizeHandle.removeEventListener('pointerup', end);
      resizeHandle.removeEventListener('pointercancel', end);
      // A click without a drag leaves no inline height; keep what was remembered.
      onResized(sanitizeSize({
        width: parseFloat(win.style.width),
        height: parseFloat(win.style.height),
      }));
      persist();
    };
    resizeHandle.addEventListener('pointermove', move);
    resizeHandle.addEventListener('pointerup', end);
    resizeHandle.addEventListener('pointercancel', end);
    raise();
    event.preventDefault();
    event.stopPropagation();
  });

  header.addEventListener('dblclick', (event) => {
    if (event.target.closest('button')) return;
    setCollapsed(!isCollapsed());
  });
}
