/**
 * The Data products panel (J10/J11): product cards (owner, ports, contracts, consumers,
 * conformance), the candidates list, and the ER view.
 *
 * DOM only; all shaping comes from the pure helpers in `strabo-data.js`. A section with
 * nothing recorded says so rather than showing an empty list, and every row names the
 * evidence it came from.
 */

import {
  candidateRows,
  catalogRows,
  classificationRows,
  conformanceRows,
  contractRows,
  dataProductsSummary,
  dbtRows,
  entityRows,
  erRows,
  eventRows,
  productCardLabel,
  productPortRows,
} from './strabo-data.js';

function heading(text, count) {
  const element = document.createElement('h4');
  element.textContent = `${text} (${count})`;
  return element;
}

function unavailable(text) {
  const note = document.createElement('p');
  note.className = 'unavailable';
  note.textContent = text;
  return note;
}

function list(className, rows, fill) {
  const element = document.createElement('ul');
  element.className = className;
  for (const row of rows) {
    const item = document.createElement('li');
    item.className = 'data-row';
    fill(item, row);
    element.append(item);
  }
  return element;
}

/**
 * Render the Data products report into the panel.
 *
 * `handlers.onSelect(id)` opens a dataset or a producing file; the panel calls it only for
 * ids the server recorded, so a click never opens a node the map did not draw.
 */
export function renderProducts(container, report, handlers = {}) {
  container.replaceChildren();

  const title = document.createElement('h3');
  title.textContent = 'Data products';
  container.append(title);

  const summary = document.createElement('p');
  summary.className = 'data-summary';
  summary.dataset.role = 'data-summary';
  summary.textContent = dataProductsSummary(report);
  container.append(summary);

  if (report?.error) {
    container.append(unavailable(report.error));
    return;
  }

  renderProductCards(container, report, handlers);
  renderCandidates(container, report, handlers);
  renderConformance(container, report);
  renderEr(container, report, handlers);
  renderContracts(container, report);
  renderClassifications(container, report);
  renderEvents(container, report);
  renderCatalogs(container, report);
  renderDbt(container, report);
}

function renderProductCards(container, report, handlers) {
  const products = report?.products ?? [];
  container.append(heading('Products', products.length));
  if (products.length === 0) {
    container.append(unavailable('No data product declared. A candidate below is evidence, not a product.'));
    return;
  }

  const element = document.createElement('ul');
  element.className = 'product-cards';
  for (const product of products) {
    const item = document.createElement('li');
    item.className = 'product-card';
    item.dataset.role = 'product-card';
    item.dataset.product = product.id;

    const name = document.createElement('div');
    name.className = 'product-name';
    name.textContent = productCardLabel(product);
    item.append(name);

    const ports = productPortRows(product);
    const portList = document.createElement('div');
    portList.className = 'product-ports';
    portList.dataset.role = 'product-ports';
    portList.textContent =
      ports.length === 0
        ? 'no port declared'
        : ports
            .map(
              (port) =>
                `${port.direction} · ${port.dataset}${port.fields > 0 ? ` (${port.fields} field(s))` : ''}` +
                (port.contract ? ` · ${port.contract}` : ''),
            )
            .join(' · ');
    item.append(portList);

    const consumers = Array.isArray(product.consumers) ? product.consumers : [];
    if (consumers.length > 0) {
      const reader = document.createElement('div');
      reader.className = 'product-consumers';
      reader.dataset.role = 'product-consumers';
      reader.textContent = `${consumers.length} consumer file(s): ${consumers.slice(0, 8).join(', ')}`;
      item.append(reader);
    }

    const findings = product.conformance ?? [];
    if (findings.length > 0) {
      const gap = document.createElement('div');
      gap.className = 'product-conformance';
      gap.dataset.role = 'product-conformance';
      gap.textContent = `${findings.length} conformance finding(s): ${findings.map((finding) => `${finding.field} (${finding.kind})`).join(', ')}`;
      item.append(gap);
    }

    if (handlers.onSelect) {
      for (const port of product.outputPorts ?? []) {
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'product-port-open';
        open.dataset.role = 'product-port-open';
        open.dataset.dataset = port.dataset;
        open.textContent = `Open ${port.dataset}`;
        open.addEventListener('click', () => handlers.onSelect(port.dataset));
        item.append(open);
      }
    }

    element.append(item);
  }
  container.append(element);
}

