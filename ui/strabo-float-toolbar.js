/**
 * Make the canvas action toolbar a floating, elastic bar.
 *
 * The toolbar keeps its buttons and its `role="toolbar"`; this only adds a drag grip and a
 * resize edge, remembers the position and width per browser, and keeps the bar inside its
 * container. Elastic: dragging the edge changes the width and the icon buttons wrap, so the
 * bar reflows instead of overflowing its row. The overflow menu flips upward when the bar
 * sits in the lower half, so a menu opened from a bottom-anchored bar stays on screen.
 */

const STORAGE_KEY = 'strabo.float.toolbar.v1';
const MIN_WIDTH = 200;
const GAP = 8;

/**
 * Clamp a toolbar's top-left so it stays fully inside its container.
 *
 * Pure, so the placement rule is unit-tested without a browser. A bar wider or taller than
 * the container pins to the origin rather than producing a negative bound.
 */
export function clampToolbarPosition(left, top, { width, height, boundWidth, boundHeight }) {
  const maxLeft = Math.max(0, boundWidth - Math.min(width, boundWidth));
  const maxTop = Math.max(0, boundHeight - Math.min(height, boundHeight));
  return {
    left: Math.min(Math.max(left, 0), maxLeft),
    top: Math.min(Math.max(top, 0), maxTop),
  };
}

function readStore(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is optional; a blocked/absent localStorage only costs persistence.
  }
}

export function initFloatingToolbar(element, options = {}) {
  if (!element) return null;
  const storageKey = options.storageKey ?? STORAGE_KEY;
  const minWidth = options.minWidth ?? MIN_WIDTH;
  const container = element.offsetParent ?? element.parentElement ?? document.body;
  const saved = readStore(storageKey);

  const grip = document.createElement('span');
  grip.className = 'tb-grip';
  grip.setAttribute('aria-hidden', 'true');
  grip.title = 'Drag to move the toolbar';
  grip.textContent = '⠿';
  element.prepend(grip);

  const resize = document.createElement('span');
  resize.className = 'tb-resize';
  resize.setAttribute('aria-hidden', 'true');
  resize.title = 'Drag to resize';
  element.append(resize);

  let width = Number.isFinite(saved.width) && saved.width >= minWidth ? saved.width : null;
  const applyWidth = () => {
    if (width) element.style.width = `${width}px`;
  };

  const containerSize = () => ({
    boundWidth: container.clientWidth || container.getBoundingClientRect().width,
    boundHeight: container.clientHeight || container.getBoundingClientRect().height,
  });

  const place = (left, top) => {
    const rect = element.getBoundingClientRect();
    const { boundWidth, boundHeight } = containerSize();
    const clamped = clampToolbarPosition(left, top, {
      width: element.offsetWidth || rect.width,
      height: element.offsetHeight || rect.height,
      boundWidth,
      boundHeight,
    });
    element.style.left = `${clamped.left}px`;
    element.style.top = `${clamped.top}px`;
    // A placed bar uses left/top; clearing bottom/right keeps the two from fighting.
    element.style.bottom = 'auto';
    element.style.right = 'auto';
    updateMenuDirection();
  };

  /** Open the overflow menu upward when the bar is in the lower half of its container. */
  const updateMenuDirection = () => {
    const rect = element.getBoundingClientRect();
    const containerTop = container.getBoundingClientRect().top;
    const center = rect.top - containerTop + rect.height / 2;
    const { boundHeight } = containerSize();
    element.classList.toggle('opens-up', center > boundHeight / 2);
  };

  if (Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
    place(saved.left, saved.top);
  } else {
    updateMenuDirection();
  }
  applyWidth();

  const persist = () => {
    writeStore(storageKey, {
      left: parseFloat(element.style.left),
      top: parseFloat(element.style.top),
      width: parseFloat(element.style.width) || null,
    });
  };

  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rect = element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const startLeft = rect.left - containerRect.left;
    const startTop = rect.top - containerRect.top;
    const startX = event.clientX;
    const startY = event.clientY;
    grip.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      place(startLeft + (moveEvent.clientX - startX), startTop + (moveEvent.clientY - startY));
    };
    const end = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      persist();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    event.preventDefault();
    event.stopPropagation();
  });

  resize.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startWidth = element.getBoundingClientRect().width;
    const { boundWidth } = containerSize();
    const left = parseFloat(element.style.left);
    const maxWidth = Math.max(minWidth, boundWidth - (Number.isFinite(left) ? left : 0) - GAP);
    resize.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      width = Math.min(Math.max(startWidth + (moveEvent.clientX - startX), minWidth), maxWidth);
      applyWidth();
    };
    const end = () => {
      resize.removeEventListener('pointermove', move);
      resize.removeEventListener('pointerup', end);
      resize.removeEventListener('pointercancel', end);
      persist();
    };
    resize.addEventListener('pointermove', move);
    resize.addEventListener('pointerup', end);
    resize.addEventListener('pointercancel', end);
    event.preventDefault();
    event.stopPropagation();
  });

  window.addEventListener('resize', () => {
    if (Number.isFinite(parseFloat(element.style.left))) {
      place(parseFloat(element.style.left), parseFloat(element.style.top));
    } else {
      updateMenuDirection();
    }
  });

  return { element, grip, resize };
}
