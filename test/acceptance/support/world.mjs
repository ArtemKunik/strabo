import { World, setWorldConstructor } from '@cucumber/cucumber';

import { ACCEPTANCE_URL } from './server.mjs';

export class StraboWorld extends World {
  constructor(options) {
    super(options);
    this.baseUrl = ACCEPTANCE_URL;
  }

  /** The rendered centre of a graph node, in page coordinates. */
  async nodeCenter(id) {
    const point = await this.page.evaluate((nodeId) => {
      const cy = window.straboTest?.cy;
      if (!cy) return null;
      const node = cy.getElementById(nodeId);
      if (node.empty()) return null;
      const rendered = node.renderedPosition();
      const rect = cy.container().getBoundingClientRect();
      return { x: rect.left + rendered.x, y: rect.top + rendered.y };
    }, id);
    if (!point) {
      throw new Error(`Node "${id}" is not present in the rendered graph.`);
    }
    return point;
  }

  /**
   * Click a canvas node, retrying on a miss.
   *
   * Cytoscape draws to a canvas, so a click can land before the renderer has settled.
   * Coordinates are recomputed on each attempt instead of trusting a stale position.
   */
  async clickNode(id, options = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const point = await this.nodeCenter(id);
      if (options.double) {
        await this.page.mouse.dblclick(point.x, point.y, { delay: 60 });
      } else {
        await this.page.mouse.click(point.x, point.y);
      }
      try {
        await this.page.waitForFunction(options.settled, id, { timeout: 5_000 });
        return;
      } catch (error) {
        lastError = error;
      }    }
    throw lastError ?? new Error(`Could not interact with node "${id}".`);
  }

  async currentModel() {
    return this.page.evaluate(() => window.straboTest?.model() ?? null);
  }

  /**
   * Open one of the inspector's tab panels.
   *
   * The inspector is tabbed, so members and data flow are inert until their tab is
   * selected; steps that assert on them must activate the tab first. The first-run
   * Repository passport greeting floats over the inspector, so it is dismissed first
   * when open — exactly as an operator would clear it before working.
   */
  async openInspectorTab(key) {
    await this.dismissPassportGreeting();
    const tab = this.page.locator(`#inspector .inspector-tab[data-tab="${key}"]`);
    await tab.waitFor({ state: 'visible', timeout: 15_000 });
    await tab.click();
    await this.page.waitForFunction(
      (name) => {
        const selected = document.querySelector(`#inspector .inspector-tab[data-tab="${name}"]`);
        return selected?.getAttribute('aria-selected') === 'true';
      },
      key,
      { timeout: 15_000 },
    );
  }

  /** The rendered midpoint of an edge whose source is `sourceId`, in page coordinates. */
  async edgeCenter(sourceId) {
    const point = await this.page.evaluate((nodeId) => {
      const cy = window.straboTest?.cy;
      if (!cy) return null;
      const edge = cy
        .edges()
        .filter((candidate) => candidate.source().id() === nodeId)
        .filter((candidate) => candidate.visible())
        .first();
      if (edge.empty()) return null;
      const midpoint = edge.midpoint();
      const pan = cy.pan();
      const zoom = cy.zoom();
      const rect = cy.container().getBoundingClientRect();
      return {
        id: edge.id(),
        x: rect.left + midpoint.x * zoom + pan.x,
        y: rect.top + midpoint.y * zoom + pan.y,
      };
    }, sourceId);
    if (!point) {
      throw new Error(`No visible outgoing edge from "${sourceId}".`);
    }
    return point;
  }

  /** Click the midpoint of an outgoing edge, retrying on a miss. */
  async clickEdge(sourceId, settled) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const point = await this.edgeCenter(sourceId);
      await this.page.mouse.click(point.x, point.y);
      try {
        await this.page.waitForFunction(settled, undefined, { timeout: 5_000 });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error(`Could not select an edge from "${sourceId}".`);
  }

  async waitForModel(predicate) {
    await this.page.waitForFunction(predicate, undefined, { timeout: 15_000 });
  }

  /**
   * Dismiss the first-run Repository passport greeting when it is open.
   *
   * The greeting appears once per fresh browser profile and floats over the toolbar
   * and inspector. An operator clears it with "View the map" before working; tests do
   * the same before clicking past it. The greeting renders after the passport report
   * arrives, so the first call on a page waits for a late greeting; later calls take
   * the fast path. When no greeting ever opens this is a bounded wait, not a hang.
   */
  async dismissPassportGreeting() {
    const settled = await this.page
      .evaluate(() => window.__passportDismissed === true)
      .catch(() => false);
    const close = this.page.locator('#close-passport');
    try {
      if (settled) {
        if (await close.isVisible({ timeout: 1_000 })) {
          await close.click({ timeout: 5_000 });
        }
        return;
      }
      await close.waitFor({ state: 'visible', timeout: 12_000 });
      await close.click({ timeout: 5_000 });
      await this.page
        .waitForSelector('#passport-panel', { state: 'hidden', timeout: 5_000 })
        .catch(() => {});
    } catch {
      // No greeting open; nothing to dismiss.
    } finally {
      await this.page.evaluate(() => {
        window.__passportDismissed = true;
      });
    }
  }
}

setWorldConstructor(StraboWorld);
