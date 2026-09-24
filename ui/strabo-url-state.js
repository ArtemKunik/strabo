/**
 * Deep links: the repository, detail mode, System unit, selected node, and open member map
 * mirrored into the page URL.
 */

export function createUrlState(app) {
  const { store, state, elements } = app;

  /**
   * Keep the selected repository, detail mode, selected node, and open member map in the URL,
   * so a view can be shared and a reload restores it. The URL mirrors the store; the store is
   * still the source of truth. Writes are synchronous but skip when nothing changed, and the
   * deep link is snapshotted on load because the first scan clears the live selection.
   */
  let urlIntent = null;

  function currentUrlParams() {
    try {
      return new URL(window.location.href).searchParams;
    } catch {
      return new URLSearchParams();
    }
  }

  function syncUrl() {
    try {
      const url = new URL(window.location.href);
      const set = (key, value) => {
        if (value) {
          url.searchParams.set(key, value);
        } else {
          url.searchParams.delete(key);
        }
      };
      set('repository', state.repository ?? '');
      set('mode', state.mode === 'file' ? 'file' : state.mode === 'system' ? 'system' : '');
      set('unit', state.mode === 'system' ? state.systemUnit ?? '' : '');
      set('outside', state.mode === 'system' && state.showOutside ? '1' : '');
      set('node', store.get().ui.node ?? '');
      set('panel', store.get().ui.memberOpen ? 'member-map' : '');
      if (`${url.pathname}${url.search}` !== `${window.location.pathname}${window.location.search}`) {
        window.history.replaceState(null, '', url);
      }
    } catch {
      // A blocked history API only costs the deep link.
    }
  }

  /** Apply the URL's repository and mode, and remember the panel/node for after the scan. */
  function applyUrl() {
    const params = currentUrlParams();
    urlIntent = { node: params.get('node'), panel: params.get('panel') };
    const repository = params.get('repository');
    if (repository) {
      state.repository = repository;
    }
    const mode = params.get('mode');
    if (mode === 'file' || mode === 'block' || mode === 'system') {
      state.mode = mode;
      elements.detail.value = mode;
    }
    // A System deep link may name the open unit and the outside-links toggle.
    state.systemUnit = mode === 'system' ? params.get('unit') : null;
    state.systemUnitLabel = state.systemUnit;
    state.showOutside = mode === 'system' && params.get('outside') === '1';
    return params;
  }

  /** Reopen the member map the deep link named, once the graph it refers to is loaded. */
  async function restoreUrlPanel() {
    const intent = urlIntent;
    urlIntent = null;
    if (!intent || intent.panel !== 'member-map' || !intent.node) {
      return;
    }
    if (!app.current || !(app.current.nodes ?? []).some((entry) => entry.id === intent.node)) {
      return;
    }
    app.selection.selectNode(intent.node);
    await app.memberMap.openMemberMap(intent.node);
  }

  return {
    applyUrl,
    restoreUrlPanel,
    syncUrl,
  };
}