function renderCandidates(container, report, handlers) {
  const rows = candidateRows(report);
  container.append(heading('Candidates', rows.length));
  if (rows.length === 0) {
    container.append(unavailable('No dataset is shared enough to be a product candidate.'));
    return;
  }
  container.append(
    list('product-candidates', rows, (item, row) => {
      const label = document.createElement('div');
      label.className = 'data-label';
      label.textContent = `${row.dataset} — ${row.kind}`;
      item.append(label);
      const detail = document.createElement('div');
      detail.className = 'data-detail';
      detail.textContent =
        `${row.writers} writer(s) · ${row.readers} reader(s)` +
        (row.owner ? ` · owner ${row.owner} (${row.ownerSource})` : ' · no owner recorded') +
        ` · ${row.detail}`;
      item.append(detail);
      if (handlers.onSelect) {
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'data-open';
        open.textContent = `Open ${row.dataset}`;
        open.addEventListener('click', () => handlers.onSelect(row.dataset));
        item.append(open);
      }
    }),
  );
}

function renderConformance(container, report) {
  const rows = conformanceRows(report);
  container.append(heading('Conformance', rows.length));
  if (rows.length === 0) {
    container.append(unavailable('No declared port disagrees with the recorded implementation.'));
    return;
  }
  container.append(
    list('data-conformance', rows, (item, row) => {
      const label = document.createElement('div');
      label.className = 'data-label';
      label.textContent = `${row.kind}: ${row.field}${row.dataset ? ` on ${row.dataset}` : ''}`;
      item.append(label);
      const detail = document.createElement('div');
      detail.className = 'data-detail';
      detail.textContent =
        `${row.contract}` +
        (row.file ? ` · declared at ${row.file}${row.line ? `:${row.line}` : ''}` : '') +
        ` · ${row.detail}`;
      item.append(detail);
    }),
  );
}

function renderEr(container, report, handlers) {
  const datasets = erRows(report);
  container.append(heading('ER view', datasets.length));
  if (datasets.length === 0) {
    container.append(unavailable('No table or view was recorded in a schema.'));
    return;
  }
  const entities = entityRows(report);
  const element = document.createElement('ul');
  element.className = 'er-view';
  for (const dataset of datasets) {
    const item = document.createElement('li');
    item.className = 'er-table';
    item.dataset.role = 'er-table';
    item.dataset.dataset = dataset.dataset;
    const label = document.createElement('div');
    label.className = 'data-label';
    label.textContent = `${dataset.label} (${dataset.kind})`;
    item.append(label);
    const columns = document.createElement('div');
    columns.className = 'data-detail';
    columns.textContent =
      dataset.columns.length > 0 ? `${dataset.columns.length} column(s): ${dataset.columns.join(', ')}` : 'no column recorded';
    item.append(columns);
    for (const finding of dataset.findings) {
      const findingRow = document.createElement('div');
      findingRow.className = 'er-finding';
      findingRow.dataset.role = 'er-finding';
      findingRow.textContent = `${finding.kind}: ${finding.detail}`;
      item.append(findingRow);
    }
    const producers = entities.filter((entity) => entity.table === dataset.label || entity.table === dataset.dataset);
    for (const entity of producers) {
      const entityRow = document.createElement('div');
      entityRow.className = 'er-entity';
      entityRow.dataset.role = 'er-entity';
      entityRow.textContent = `entity ${entity.entity} · ${entity.file}:${entity.line} (${entity.evidence})`;
      item.append(entityRow);
    }
    if (handlers.onSelect) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'data-open';
      open.textContent = `Open ${dataset.dataset}`;
      open.addEventListener('click', () => handlers.onSelect(dataset.dataset));
      item.append(open);
    }
    element.append(item);
  }
  container.append(element);
}

