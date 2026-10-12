/**
 * The refactor sandbox window (Phase 39 S4): collects hypothetical edits from the map's
 * right-click menu and the panel form, asks the server what the edited graph would record, and
 * rings the result on the map with the review overlay's classes. Nothing here writes: the
 * edits live in this window until it is cleared, and the server only simulates them.
 */

import { edgeEvidenceFor } from './strabo-core.js';
import {
  addOperation,
  extractionClasses,
  extractionEvidence,
  removeOperation,
  renderSandboxPanel,
  whatIfClasses,
  whatIfEvidence,
} from './strabo-sandbox.js';

export function createSandbox(app) {
  const { state, view, elements, request } = app;

  const model = {
    tab: 'what-if',
    operations: [],
    draft: null,
    result: null,
    busy: false,
    error: '',
    include: '',
    plan: null,
    planBusy: false,
    planError: '',
  };
  /** The file an "add import" starts from, set by one right-click and spent by the next. */
  let pendingSource = null;
  /** Bumped on every request so a slow answer cannot overwrite a newer one. */
  let generation = 0;

  function repositoryQuery() {
    return state.repository ? `&repository=${encodeURIComponent(state.repository)}` : '';
  }

  function render() {
    renderSandboxPanel(elements.sandboxPanel, model, {
      onTab: (tab) => {
        model.tab = tab;
        render();
        paint();
      },
      onAdd: (op) => edit(addOperation(model.operations, op)),
      onRemove: (index) => edit(removeOperation(model.operations, index)),
      onClear: () => edit([]),
      onFocus: (file) => focusFile(file),
      onDelegate: (event) => delegate(event, whatIfTarget()),
      onPlan: (include) => plan(include),
      onDelegatePlan: (event) => delegate(event, extractionTarget()),
    });
  }

  /** Ring the current tab's answer on the map. */
  function paint() {
    if (elements.sandboxPanel.hidden) {
      return;
    }
    const classes = model.tab === 'extraction' ? extractionClasses(model.plan) : whatIfClasses(model.result);
    view.overlay(classes.size > 0 ? classes : null);
  }

  function open() {
    elements.sandboxPanel.hidden = false;
    render();
    paint();
    app.windows.refreshDock();
  }

  function close() {
    elements.sandboxPanel.hidden = true;
    pendingSource = null;
    // Hand the map back to whichever review overlay the toolbar has selected.
    void app.lenses.applyOverlay();
    app.windows.refreshDock();
  }

  async function edit(operations) {
    model.operations = operations;
    model.draft = null;
    model.tab = 'what-if';
    open();
    await simulate();
  }

  async function simulate() {
    const mine = ++generation;
    if (model.operations.length === 0) {
      Object.assign(model, { result: null, busy: false, error: '' });
      render();
      paint();
      return;
    }
    Object.assign(model, { busy: true, error: '' });
    render();
    try {
      const ops = encodeURIComponent(JSON.stringify(model.operations));
      const result = await request(`/analysis/what-if?ops=${ops}${repositoryQuery()}`);
      if (mine !== generation) return;
      Object.assign(model, { result, busy: false });
    } catch (error) {
      if (mine !== generation) return;
      Object.assign(model, { result: null, busy: false, error: `The simulation could not run: ${error.message}` });
    }
    render();
    paint();
  }

  async function plan(include) {
    const mine = ++generation;
    Object.assign(model, { tab: 'extraction', include, planBusy: true, planError: '', plan: null });
    open();
    try {
      const result = await request(`/analysis/extraction?include=${encodeURIComponent(include)}${repositoryQuery()}`);
      if (mine !== generation) return;
      Object.assign(model, { plan: result, planBusy: false });
    } catch (error) {
      if (mine !== generation) return;
      Object.assign(model, { planBusy: false, planError: `The plan could not be made: ${error.message}` });
    }
    render();
    paint();
  }

  /** Select a file on the map, or say where it is when the current view does not draw it. */
  function focusFile(file) {
    const visible = (app.current?.nodes ?? []).some((node) => node.id === file);
    if (!visible) {
      elements.status.textContent = `${file} is not drawn in this view; switch to Files to see it.`;
      return;
    }
    app.selection.selectNode(file);
  }

  function whatIfTarget() {
    return {
      kind: 'sandbox',
      label: `${model.operations.length} planned edit(s)`,
      evidence: whatIfEvidence(model.operations, model.result),
    };
  }

  function extractionTarget() {
    return {
      kind: 'extraction',
      label: `Extract ${model.plan?.include?.join(', ') ?? model.include}`,
      evidence: extractionEvidence(model.plan),
    };
  }

  function delegate(event, target) {
    const rect = event?.currentTarget?.getBoundingClientRect?.();
    app.delegation.openDelegateMenu(target, rect?.left ?? window.innerWidth / 2, (rect?.bottom ?? 0) + 4);
  }

  /** Roll-up cards stand for no path: tier bands, the shelf, axis labels, and data hubs. */
  const ROLL_UPS = new Set(['tier', 'shelf', 'axis', 'dataset']);

  /**
   * What a map node stands for: `directory` in the Directories view and for a System unit card,
   * `rollup` for a card with no path, else `file`.
   */
  function nodeRole(id) {
    const kind = (app.current?.nodes ?? []).find((node) => node.id === id)?.kind ?? null;
    if (ROLL_UPS.has(kind)) return 'rollup';
    if (state.mode === 'block' || kind === 'unit') return id === '.' ? 'rollup' : 'directory';
    return 'file';
  }

  /**
   * The sandbox entries for the right-click menu. A file offers move, start-an-import, and
   * (once one is started) finish-it; a directory offers move and plan-extraction; a file-level
   * import edge offers cut. Roll-up cards and tier edges are not files, so they get nothing.
   */
  function menuItems(target) {
    const items = [];
    if (target?.kind === 'node' && target.id) {
      const id = target.id;
      const role = nodeRole(id);
      if (role === 'directory') {
        items.push({ label: '⚗ Plan extraction of this directory', hint: 'sandbox', action: () => plan(id) });
      }
      if (role !== 'rollup') {
        items.push({
          label: '⚗ Move in sandbox…',
          hint: 'hypothetical',
          action: () => {
            model.draft = { op: 'move', first: id, second: '', focus: 'second' };
            model.tab = 'what-if';
            open();
          },
        });
      }
      if (role === 'file') {
        if (pendingSource && pendingSource !== id) {
          const source = pendingSource;
          items.push({
            label: `⚗ Add import ${source.split('/').pop()} → here`,
            hint: 'hypothetical',
            action: () => {
              pendingSource = null;
              void edit(addOperation(model.operations, { op: 'add', source, target: id }));
            },
          });
        }
        items.push({
          label: '⚗ Start an import from here',
          hint: 'then right-click its target',
          action: () => {
            pendingSource = id;
            elements.status.textContent = `Sandbox: right-click the file ${id.split('/').pop()} should import.`;
          },
        });
        items.push({ label: '⚗ Plan extraction of this file', hint: 'sandbox', action: () => plan(id) });
      }
    } else if (target?.kind === 'edge' && target.id && !Array.isArray(target.flows)) {
      const edge = app.current ? edgeEvidenceFor(app.current, target.id) : null;
      if (edge?.source && edge?.target) {
        items.push({
          label: '⚗ Cut this import in sandbox',
          hint: 'hypothetical',
          action: () => void edit(addOperation(model.operations, { op: 'cut', source: edge.source, target: edge.target })),
        });
      }
    } else if (target?.kind === 'group' && Array.isArray(target.items) && target.items.length > 0) {
      items.push({
        label: `⚗ Plan extraction of ${target.items.length} files`,
        hint: 'sandbox',
        action: () => plan(target.items.map((entry) => entry.id).filter(Boolean).join(',')),
      });
    }
    return items.length > 0 ? [...items, { separator: true }] : items;
  }

  return { open, close, plan, menuItems };
}
