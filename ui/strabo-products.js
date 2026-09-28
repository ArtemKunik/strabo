/**
 * The Data products controller: fetches `/analysis/data/products` and drives the Data
 * products panel, and fetches `/analysis/data/overlay` to draw the data-on-code overlay.
 *
 * The panel fetch is on demand and token-guarded, so a slow response never overwrites a
 * newer one; a server error object is rendered in the panel, not thrown.
 */

import { renderProducts } from './strabo-panels.js';

export function createProducts(app) {
  const { state, elements } = app;

  /** Guards a slow panel fetch against a newer one. */
  let panelToken = 0;
  /** The last panel report, or `{ error }`, for the retry button. */
  let panelReport = null;

  function productsQuery() {
    return state.repository ? `?repository=${encodeURIComponent(state.repository)}` : '';
  }

  const handlers = {
    onSelect: (id) => app.selection?.selectNode(id),
    onRetry: () => {
      loadProducts();
    },
  };

  function renderPanel() {
    renderProducts(elements.productsPanel, panelReport, handlers);
  }

  /** Open the window and load the data products report. */
  async function showProducts() {
    elements.productsPanel.hidden = false;
    await loadProducts();
    app.windows?.refreshDock();
  }

  async function loadProducts() {
    const token = (panelToken += 1);
    panelReport = { loading: true };
    renderPanel();
    try {
      const report = await app.request(`/analysis/data/products${productsQuery()}`);
      if (token !== panelToken) {
        return;
      }
      panelReport = report;
    } catch (error) {
      if (token !== panelToken) {
        return;
      }
      panelReport = { error: error.message };
    }
    renderPanel();
  }

  function closeProducts() {
    elements.productsPanel.hidden = true;
    app.windows?.refreshDock();
  }

  elements.tbProducts?.addEventListener('click', () => {
    app.floatingWindows?.find?.((controller) => controller.key === 'products')?.toggle();
  });

  return {
    closeProducts,
    loadProducts,
    showProducts,
  };
}
