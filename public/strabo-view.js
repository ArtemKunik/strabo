/**
 * Cytoscape rendering for Strabo.
 *
 * Joins API nodes to metrics and positions by ID, resolves server-assigned palette
 * indexes, and generates Cytoscape elements. Pure element construction lives in
 * strabo-core so it can be unit-tested; this module only touches Cytoscape.
 */

import { SHAPES, buildElements } from './strabo-core.js';

const OVERLAY_CLASSES = ['ov-changed', 'ov-affected', 'ov-cycle', 'ov-unreached'];

export function createView(container) {
  const cy = window.cytoscape({
    container,
    style: stylesheet(),
    layout: { name: 'preset' },
    wheelSensitivity: 0.2,
  });

  const selectHandlers = [];
  const drillHandlers = [];
  const hoverHandlers = [];

  // Cytoscape does not observe container size itself. The breadcrumb, diagnostics panel,
  // and inspector all change layout after the graph is created, so keep it in sync or
  // rendered coordinates drift from the DOM and hit-testing misses.
  const observer = new ResizeObserver(() => cy.resize());
  observer.observe(container);

  cy.on('tap', 'node', (event) => {
    for (const handler of selectHandlers) handler(event.target.id());
  });
  cy.on('dbltap', 'node', (event) => {
    for (const handler of drillHandlers) handler(event.target.id());
  });
  cy.on('zoom', () => applyLabelBudget(cy));
  cy.on('mouseover', 'node', (event) => {
    for (const handler of hoverHandlers) handler(event.target.id());
  });
  cy.on('mouseout', 'node', () => {
    for (const handler of hoverHandlers) handler(null);
  });

  return {
    cy,
    capabilities: { webgl2: probeWebGL2() },
    resize() {
      cy.resize();
    },
    render(model) {
      const elements = buildElements(model);
      cy.batch(() => {
        cy.elements().remove();
        cy.add(elements.nodes);
        cy.add(elements.edges);
      });
      applyLabelBudget(cy);
    },
    highlight(ids) {
      const keep = ids ? new Set(ids) : null;
      cy.elements().removeClass('dimmed');
      if (!keep) {
        return;
      }
      cy.nodes().forEach((node) => {
        if (!keep.has(node.id())) node.addClass('dimmed');
      });
    },
    /** Annotate nodes from a review analysis. Pass null to clear. */
    overlay(classesByNode) {
      cy.nodes().removeClass(OVERLAY_CLASSES.join(' '));
      if (!classesByNode) {
        return;
      }
      for (const [id, className] of classesByNode) {
        const node = cy.getElementById(id);
        if (node.nonempty()) node.addClass(className);
      }
    },
    /** Hide nodes that do not match, then reapply labels so hidden nodes don't consume budget. */
    filter(ids) {
      const keep = ids ? new Set(ids) : null;
      cy.nodes().forEach((node) => {
        const visible = !keep || keep.has(node.id());
        node.toggleClass('filtered-out', !visible);
      });
      applyLabelBudget(cy);
    },
    /** Fit the viewport to a set of node ids, ignoring the rest. */
    fitNodes(ids) {
      const collection = cy.collection(
        (ids ?? []).map((id) => cy.getElementById(id)).filter((node) => node.nonempty()),
      );
      if (collection.nonempty()) {
        cy.fit(collection, 80);
      }
    },
    onSelect(handler) {
      selectHandlers.push(handler);
    },
    onDrill(handler) {
      drillHandlers.push(handler);
    },
    onHover(handler) {
      hoverHandlers.push(handler);
    },
  };
}

/** Probe a real WebGL2 context so the UI can report which renderer is usable. */
function probeWebGL2() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(window.WebGL2RenderingContext && canvas.getContext('webgl2'));
  } catch {
    return false;
  }
}

/**
 * Semantic zoom: hubs keep labels when zoomed out, ordinary nodes gain labels as the
 * user zooms in. Runs after rendering, filtering, and selection changes.
 */
function applyLabelBudget(cy) {
  const detailed = cy.zoom() > 0.8;
  cy.nodes().forEach((node) => {
    const show = detailed || node.data('hub');
    node.toggleClass('label-hidden', !show);
  });
}

function stylesheet() {
  const kindRules = Object.entries(SHAPES).map(([kind, shape]) => ({
    selector: `node.kind-${kind}`,
    style: { shape },
  }));

  return [
    {
      selector: 'node',
      style: {
        shape: 'round-rectangle',
        'background-color': 'data(color)',
        width: 'data(diameter)',
        height: 'data(diameter)',
        label: 'data(label)',
        'font-size': 9,
        color: '#e7edf5',
        'text-valign': 'bottom',
        'text-margin-y': 3,
        'text-opacity': 1,
        'border-width': 1,
        'border-color': '#0d1117',
      },
    },
    ...kindRules,
    { selector: 'node[?hub]', style: { 'border-width': 3, 'border-color': '#4c9aff', 'font-size': 12 } },
    { selector: 'node.ov-changed', style: { 'border-width': 4, 'border-color': '#ff5c5c' } },
    { selector: 'node.ov-affected', style: { 'border-width': 3, 'border-color': '#f2b25c' } },
    { selector: 'node.ov-cycle', style: { 'border-width': 4, 'border-color': '#c98bf0' } },
    { selector: 'node.ov-unreached', style: { 'border-width': 3, 'border-color': '#8da0b5' } },
    { selector: 'node.label-hidden', style: { 'text-opacity': 0 } },
    { selector: 'node.filtered-out', style: { display: 'none' } },
    { selector: '.dimmed', style: { opacity: 0.15 } },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        width: 1,
        'line-color': '#2b3646',
        'target-arrow-color': '#2b3646',
        'arrow-scale': 0.8,
      },
    },
    { selector: 'edge.dimmed', style: { opacity: 0.05 } },
  ];
}