function renderContracts(container, report) {
  const rows = contractRows(report);
  container.append(heading('Contracts', rows.length));
  if (rows.length === 0) {
    container.append(unavailable('No contract was recorded.'));
    return;
  }
  container.append(
    list('data-contracts', rows, (item, row) => {
      const label = document.createElement('div');
      label.className = 'data-label';
      label.textContent = `${row.id} (${row.format})`;
      item.append(label);
      const detail = document.createElement('div');
      detail.className = 'data-detail';
      detail.textContent =
        `${row.fields} field(s)` +
        (row.twins.length > 0 ? ` · same shape as ${row.twins.join(', ')}` : '');
      item.append(detail);
    }),
  );
}

function renderClassifications(container, report) {
  const rows = classificationRows(report);
  container.append(heading('Classification', rows.length));
  if (rows.length === 0) {
    container.append(unavailable('No classification was declared or derived.'));
    return;
  }
  container.append(
    list('data-classification', rows, (item, row) => {
      const label = document.createElement('div');
      label.className = 'data-label';
      label.textContent = `${row.dataset}${row.field ? `.${row.field}` : ''} — ${row.tag}`;
      item.append(label);
      const detail = document.createElement('div');
      detail.className = 'data-detail';
      detail.textContent =
        row.source === 'derived'
          ? `derived along lineage (${row.pathLength} evidence step(s))`
          : 'declared';
      item.append(detail);
    }),
  );
}

function renderEvents(container, report) {
  const rows = eventRows(report);
  container.append(heading('Events', rows.length));
  if (rows.length === 0) {
    container.append(unavailable('No topic or queue flow was recorded.'));
    return;
  }
  container.append(
    list('data-events', rows, (item, row) => {
      const label = document.createElement('div');
      label.className = 'data-label';
      label.textContent = `${row.topic} (${row.kind})`;
      item.append(label);
      const detail = document.createElement('div');
      detail.className = 'data-detail';
      detail.textContent =
        `${row.producers} producer(s) · ${row.consumers} consumer(s)` +
        (row.contract ? ` · ${row.contract}` : ' · no payload contract resolved');
      item.append(detail);
    }),
  );
}

function renderCatalogs(container, report) {
  const { rows, observed, unobserved } = catalogRows(report);
  container.append(heading('Catalog declarations', rows.length));
  if (rows.length === 0) {
    container.append(unavailable('No exported catalog snapshot was read.'));
    return;
  }
  const note = document.createElement('p');
  note.className = 'data-note';
  note.dataset.role = 'catalog-disagreements';
  note.textContent = `${observed} observed by the scan · ${unobserved} the scan did not observe`;
  container.append(note);
  container.append(
    list('data-catalogs', rows, (item, row) => {
      const label = document.createElement('div');
      label.className = 'data-label';
      label.textContent = `${row.dataset} — ${row.catalog}${row.observed ? '' : ' (not observed)'}`;
      item.append(label);
      const detail = document.createElement('div');
      detail.className = 'data-detail';
      detail.textContent =
        (row.owner ? `owner ${row.owner}` : 'no owner') +
        (row.domain ? ` · domain ${row.domain}` : '') +
        (row.exportedAt ? ` · exported ${row.exportedAt}` : '') +
        ` · ${row.detail}`;
      item.append(detail);
    }),
  );
}

function renderDbt(container, report) {
  const rows = dbtRows(report);
  container.append(heading('dbt projects', rows.length));
  if (rows.length === 0) {
    container.append(unavailable('No dbt project was detected.'));
    return;
  }
  container.append(
    list('data-dbt', rows, (item, row) => {
      const label = document.createElement('div');
      label.className = 'data-label';
      label.textContent = `${row.name} — ${row.root === '.' ? 'repository root' : row.root}`;
      item.append(label);
      const detail = document.createElement('div');
      detail.className = 'data-detail';
      detail.textContent =
        `${row.models} model(s) · ${row.seeds} seed(s) · ${row.snapshots} snapshot(s)` +
        (row.unresolved > 0 ? ` · ${row.unresolved} unresolved ref(s)` : '');
      item.append(detail);
    }),
  );
}
