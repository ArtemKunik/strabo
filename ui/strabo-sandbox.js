/**
 * The refactor sandbox panel (Phase 39 S4): a list of hypothetical edits and what the edited
 * graph would record, and an extraction plan for a file set.
 *
 * The shaping lives in pure helpers so it can be exercised from Node; the DOM is thin. Every
 * result is labelled hypothetical, and an edit the server could not apply is shown with its
 * reason rather than dropped.
 */

/** The three edits the server understands, with the two fields each one names. */
export const SANDBOX_OPERATIONS = {
  cut: { label: 'Cut import', fields: ['source', 'target'] },
  add: { label: 'Add import', fields: ['source', 'target'] },
  move: { label: 'Move path', fields: ['from', 'to'] },
};

/** Rows a result list shows before it says how many more there are. */
export const SANDBOX_LIST_LIMIT = 12;

function trimPath(value) {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/** A well-formed edit, or null: both of its fields are required. */
export function normaliseOperation(op) {
  const spec = SANDBOX_OPERATIONS[op?.op];
  if (!spec) {
    return null;
  }
  const [first, second] = spec.fields;
  const a = trimPath(op[first]);
  const b = trimPath(op[second]);
  if (!a || !b) {
    return null;
  }
  return { op: op.op, [first]: a, [second]: b };
}

function operationKey(op) {
  return JSON.stringify(op);
}

/** Append an edit unless it is malformed or already listed; returns a new list. */
export function addOperation(operations, op) {
  const normalised = normaliseOperation(op);
  if (!normalised) {
    return operations;
  }
  const key = operationKey(normalised);
  return operations.some((existing) => operationKey(existing) === key) ? operations : [...operations, normalised];
}

export function removeOperation(operations, index) {
  return operations.filter((_, position) => position !== index);
}

/** One line naming an edit, e.g. `cut src/a.ts → src/b.ts`. */
export function describeOperation(op) {
  if (op?.op === 'move') {
    return `move ${op.from} → ${op.to}`;
  }
  return `${op?.op ?? '?'} ${op?.source ?? '?'} → ${op?.target ?? '?'}`;
}

/** The headline counts of a what-if result, as short labelled facts. */
export function whatIfHeadline(result) {
  const counts = result?.counts;
  if (!counts) {
    return [];
  }
  const facts = [
    ['cycles introduced', counts.cyclesIntroduced],
    ['cycles resolved', counts.cyclesResolved],
    ['wrong-way tier edges introduced', counts.tierIntroduced],
    ['wrong-way tier edges resolved', counts.tierResolved],
    ['rule violations introduced', counts.rulesIntroduced],
    ['rule violations resolved', counts.rulesResolved],
    ['files tests would stop reaching', counts.newlyUnreached],
  ];
  return facts.map(([label, value]) => ({ label, value: value ?? 0 }));
}

/**
 * Node classes for the map, reusing the review overlay's rings so the sandbox spends no new
 * colour: an edited file is `ov-changed`, a member of an introduced cycle `ov-cycle`, an end of
 * an introduced rule violation `ov-declared-rule`, and a file tests stop reaching `ov-unreached`.
 * The ids are the recorded paths, so a moved file is ringed where the map still draws it.
 */
export function whatIfClasses(result) {
  const classes = new Map();
  const original = new Map((result?.moved ?? []).map((entry) => [entry.to, entry.from]));
  const recorded = (id) => original.get(id) ?? id;
  for (const entry of result?.applied ?? []) {
    const op = entry.operation;
    if (op?.op === 'move') {
      for (const moved of result.moved ?? []) {
        if (moved.from === op.from || moved.from.startsWith(`${op.from}/`)) classes.set(moved.from, 'ov-changed');
      }
    } else if (op) {
      classes.set(recorded(op.source), 'ov-changed');
      classes.set(recorded(op.target), 'ov-changed');
    }
  }
  for (const file of result?.newlyUnreached ?? []) classes.set(recorded(file), 'ov-unreached');
  for (const violation of result?.rules?.introduced ?? []) {
    classes.set(recorded(violation.edge.source), 'ov-declared-rule');
    classes.set(recorded(violation.edge.target), 'ov-declared-rule');
  }
  for (const cycle of result?.cyclesIntroduced ?? []) {
    for (const member of cycle.members ?? []) classes.set(recorded(member), 'ov-cycle');
  }
  return classes;
}

/**
 * Node classes for an extraction plan: the selected files `ov-changed`, the outside files they
 * import `ov-affected`, and the members of a boundary cycle `ov-cycle`.
 */
export function extractionClasses(plan) {
  const classes = new Map();
  for (const file of plan?.files ?? []) classes.set(file, 'ov-changed');
  for (const entry of plan?.dependencies ?? []) classes.set(entry.file, 'ov-affected');
  for (const cycle of plan?.boundaryCycles ?? []) {
    for (const member of [...(cycle.inside ?? []), ...(cycle.outside ?? [])]) classes.set(member, 'ov-cycle');
  }
  return classes;
}

/** Facts for an agent: the edits, then what the edited graph would record. */
export function whatIfEvidence(operations, result) {
  const evidence = operations.map((op) => `planned edit: ${describeOperation(op)}`);
  if (!result) {
    return evidence;
  }
  for (const fact of whatIfHeadline(result)) {
    evidence.push(`hypothetical ${fact.label}: ${fact.value}`);
  }
  for (const cycle of (result.cyclesIntroduced ?? []).slice(0, 5)) {
    evidence.push(`cycle introduced: ${cycle.members.join(' ↔ ')}`);
  }
  for (const direction of (result.tiers?.introduced ?? []).slice(0, 10)) {
    evidence.push(`wrong-way tier edge introduced: ${direction.source} → ${direction.target} (${direction.kind})`);
  }
  for (const violation of (result.rules?.introduced ?? []).slice(0, 10)) {
    evidence.push(`rule violation introduced: ${violation.detail}`);
  }
  for (const entry of (result.reach ?? []).filter((row) => row.before !== row.after).slice(0, 10)) {
    evidence.push(`blast radius of ${entry.file}: ${entry.before} → ${entry.after}`);
  }
  for (const entry of result.rejected ?? []) {
    evidence.push(`not applied: ${entry.reason}`);
  }
  return evidence;
}

/** Facts for an agent: the extraction plan's lists, each row with its recorded counts. */
export function extractionEvidence(plan) {
  if (!plan) {
    return [];
  }
  const evidence = [`extract: ${plan.include.join(', ')} (${plan.summary.files} files)`];
  for (const entry of plan.dependencies.slice(0, 20)) {
    evidence.push(
      `imports outside: ${entry.file} — used by ${entry.importedBy.length} selected file(s), would pull ${entry.pulls} more, shared with ${entry.usedOutside} outside file(s)${entry.typeOnly ? ', type-only' : ''}`,
    );
  }
  for (const entry of plan.dependents.slice(0, 20)) {
    evidence.push(`imported from outside: ${entry.file} — by ${entry.importers.join(', ')}`);
  }
  for (const cycle of plan.boundaryCycles) {
    evidence.push(`cycle across the boundary: ${[...cycle.inside, ...cycle.outside].join(' ↔ ')}`);
  }
  for (const crossing of plan.stringCrossings.slice(0, 10)) {
    evidence.push(`${crossing.kind} ${crossing.key} is used on both sides`);
  }
  if (plan.externalPackages.length > 0) {
    evidence.push(`external packages: ${plan.externalPackages.map((entry) => entry.package).join(', ')}`);
  }
  evidence.push(`not covered: ${plan.notCovered.join('; ')}`);
  return evidence;
}

/* ------------------------------------------------------------------ DOM */

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionButton(role, text, handler, disabled = false) {
  const node = element('button', `sandbox-${role}`, text);
  node.type = 'button';
  node.dataset.role = `sandbox-${role}`;
  node.disabled = disabled;
  node.addEventListener('click', handler);
  return node;
}

function section(title, rows, render, role) {
  const wrapper = element('section', 'sandbox-section');
  if (role) wrapper.dataset.role = role;
  wrapper.append(element('h4', null, `${title} (${rows.length})`));
  if (rows.length === 0) {
    wrapper.append(element('p', 'overlay-note', 'None.'));
    return wrapper;
  }
  const list = element('ul', 'sandbox-list');
  for (const row of rows.slice(0, SANDBOX_LIST_LIMIT)) {
    const item = element('li');
    render(item, row);
    list.append(item);
  }
  wrapper.append(list);
  if (rows.length > SANDBOX_LIST_LIMIT) {
    wrapper.append(element('p', 'overlay-note', `…and ${rows.length - SANDBOX_LIST_LIMIT} more.`));
  }
  return wrapper;
}

function fileLink(file, handlers) {
  const link = element('button', 'sandbox-file', file);
  link.type = 'button';
  link.title = `Select ${file} on the map`;
  link.addEventListener('click', () => handlers.onFocus?.(file));
  return link;
}

function renderTabs(container, model, handlers) {
  const tabs = element('div', 'sandbox-tabs');
  tabs.setAttribute('role', 'tablist');
  for (const [key, label] of [['what-if', 'What-if'], ['extraction', 'Extraction']]) {
    const tab = actionButton(`tab-${key}`, label, () => handlers.onTab?.(key));
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(model.tab === key));
    tabs.append(tab);
  }
  container.append(tabs);
}

