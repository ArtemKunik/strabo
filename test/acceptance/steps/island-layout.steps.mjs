import assert from 'node:assert/strict';

import { Then, When } from '@cucumber/cucumber';

/** A page coordinate in a plate's padding that no node covers, so a press there drags the plate. */
async function islandDragPoint(page, directory) {
  const point = await page.evaluate((dir) => {
    const cy = window.straboTest?.cy;
    const boxes = window.straboTest?.islandBoxes?.() ?? [];
    const box = boxes.find((candidate) => candidate.directory === dir);
    if (!cy || !box) {
      return null;
    }
    const rect = cy.container().getBoundingClientRect();
    const model = window.straboTest.model();
    const ids = new Set(
      (model.nodes ?? [])
        .filter((node) => (node.directory ?? '.') === dir)
        .map((node) => node.id),
    );
    const obstacles = cy
      .nodes()
      .filter((node) => ids.has(node.id()))
      .map((node) => node.renderedBoundingBox());
    const covered = (x, y) =>
      obstacles.some((o) => x >= o.x1 && x <= o.x2 && y >= o.y1 && y <= o.y2);
    for (let y = box.y + 6; y <= box.y + box.height - 6; y += 5) {
      for (let x = box.x + 6; x <= box.x + box.width - 6; x += 5) {
        if (!covered(x, y)) {
          return { x: rect.left + x, y: rect.top + y };
        }
      }
    }
    return null;
  }, directory);
  if (!point) {
    throw new Error(`No free point inside the island "${directory}" to drag from.`);
  }
  return point;
}

async function nodePosition(page, id) {
  return page.evaluate((nodeId) => {
    const node = window.straboTest?.cy?.getElementById(nodeId);
    if (!node || node.empty()) {
      return null;
    }
    const position = node.position();
    return { x: position.x, y: position.y };
  }, id);
}

When('I note the position of the {string} node', async function (id) {
  this.notedPosition = await nodePosition(this.page, id);
  assert.ok(this.notedPosition, `node "${id}" should be in the rendered graph`);
});

When('I drag the island {string} right by {int} pixels', async function (directory, distance) {
  const start = await islandDragPoint(this.page, directory);
  await this.page.mouse.move(start.x, start.y);
  await this.page.mouse.down();
  await this.page.mouse.move(start.x + distance, start.y, { steps: 10 });
  await this.page.mouse.up();
  await this.page.waitForFunction(
    (dir) => Object.keys(window.straboTest?.islandOffsets?.() ?? {}).includes(dir),
    directory,
    { timeout: 10_000 },
  );
});

Then('the island layout records a move for {string}', async function (directory) {
  const offsets = await this.page.evaluate(() => window.straboTest.islandOffsets());
  assert.ok(
    offsets[directory],
    `expected a recorded move for ${directory}, got ${JSON.stringify(offsets)}`,
  );
});

Then('the island layout is empty', async function () {
  const offsets = await this.page.evaluate(() => window.straboTest.islandOffsets());
  assert.deepEqual(offsets, {}, 'the computed layout should be the only arrangement left');
});

Then('the {string} node has moved from the noted position', async function (id) {
  const now = await nodePosition(this.page, id);
  assert.ok(now, `node "${id}" should still be in the graph`);
  assert.ok(
    Math.abs(now.x - this.notedPosition.x) > 1 || Math.abs(now.y - this.notedPosition.y) > 1,
    `expected "${id}" to move from ${JSON.stringify(this.notedPosition)}, still at ${JSON.stringify(now)}`,
  );
});

Then('the {string} node is back at the noted position', async function (id) {
  const now = await nodePosition(this.page, id);
  assert.ok(now, `node "${id}" should still be in the graph`);
  assert.ok(
    Math.abs(now.x - this.notedPosition.x) < 0.75 && Math.abs(now.y - this.notedPosition.y) < 0.75,
    `expected "${id}" back at ${JSON.stringify(this.notedPosition)}, got ${JSON.stringify(now)}`,
  );
});

When('I reset the map layout', async function () {
  await this.page.evaluate(() => window.straboTest.resetIslandLayout());
});
