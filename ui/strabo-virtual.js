/**
 * Virtual scrolling for long panel lists.
 *
 * A panel that lists every module of a large repository used to either cap the list or page
 * it, so a row far from the top cost nothing only because it was not there at all. Here the
 * list keeps its full height in a spacer but only the rows near the scroll position exist as
 * DOM, so thousands of items cost a viewport's worth of nodes and scroll normally.
 *
 * `virtualRange` is the pure kernel (no DOM) and carries the interesting logic; the tests
 * exercise it directly. `createVirtualList` is the thin DOM shell around it.
 */

/**
 * The half-open range `[start, end)` of row indexes to render.
 *
 * `viewportHeight` may be zero (a hidden or not-yet-laid-out panel); the result still covers
 * `overscan` rows so a first paint shows something and a scroll can correct it.
 */
export function virtualRange(scrollTop, viewportHeight, rowHeight, count, overscan = 4) {
  if (!Number.isFinite(rowHeight) || rowHeight <= 0 || !Number.isFinite(count) || count <= 0) {
    return { start: 0, end: 0 };
  }
  const height = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const visible = Math.ceil(height / rowHeight);
  const first = Math.floor(top / rowHeight);
  // Clamp to the last full page so an over-scroll (rubber-banding, a stale height) still
  // renders real rows instead of an empty window past the end of the list.
  const maxStart = Math.max(0, count - visible);
  const start = Math.max(0, Math.min(first - overscan, maxStart));
  const end = Math.min(count, first + visible + overscan);
  return { start, end };
}

/**
 * A scroll container that renders only the visible slice of its items.
 *
 * `renderRow(item, index)` builds one row's element; the caller owns the markup. `setItems`
 * replaces the data and adjusts the spacer to the full height, so the scrollbar reflects
 * every item even though only a window of them is in the DOM.
 */
export function createVirtualList({
  rowHeight,
  overscan = 4,
  className = 'virtual-list',
  renderRow,
  viewportHeight = null,
}) {
  const viewport = document.createElement('div');
  viewport.className = className;
  viewport.setAttribute('role', 'list');

  const spacer = document.createElement('div');
  spacer.className = `${className}-spacer`;
  spacer.style.position = 'relative';

  const windowLayer = document.createElement('div');
  windowLayer.className = `${className}-window`;
  windowLayer.style.position = 'absolute';
  windowLayer.style.top = '0';
  windowLayer.style.left = '0';
  windowLayer.style.right = '0';

  spacer.append(windowLayer);
  viewport.append(spacer);

  let items = [];
  let painted = { start: -1, end: -1 };

  const height = () =>
    Number.isFinite(viewportHeight) ? viewportHeight : viewport.clientHeight || 0;

  const draw = () => {
    const { start, end } = virtualRange(viewport.scrollTop, height(), rowHeight, items.length, overscan);
    if (start === painted.start && end === painted.end) {
      return;
    }
    painted = { start, end };
    windowLayer.style.transform = `translateY(${start * rowHeight}px)`;
    windowLayer.replaceChildren();
    for (let index = start; index < end; index += 1) {
      windowLayer.append(renderRow(items[index], index));
    }
  };

  viewport.addEventListener('scroll', draw);

  // A panel is often rendered while its window is still `display: none`, so `clientHeight`
  // reads 0 and the first paint falls back to the overscan rows. Watching the viewport for a
  // size change redraws the window the moment the panel is revealed or resized.
  const observer =
    typeof ResizeObserver === 'function' ? new ResizeObserver(() => draw()) : null;
  observer?.observe(viewport);

  return {
    element: viewport,
    setItems(next) {
      items = Array.isArray(next) ? next : [];
      spacer.style.height = `${items.length * rowHeight}px`;
      painted = { start: -1, end: -1 };
      draw();
    },
    /** Recompute the window after the container's height changes (open, resize, reveal). */
    refresh: draw,
    dispose() {
      observer?.disconnect();
    },
    get items() {
      return items;
    },
  };
}