function renderEditForm(container, model, handlers) {
  const form = element('form', 'sandbox-form');
  form.dataset.role = 'sandbox-form';
  const select = element('select');
  select.name = 'op';
  select.setAttribute('aria-label', 'Edit');
  for (const [key, spec] of Object.entries(SANDBOX_OPERATIONS)) {
    const option = element('option', null, spec.label);
    option.value = key;
    option.selected = key === (model.draft?.op ?? 'cut');
    select.append(option);
  }
  const first = element('input');
  first.name = 'first';
  const second = element('input');
  second.name = 'second';
  const placeholders = () => {
    const isMove = select.value === 'move';
    first.placeholder = isMove ? 'from (file or directory)' : 'source file';
    second.placeholder = isMove ? 'to (new path)' : 'target file';
    first.setAttribute('aria-label', first.placeholder);
    second.setAttribute('aria-label', second.placeholder);
  };
  placeholders();
  select.addEventListener('change', placeholders);
  first.value = model.draft?.first ?? '';
  second.value = model.draft?.second ?? '';
  const submit = element('button', 'sandbox-add', 'Add edit');
  submit.type = 'submit';
  submit.dataset.role = 'sandbox-add';
  form.append(select, first, second, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const [a, b] = SANDBOX_OPERATIONS[select.value].fields;
    handlers.onAdd?.({ op: select.value, [a]: first.value, [b]: second.value });
  });
  container.append(form);
  if (model.draft?.focus === 'second') {
    queueMicrotask(() => second.focus());
  }
}

