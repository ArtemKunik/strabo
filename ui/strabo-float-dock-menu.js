/**
 * The dock's "More" menu: the toggle button, the popup list of chips that do not fit on the
 * rail, and its open/close behaviour (outside click, Escape, and focus return).
 */

export function createDockMoreMenu() {
  let moreOpen = false;
  const moreToggle = document.createElement('button');
  moreToggle.type = 'button';
  moreToggle.className = 'dock-more';
  moreToggle.dataset.glyph = '⋯';
  moreToggle.textContent = 'More';
  moreToggle.title = 'More panels';
  moreToggle.setAttribute('aria-haspopup', 'menu');
  const moreMenu = document.createElement('div');
  moreMenu.className = 'dock-more-menu';
  moreMenu.setAttribute('role', 'menu');
  moreMenu.setAttribute('aria-label', 'More panels');

  const setMoreOpen = (open) => {
    moreOpen = open;
    moreMenu.hidden = !open;
    moreToggle.setAttribute('aria-expanded', String(open));
  };
  moreToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    setMoreOpen(!moreOpen);
    if (moreOpen) moreMenu.querySelector('.dock-chip:not(:disabled)')?.focus();
  });
  moreMenu.addEventListener('click', (event) => {
    if (event.target.closest?.('.dock-chip')) setMoreOpen(false);
  });
  moreMenu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setMoreOpen(false);
      moreToggle.focus();
    }
  });
  document.addEventListener('click', (event) => {
    if (moreOpen && !moreMenu.contains(event.target)) setMoreOpen(false);
  });
  setMoreOpen(false);

  return { moreToggle, moreMenu, setMoreOpen };
}
