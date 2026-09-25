/**
 * Navigation for the Strabo graph: the API path, the `/graph` query for the current view
 * state, and the drill-down breadcrumb.
 *
 * Pure functions only: no DOM, no Cytoscape, no fetch.
 */

export const API_PATH = '/api/strabo';

/**
 * Build the `/graph` query string for the current view state.
 *
 * Refresh is a server cache bypass (`refresh=1`), not a repaint. Block mode sends the
 * drill-down prefix so the server rolls up relative to it.
 */
export function buildGraphQuery(state, options = {}) {
  const params = new URLSearchParams();
  if (state.repository) {
    params.set('repository', state.repository);
  }
  if (options.refresh) {
    params.set('refresh', '1');
  }
  if (state.mode === 'system') {
    params.set('system', '1');
    if (state.systemUnit) {
      params.set('systemUnit', state.systemUnit);
      if (state.showOutside) {
        params.set('outside', '1');
        if (state.unitFile) {
          params.set('selected', state.unitFile);
        }
        if (state.expandedUnits?.length) {
          params.set('expanded', state.expandedUnits.join(','));
        }
      }
    }
  } else if (state.mode === 'block') {
    params.set('blockDepth', String(state.depth ?? 1));
    if (state.prefix) {
      params.set('blockPrefix', state.prefix);
    }
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Breadcrumb segments for the current drill-down, root last.
 *
 * Block mode walks the path prefix; System mode is `System › unit` when a unit is open,
 * and a single `System` crumb at L0. File mode has no drill-down.
 */
export function breadcrumb(state) {
  if (state.mode === 'system') {
    const crumbs = [{ label: 'System', prefix: '' }];
    if (state.systemUnit) {
      crumbs.push({ label: state.systemUnitLabel ?? state.systemUnit, prefix: state.systemUnit });
    }
    return crumbs;
  }
  if (state.mode !== 'block') {
    return [];
  }
  const crumbs = [{ label: 'repository', prefix: '' }];
  const segments = (state.prefix ?? '').split('/').filter(Boolean);
  segments.forEach((segment, index) => {
    crumbs.push({ label: segment, prefix: segments.slice(0, index + 1).join('/') });
  });
  return crumbs;
}