function renderWhatIf(container, model, handlers) {
  container.append(
    element(
      'p',
      'overlay-note',
      'Edits apply to a copy of the recorded graph; nothing is written. Right-click a file or an import on the map to add one.',
    ),
  );
  renderEditForm(container, model, handlers);

  const edits = element('ol', 'sandbox-edits');
  edits.dataset.role = 'sandbox-edits';
  model.operations.forEach((op, index) => {
    const item = element('li', null, describeOperation(op));
    const remove = actionButton('remove', '×', () => handlers.onRemove?.(index));
    remove.title = 'Remove this edit';
    remove.setAttribute('aria-label', `Remove ${describeOperation(op)}`);
    item.append(' ', remove);
    edits.append(item);
  });
  if (model.operations.length === 0) {
    container.append(element('p', 'overlay-note', 'No edits yet.'));
  } else {
    container.append(edits);
  }

  const controls = element('div', 'sandbox-controls');
  controls.append(
    actionButton('clear', 'Clear', () => handlers.onClear?.(), model.operations.length === 0),
    actionButton('delegate', 'Delegate to an agent…', (event) => handlers.onDelegate?.(event), model.operations.length === 0),
  );
  container.append(controls);

  if (model.error) {
    container.append(element('p', 'unavailable', model.error));
    return;
  }
  if (model.busy) {
    container.append(element('p', 'overlay-note', 'Simulating…'));
    return;
  }
  const result = model.result;
  if (!result) {
    return;
  }

  const results = element('div', 'sandbox-results');
  results.dataset.role = 'sandbox-results';
  results.append(element('p', 'sandbox-hypothetical', 'Hypothetical — what the edited graph would record'));
  const facts = element('dl', 'sandbox-facts');
  for (const fact of whatIfHeadline(result)) {
    const dt = element('dt', null, fact.label);
    const dd = element('dd', fact.value > 0 ? 'sandbox-nonzero' : null, String(fact.value));
    facts.append(dt, dd);
  }
  results.append(facts);

  if ((result.rejected ?? []).length > 0) {
    results.append(
      section('Not applied', result.rejected, (item, row) => {
        item.textContent = `${row.operation ? describeOperation(row.operation) : 'request'} — ${row.reason}`;
      }, 'sandbox-rejected'),
    );
  }
  results.append(
    section('Cycles introduced', result.cyclesIntroduced ?? [], (item, cycle) => {
      item.textContent = `${cycle.members.length} files: ${cycle.members.join(' ↔ ')}`;
    }, 'sandbox-cycles-introduced'),
    section('Cycles resolved', result.cyclesResolved ?? [], (item, cycle) => {
      item.textContent = cycle.members.join(' ↔ ');
    }, 'sandbox-cycles-resolved'),
  );
  if (result.tiers?.available) {
    results.append(
      section('Wrong-way tier edges introduced', result.tiers.introduced, (item, direction) => {
        item.textContent = `${direction.source} → ${direction.target} (${direction.kind}, ${direction.sourceTier} → ${direction.targetTier})`;
      }),
      section('Wrong-way tier edges resolved', result.tiers.resolved, (item, direction) => {
        item.textContent = `${direction.source} → ${direction.target} (${direction.kind})`;
      }),
    );
  } else {
    results.append(element('p', 'unavailable', `Tier directions unavailable: ${result.tiers?.reason ?? 'not recorded'}.`));
  }
  if (result.rules?.available) {
    results.append(
      section('Rule violations introduced', result.rules.introduced, (item, violation) => {
        item.textContent = violation.detail;
      }),
      section('Rule violations resolved', result.rules.resolved, (item, violation) => {
        item.textContent = violation.detail;
      }),
    );
  } else {
    results.append(element('p', 'overlay-note', `Declared rules: ${result.rules?.reason ?? 'not recorded'}.`));
  }
  results.append(
    section('Files tests would stop reaching', result.newlyUnreached ?? [], (item, file) => {
      item.append(fileLink(file, handlers));
    }),
    section('Blast radius of touched files', result.reach ?? [], (item, row) => {
      item.append(fileLink(row.file, handlers), ` ${row.before} → ${row.after} dependents`);
      if (row.after > row.before) item.classList.add('sandbox-grew');
    }, 'sandbox-reach'),
  );
  if (result.reachTruncated > 0) {
    results.append(element('p', 'overlay-note', `${result.reachTruncated} more touched file(s) not measured.`));
  }
  container.append(results);
}

