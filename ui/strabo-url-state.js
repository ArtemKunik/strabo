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
      set(
        'mode',
        state.mode === 'file'
          ? 'file'
          : state.mode === 'system'
            ? 'system'
            : state.mode === 'structure'
              ? 'structure'
              : '',
      );
      set(
        'unit',
        state.mode === 'system'
          ? state.systemUnit ?? ''
          : state.mode === 'structure'
            ? state.structureUnit ?? ''
            : '',
      );
      set('tier', state.mode === 'structure' ? state.structureTier ?? '' : '');
      set('cell', state.mode === 'structure' ? state.structureCell ?? '' : '');
      set('outside', state.mode === 'system' && state.showOutside ? '1' : '');
      set(
        'level',
        state.mode === 'structure'
          ? state.structureCell
            ? 'cell'
            : state.structureGrid
              ? 'grid'
              : ''
          : '',
      );
      set(
        'direction',
        state.mode === 'structure' && state.structureDirection === 'horizontal' ? 'horizontal' : '',
      );
      set('since', state.mode === 'structure' ? state.structureSince ?? '' : '');
      set('flow', state.mode === 'structure' && state.structureFlow === 'data' ? 'data' : '');
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
    if (mode === 'file' || mode === 'block' || mode === 'system' || mode === 'structure') {
      state.mode = mode;
      elements.detail.value = mode;
    }
    // A System deep link may name the open unit and the outside-links toggle.
    state.systemUnit = mode === 'system' ? params.get('unit') : null;
    state.systemUnitLabel = state.systemUnit;
    state.showOutside = mode === 'system' && params.get('outside') === '1';
    // A Structure deep link may name the grid or cell sub-level.
    const level = params.get('level');
    state.structureGrid = mode === 'structure' && (level === 'grid' || level === 'cell');
    state.structureCell = mode === 'structure' && level === 'cell' ? params.get('cell') : null;
    state.structureUnit =
      mode === 'structure'
        ? params.get('unit') ?? (state.structureCell ? state.structureCell.split('|')[0] || null : null)
        : null;
    state.structureUnitLabel = state.structureUnit;
    state.structureTier =
      mode === 'structure'
        ? params.get('tier') ?? (state.structureCell ? state.structureCell.split('|')[1] || null : null)
        : null;
    const dir = params.get('direction') ?? params.get('orientation');
    state.structureDirection = dir === 'horizontal' || dir === 'lr' ? 'horizontal' : 'vertical';
    state.structureSince = mode === 'structure' ? params.get('since') || null : null;
    state.structureFlow = mode === 'structure' && params.get('flow') === 'data' ? 'data' : 'imports';
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
