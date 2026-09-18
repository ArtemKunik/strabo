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
  const edgeHandlers = [];
  let selectedEdge = null;

  // Cytoscape does not observe container size itself. The breadcrumb, diagnostics panel,
  // and inspector all change layout after the graph is created, so keep it in sync or
  // rendered coordinates drift from the DOM and hit-testing misses.
  const observer = new ResizeObserver(() => cy.resize());
  observer.observe(container);

  cy.on('tap', 'node', (event) => {
    for (const handler of selectHandlers) handler(event.target.id());
    applyLabelBudget(cy);
  });
  cy.on('dbltap', 'node', (event) => {
    for (const handler of drillHandlers) handler(event.target.id());
  });
  cy.on('tap', 'edge', (event) => {
    selectEdge(event.target.id());
    for (const handler of edgeHandlers) handler(event.target.id());
  });
  cy.on('tap', (event) => {
    if (event.target === cy) {
      selectEdge(null);
      for (const handler of edgeHandlers) handler(null);
    }
  });
  cy.on('zoom', () => applyLabelBudget(cy));
  cy.on('mouseover', 'node', (event) => {
    for (const handler of hoverHandlers) handler(event.target.id(), event.originalEvent);
  });
  cy.on('mouseout', 'node', () => {
    for (const handler of hoverHandlers) handler(null);
  });
  cy.on('mouseover', 'edge', (event) => {
    event.target.addClass('hover');
  });
  cy.on('mouseout', 'edge', (event) => {
    event.target.removeClass('hover');
  });

  /** Highlight one edge, or clear when null. The selected edge is always classed. */
  function selectEdge(edgeId) {
    cy.edges().removeClass('edge-selected');
    selectedEdge = edgeId;
    if (edgeId) {
      const edge = cy.getElementById(edgeId);
      if (edge.nonempty()) {
        edge.addClass('edge-selected');
      }
    }
  }

  return {
    cy,
    capabilities: { webgl2: probeWebGL2() },
    resize() {
      cy.resize();
    },
    render(model) {
      const elements = buildElements(model);
      selectedEdge = null;
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
    onEdge(handler) {
      edgeHandlers.push(handler);
    },
    clearEdge() {
      selectEdge(null);
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
 * user zooms in. Selected nodes always keep labels. Runs after render/filter/select.
 */
function applyLabelBudget(cy) {
  const detailed = cy.zoom() > 0.65;
  cy.nodes().forEach((node) => {
    const show = detailed || node.data('hub') || node.selected();
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
        'background-opacity': 0.88,
        width: 'data(diameter)',
        height: 'data(diameter)',
        label: 'data(label)',
        'font-size': 10,
        'font-weight': 500,
        color: '#eef3fa',
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-opacity': 1,
        'text-outline-color': '#0c1016',
        'text-outline-width': 3,
        'text-outline-opacity': 0.9,
        'border-width': 1.5,
        'border-color': 'rgba(255,255,255,0.22)',
        'border-opacity': 1,
      },
    },
    ...kindRules,
    { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#ffffff', 'background-opacity': 1, 'shadow-blur': 18, 'shadow-color': '#4c9aff', 'shadow-opacity': 0.9 } },
    { selector: 'node[?hub]', style: { 'border-width': 2.5, 'border-color': '#4c9aff', 'font-size': 12, 'font-weight': 700, 'shadow-blur': 10, 'shadow-color': '#4c9aff', 'shadow-opacity': 0.55 } },
    { selector: 'node.ov-changed', style: { 'border-width': 4, 'border-color': '#ff5c5c', 'background-opacity': 1, 'shadow-blur': 14, 'shadow-color': '#ff5c5c', 'shadow-opacity': 0.7 } },
    { selector: 'node.ov-affected', style: { 'border-width': 3, 'border-color': '#f2b25c', 'background-opacity': 1, 'shadow-blur': 10, 'shadow-color': '#f2b25c', 'shadow-opacity': 0.6 } },
    { selector: 'node.ov-cycle', style: { 'border-width': 4, 'border-color': '#c98bf0', 'background-opacity': 1, 'shadow-blur': 14, 'shadow-color': '#c98bf0', 'shadow-opacity': 0.7 } },
    { selector: 'node.ov-unreached', style: { 'border-width': 2.5, 'border-style': 'dashed', 'border-color': '#8da0b5', 'background-opacity': 0.55 } },
    { selector: 'node.label-hidden', style: { 'text-opacity': 0 } },
    { selector: 'node.filtered-out', style: { display: 'none' } },
    { selector: '.dimmed', style: { opacity: 0.12 } },
    {
      selector: 'edge',
      style: {
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        width: 1.2,
        opacity: 0.55,
        'line-color': '#3a4a5e',
        'target-arrow-color': '#3a4a5e',
        'arrow-scale': 0.9,
      },
    },
    { selector: 'edge.dimmed', style: { opacity: 0.05 } },
    {
      selector: 'edge.edge-selected',
      style: {
        width: 2.75,
        opacity: 1,
        'line-color': '#4c9aff',
        'target-arrow-color': '#4c9aff',
        'arrow-scale': 1.1,
        'z-index': 10,
        'shadow-blur': 8,
        'shadow-color': '#4c9aff',
        'shadow-opacity': 0.6,
      },
    },
    {
      selector: 'edge.hover',
      style: {
        width: 2,
        opacity: 0.9,
        'line-color': '#7fb4ff',
        'target-arrow-color': '#7fb4ff',
      },
    },
  ];
}
