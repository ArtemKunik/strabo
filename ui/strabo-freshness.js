/**
 * The freshness badge: the revision the map was indexed at, and a rebuild action when
 * HEAD has moved past it. It reads `/status` and never invents a revision.
 */
export function createFreshnessBadge(element, options = {}) {
  if (!element) {
    return { refresh: async () => null, render: () => {}, status: () => null };
  }
  const request = options.request;
  let last = null;

  function short(revision) {
    return revision ? revision.slice(0, 7) : 'unknown';
  }

  function render(status) {
    last = status;
    const revision = status?.indexed?.revision;
    if (!revision) {
      element.hidden = true;
      element.textContent = '';
      return;
    }
    const behind = typeof status.behind === 'number' ? status.behind : null;
    const stale = Boolean(status.stale);
    element.hidden = false;
    element.classList.toggle('is-stale', stale);
    element.textContent = stale
      ? `indexed at ${short(revision)}${behind ? ` (${behind} behind)` : ''} · Rebuild`
      : `indexed at ${short(revision)}`;
    element.title = stale
      ? 'HEAD moved since this map was indexed; click to rebuild.'
      : 'The map matches the indexed revision.';
  }

  async function refresh({ repository } = {}) {
    if (typeof request !== 'function') {
      return null;
    }
    try {
      const query = repository ? `?repository=${encodeURIComponent(repository)}` : '';
      render(await request(`/status${query}`));
    } catch {
      element.hidden = true;
    }
    return last;
  }

  element.addEventListener('click', async () => {
    if (!element.classList.contains('is-stale')) {
      return;
    }
    element.disabled = true;
    element.textContent = 'Rebuilding…';
    try {
      await options.onRebuild?.();
      await refresh({ repository: options.repository?.() });
    } finally {
      element.disabled = false;
    }
  });

  return { refresh, render, status: () => last };
}
