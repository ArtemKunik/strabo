/**
 * Edge fades for the dock rail. The rail is nowrap and its native scrollbar is hidden, so
 * without a fade the clipped chips just look cut off.
 */

export function createDockOverflow(dock) {
  const sync = () => {
    if (!dock) return;
    const max = dock.scrollHeight - dock.clientHeight;
    dock.classList.toggle('is-overflow-top', dock.scrollTop > 1);
    dock.classList.toggle('is-overflow-bottom', max > 1 && dock.scrollTop < max - 1);
  };

  // The rail scrolls vertically on a short window; observe size changes so the fades
  // appear the moment the window is shortened.
  dock?.addEventListener('scroll', sync, { passive: true });
  if (dock && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(sync).observe(dock);
  }

  return sync;
}