function renderExtraction(container, model, handlers) {
  container.append(
    element(
      'p',
      'overlay-note',
      'Name what to extract (comma-separated globs; a directory means everything under it). The plan names each cost; it does not choose.',
    ),
  );
  const form = element('form', 'sandbox-form');
  form.dataset.role = 'sandbox-extract-form';
  const input = element('input');
  input.name = 'include';
  input.placeholder = 'src/words, src/shared/words-*.ts';
  input.setAttribute('aria-label', 'Files to extract');
  input.value = model.include ?? '';
  const submit = element('button', 'sandbox-plan', 'Plan extraction');
  submit.type = 'submit';
  submit.dataset.role = 'sandbox-plan';
  form.append(input, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    handlers.onPlan?.(input.value);
  });
  container.append(form);

  if (model.planError) {
    container.append(element('p', 'unavailable', model.planError));
    return;
  }
  if (model.planBusy) {
    container.append(element('p', 'overlay-note', 'Planning…'));
    return;
  }
  const plan = model.plan;
  if (!plan) {
    return;
  }

  const results = element('div', 'sandbox-results');
  results.dataset.role = 'sandbox-plan-results';
  if (plan.unmatched.length > 0) {
    results.append(element('p', 'unavailable', `Matched no scanned file: ${plan.unmatched.join(', ')}`));
  }
  const facts = element('dl', 'sandbox-facts');
  for (const [label, value] of [
    ['selected files', plan.summary.files],
    ['outside files it imports', plan.summary.dependencies],
    ['selected files imported from outside', plan.summary.dependents],
    ['take-everything closure', plan.summary.closure],
    ['cycles across the boundary', plan.summary.boundaryCycles],
    ['env / route / flag keys on both sides', plan.summary.stringCrossings],
  ]) {
    facts.append(element('dt', null, label), element('dd', null, String(value)));
  }
  results.append(facts);
  results.append(
    element(
      'p',
      plan.summary.selfContained ? 'sandbox-verdict sandbox-ok' : 'sandbox-verdict',
      plan.summary.selfContained
        ? 'Self-contained: it imports nothing outside itself.'
        : 'Not self-contained: cut or take along each outside import below.',
    ),
  );

  results.append(
    section('Cycles across the boundary', plan.boundaryCycles, (item, cycle) => {
      item.textContent = `inside ${cycle.inside.join(', ')} ↔ outside ${cycle.outside.join(', ')}`;
    }, 'sandbox-boundary-cycles'),
    section('Outside files it imports — cut, or take along', plan.dependencies, (item, entry) => {
      item.append(
        fileLink(entry.file, handlers),
        ` · used by ${entry.importedBy.length} · pulls ${entry.pulls} more · shared with ${entry.usedOutside}${entry.typeOnly ? ' · type-only' : ''}`,
      );
      item.title = entry.evidence.map((row) => `${row.source}:${row.line} ${row.specifier}`).join('\n');
    }, 'sandbox-dependencies'),
    section('Selected files imported from outside — repoint', plan.dependents, (item, entry) => {
      item.append(fileLink(entry.file, handlers), ` · by ${entry.importers.length}: ${entry.importers.join(', ')}`);
    }, 'sandbox-dependents'),
    section('Keys used on both sides', plan.stringCrossings, (item, crossing) => {
      item.textContent = `${crossing.kind} ${crossing.key}`;
    }),
    section('External packages it imports', plan.externalPackages, (item, entry) => {
      item.textContent = `${entry.package} (${entry.ecosystem}) · ${entry.files.length} file(s)`;
    }),
  );
  if (!plan.stringEdges.available) {
    results.append(element('p', 'overlay-note', `String edges not read: ${plan.stringEdges.reason ?? 'unavailable'}.`));
  }
  results.append(element('p', 'overlay-note', `Not covered: ${plan.notCovered.join('; ')}.`));
  const controls = element('div', 'sandbox-controls');
  controls.append(actionButton('delegate-plan', 'Delegate to an agent…', (event) => handlers.onDelegatePlan?.(event)));
  results.append(controls);
  container.append(results);
}

/**
 * Draw the sandbox. `model` is `{ tab, operations, draft, result, busy, error, include, plan,
 * planBusy, planError }`; the handlers are wired to the controls and are all optional.
 */
export function renderSandboxPanel(container, model, handlers = {}) {
  container.replaceChildren();
  container.append(element('h3', null, 'Refactor sandbox'));
  renderTabs(container, model, handlers);
  const body = element('div', 'sandbox-body');
  if (model.tab === 'extraction') {
    renderExtraction(body, model, handlers);
  } else {
    renderWhatIf(body, model, handlers);
  }
  container.append(body);
}
