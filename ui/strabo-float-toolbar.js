/**
 * Make the canvas action toolbar a floating, elastic bar.
 *
 * The toolbar keeps its buttons and its `role="toolbar"`; this only adds a drag grip and a
 * resize edge, remembers the position and width per browser, and keeps the bar inside its
 * container. Elastic: dragging the edge changes the width and the icon buttons wrap, so the
 * bar reflows instead of overflowing its row. The overflow menu flips upward when the bar
 * sits in the lower half, so a menu opened from a bottom-anchored bar stays on screen, and it
 * is shifted sideways to stay inside the viewport when the bar floats near an edge.
 *
 * Dragging the bar down onto the bottom bar docks it there: it joins the footer as a normal
 * row item beside the panel dock, the grip drags it back out to float again, and the docked
 * state is remembered. A docked bar is lifted out of the graph screen, so the app hides it
 * with that screen when the Terminal tab is active.
 */

const STORAGE_KEY = 'strabo.float.toolbar.v1';
const MIN_WIDTH = 200;
const GAP = 8;
/** How far above the bottom bar a release still counts as dropping onto it. */
const DOCK_REACH = 28;

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

/**
 * Place an overflow menu so it stays inside the viewport.
 *
 * The menu is anchored to the right edge of its trigger. A floating toolbar dragged near the
 * left of a narrow viewport would push that menu off the left edge, so this shifts it right,
 * keeping `margin` from either side. Returns the menu's left edge in viewport coordinates.
 */
export function clampMenuLeft(anchorRight, menuWidth, viewportWidth, margin = 4) {
  const wanted = anchorRight - menuWidth;
  const maxLeft = Math.max(margin, viewportWidth - margin - menuWidth);
  return Math.min(Math.max(wanted, margin), maxLeft);
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
  // The bar docks into this element (the consolidated bottom bar) when dropped on it.
  const dock = options.dock ?? null;
  const dockReach = options.dockReach ?? DOCK_REACH;
  // Where the bar floats: its original parent (the graph screen). A docked bar is moved out
  // to the footer and returns here when it is dragged back onto the canvas.
  const floatParent = element.parentElement ?? document.body;
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
  const isDocked = () => element.classList.contains('is-docked');

  const applyWidth = () => {
    // A docked bar sizes to its content in the footer; the floating width applies again on
    // undock, so the width the user resized to is not lost.
    if (isDocked()) {
      element.style.width = '';
      return;
    }
    if (width) element.style.width = `${width}px`;
  };

  const containerSize = () => ({
    boundWidth: floatParent.clientWidth || floatParent.getBoundingClientRect().width,
    boundHeight: floatParent.clientHeight || floatParent.getBoundingClientRect().height,
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
    // A docked bar always sits on the bottom edge, so its menu always opens upward.
    if (isDocked()) {
      element.classList.add('opens-up');
      return;
    }
    const rect = element.getBoundingClientRect();
    const parentRect = floatParent.getBoundingClientRect();
    const center = rect.top - parentRect.top + rect.height / 2;
    const { boundHeight } = containerSize();
    element.classList.toggle('opens-up', center > boundHeight / 2);
  };

  function persist() {
    const left = parseFloat(element.style.left);
    const top = parseFloat(element.style.top);
    writeStore(storageKey, {
      docked: isDocked(),
      left: Number.isFinite(left) ? left : null,
      top: Number.isFinite(top) ? top : null,
      width: width ?? null,
    });
  }

  function dockElement() {
    if (!dock || isDocked()) return;
    element.classList.add('is-docked');
    element.style.left = '';
    element.style.top = '';
    element.style.bottom = '';
    element.style.right = '';
    // Sit beside the panel dock, before the status meta, so the legend stays rightmost.
    const meta = dock.querySelector('.bottom-meta');
    if (meta) dock.insertBefore(element, meta);
    else dock.append(element);
    applyWidth();
    updateMenuDirection();
    persist();
  }

  function undockElement() {
    if (!isDocked()) return;
    element.classList.remove('is-docked');
    floatParent.append(element);
    applyWidth();
  }

  if (saved.docked && dock) {
    dockElement();
  } else if (Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
    place(saved.left, saved.top);
  } else {
    updateMenuDirection();
  }
  applyWidth();

  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rect = element.getBoundingClientRect();
    const grabOffsetX = event.clientX - rect.left;
    const grabOffsetY = event.clientY - rect.top;
    let overDock = false;
    grip.setPointerCapture(event.pointerId);

    const dockHit = (clientX, clientY) => {
      if (!dock) return false;
      const bounds = dock.getBoundingClientRect();
      return (
        clientY >= bounds.top - dockReach && clientX >= bounds.left && clientX <= bounds.right
      );
    };

    const move = (moveEvent) => {
      // Pulling up off the dock lifts the bar back into the canvas before it follows the
      // pointer, so the first move after undocking already tracks the cursor.
      if (isDocked()) {
        if (moveEvent.clientY >= dock.getBoundingClientRect().top) return;
        undockElement();
      }
      const parentRect = floatParent.getBoundingClientRect();
      place(
        moveEvent.clientX - parentRect.left - grabOffsetX,
        moveEvent.clientY - parentRect.top - grabOffsetY,
      );
      overDock = dockHit(moveEvent.clientX, moveEvent.clientY);
      dock?.classList.toggle('is-dock-target', overDock);
    };

    const end = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      dock?.classList.remove('is-dock-target');
      if (overDock) dockElement();
      else persist();
    };

    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    event.preventDefault();
    event.stopPropagation();
  });

  resize.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || isDocked()) return;
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
    if (isDocked()) return;
    if (Number.isFinite(parseFloat(element.style.left))) {
      place(parseFloat(element.style.left), parseFloat(element.style.top));
    } else {
      updateMenuDirection();
    }
  });

  return { element, grip, resize, dock, isDocked, undock: undockElement };
}
