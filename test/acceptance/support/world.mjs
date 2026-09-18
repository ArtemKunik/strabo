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

  async waitForModel(predicate) {
    await this.page.waitForFunction(predicate, undefined, { timeout: 15_000 });
  }
}

setWorldConstructor(StraboWorld);
