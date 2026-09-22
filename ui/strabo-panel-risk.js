/**
 * The change impact passport and the dependency-risk panel.
 *
 * Split out of strabo-panels.js.
 */

import {
  orderAdvisories,
  riskSummary,
} from './strabo-core.js';

import {
  complexityValue,
  filePassportCells,
  impactFunctionLabel,
  passportHeading,
  riskBandLabel,
  riskTone,
  totalsPassportCells,
} from './strabo-impact.js';

import { button, unavailableNote } from './strabo-panel-kit.js';


/**
 * The Change impact passport: the current-graph risk surface plus the deltas a change
 * produced. Rendered for one file, or rolled up for a change set or revision. Every value
 * comes from the server's recorded facts; a missing measure is a dash with its reason.
 */
export function renderImpactPassport(container, set, handlers = {}) {
  container.replaceChildren();
  if (!set || !Array.isArray(set.files) || set.files.length === 0) {
    container.append(unavailableNote('No impact passport was recorded.'));
    return;
  }

  const heading = document.createElement('h4');
  heading.textContent = passportHeading(set.scope);
  container.append(heading);

  const caption = document.createElement('p');
  caption.className = 'unavailable';
  caption.textContent = set.baseline
    ? `Current graph; compared with ${set.baseline}.`
    : 'Current graph; no baseline revision was available.';
  container.append(caption);

  if (set.scope === 'file') {
    container.append(impactCard(set.files[0], false));
    return;
  }

  container.append(impactCard(set.totals, true));
  const list = document.createElement('ul');
  list.className = 'impact-files';
  list.dataset.role = 'impact-files';
  for (const file of set.files) {
    list.append(impactFileRow(file, handlers));
  }
  container.append(list);

  if (set.capped) {
    container.append(unavailableNote('Only the first files in the change set were measured.'));
  }
}


function impactCard(card, totals) {
  const wrapper = document.createElement('div');
  wrapper.className = 'impact-card';
  wrapper.dataset.role = totals ? 'impact-totals' : 'impact-file-card';

  const grid = document.createElement('div');
  grid.className = 'impact-grid';
  const cells = totals ? totalsPassportCells(card) : filePassportCells(card);
  for (const cell of cells) {
    const item = document.createElement('div');
    item.className = 'impact-cell';
    item.dataset.role = `impact-${cell.key}`;
    const label = document.createElement('div');
    label.className = 'impact-cell-label';
    label.textContent = cell.label;
    const value = document.createElement('div');
    value.className = `impact-cell-value ${cell.tone ?? 'none'}`;
    value.textContent = cell.value;
    const detail = document.createElement('div');
    detail.className = 'impact-cell-detail';
    detail.textContent = cell.detail;
    item.append(label, value, detail);
    grid.append(item);
  }
  wrapper.append(grid);

  wrapper.append(
    impactList(
      'Risk signals',
      (card?.signals ?? []).map((signal) => ({ text: signal.label, detail: signal.detail })),
      'impact-signals',
    ),
  );
  wrapper.append(
    impactList(
      'Most complex functions',
      (card?.mostComplex ?? []).map((fn) => ({
        text: impactFunctionLabel(fn),
        detail: `C${fn.complexity}${fn.delta ? ` (${fn.delta > 0 ? '+' : '−'}C${Math.abs(fn.delta)})` : ''}`,
      })),
      'impact-most-complex',
    ),
  );

  return wrapper;
}


function impactList(title, entries, role) {
  const section = document.createElement('div');
  section.className = 'impact-list';
  const heading = document.createElement('h5');
  heading.textContent = title;
  section.append(heading);
  if (entries.length === 0) {
    section.append(unavailableNote('None recorded.'));
    section.dataset.role = role;
    return section;
  }
  const list = document.createElement('ul');
  list.dataset.role = role;
  for (const entry of entries) {
    const item = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = entry.text;
    item.append(text);
    if (entry.detail) {
      const detail = document.createElement('span');
      detail.className = 'evidence';
      detail.textContent = entry.detail;
      item.append(detail);
    }
    list.append(item);
  }
  section.append(list);
  return section;
}


function impactFileRow(file, handlers) {
  const item = document.createElement('li');
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'link';
  link.dataset.path = file.path;
  link.textContent = file.previousPath ? `${file.previousPath} → ${file.path}` : file.path;
  if (handlers.onSelect) {
    link.addEventListener('click', () => handlers.onSelect(file.path));
  } else {
    link.disabled = true;
  }
  item.append(link);

  const risk = document.createElement('span');
  risk.className = `impact-risk-band ${file.risk ? riskTone(file.risk.band) : 'none'}`;
  risk.textContent = file.risk ? `${riskBandLabel(file.risk.band)} ${file.risk.score}` : '—';
  item.append(risk);

  const cx = document.createElement('span');
  cx.className = 'evidence';
  cx.textContent = `${complexityValue(file.complexity?.maxAfter)} · coherence ${file.coherence ? `${file.coherence.score}/100` : '—'}`;
  item.append(cx);
  return item;
}


/**
 * Dependency risk: advisories, license policy, and the files that import each package.
 *
 * A finding is shown only as far as the scan can justify it: the dependency version comes
 * from a lockfile, the importing files come from recorded imports, and impact is reverse
 * reachability. When online lookup is off the panel says so rather than showing an empty
 * advisory list that would read as a clean bill of health.
 */
export function renderRisk(container, report, handlers = {}) {
  container.replaceChildren();

  const title = document.createElement('h3');
  title.textContent = 'Dependency risk';
  container.append(title);
  if (handlers.onClose) {
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'panel-dismiss';
    dismiss.setAttribute('aria-label', 'Close risk panel');
    dismiss.textContent = '×';
    dismiss.addEventListener('click', () => handlers.onClose());
    title.append(dismiss);
  }

  if (!report || report.available === false) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'risk-unavailable';
    note.textContent = 'Risk report unavailable.';
    container.append(note);
    return;
  }

  const summary = document.createElement('p');
  summary.className = 'overlay-summary';
  summary.dataset.role = 'risk-summary';
  summary.textContent = riskSummary(report);
  container.append(summary);

  const online = document.createElement('p');
  online.className = report.online ? 'evidence' : 'unavailable';
  online.dataset.role = 'risk-mode';
  online.textContent = report.online
    ? 'Advisory and license data from OSV.dev and deps.dev.'
    : 'Online advisory and license lookup is off; showing inventory and imports only.';
  container.append(online);

  if (report.inventory.undeclared.length > 0) {
    const undeclared = document.createElement('p');
    undeclared.className = 'unavailable';
    undeclared.dataset.role = 'risk-undeclared';
    undeclared.textContent = `${report.inventory.undeclared.length} imported package(s) are not declared in any manifest: ${report.inventory.undeclared.slice(0, 8).join(', ')}`;
    container.append(undeclared);
  }

  const advisories = orderAdvisories(report.advisories);
  const heading = document.createElement('h4');
  heading.textContent = `Advisories (${advisories.length})`;
  container.append(heading);

  if (advisories.length === 0) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'risk-advisories-empty';
    note.textContent = report.online
      ? 'No known advisories for the resolved dependencies.'
      : 'Advisories were not looked up.';
    container.append(note);
  } else {
    const list = document.createElement('ul');
    list.dataset.role = 'risk-advisories';
    for (const advisory of advisories) {
      const item = document.createElement('li');
      item.className = `risk-advisory severity-${advisory.severity}`;
      item.dataset.role = 'risk-advisory';

      const line = document.createElement('div');
      const severity = document.createElement('span');
      severity.className = `risk-severity severity-${advisory.severity}`;
      severity.textContent = advisory.severity;
      line.append(severity);

      const link = document.createElement('a');
      link.className = 'link';
      link.href = advisory.url;
      link.target = '_blank';
      link.rel = 'noopener';
      link.textContent = advisory.id;
      line.append(link);
      if (advisory.aliases.length > 0) {
        const aliases = document.createElement('span');
        aliases.className = 'evidence';
        aliases.textContent = advisory.aliases.join(', ');
        line.append(aliases);
      }
      item.append(line);

      const subject = document.createElement('p');
      subject.className = 'evidence';
      subject.textContent = `${advisory.dependency.name}@${advisory.dependency.version ?? 'unresolved'} · ${advisory.summary}`;
      item.append(subject);

      if (advisory.fixed.length > 0) {
        const fixed = document.createElement('p');
        fixed.className = 'evidence';
        fixed.textContent = `Fixed in: ${advisory.fixed.join(', ')}`;
        item.append(fixed);
      }

      if (advisory.importedBy.length > 0) {
        const files = document.createElement('p');
        files.className = 'evidence';
        files.textContent = `Imported by: ${advisory.importedBy.join(', ')}`;
        item.append(files);
      } else {
        const files = document.createElement('p');
        files.className = 'unavailable';
        files.textContent = 'No source file imports this package directly.';
        item.append(files);
      }

      const impacted = advisory.impactedFiles.filter((entry) => entry.distance > 0);
      if (impacted.length > 0) {
        const list = document.createElement('ul');
        list.dataset.role = 'risk-impact';
        for (const entry of impacted.slice(0, 20)) {
          const entryItem = document.createElement('li');
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'link';
          button.textContent = entry.id;
          if (handlers.onSelect) {
            button.addEventListener('click', () => handlers.onSelect(entry.id));
          }
          entryItem.append(button);
          const distance = document.createElement('span');
          distance.className = 'evidence';
          distance.textContent = `· distance ${entry.distance}`;
          entryItem.append(distance);
          list.append(entryItem);
        }
        item.append(list);
      }
      list.append(item);
    }
    container.append(list);
  }

  const flagged = report.licenses.filter((entry) => entry.denied || entry.risk !== 'permissive');
  const licenseHeading = document.createElement('h4');
  licenseHeading.textContent = `Licenses needing review (${flagged.length})`;
  container.append(licenseHeading);
  if (flagged.length === 0) {
    const note = document.createElement('p');
    note.className = 'unavailable';
    note.dataset.role = 'risk-licenses-empty';
    note.textContent = report.online
      ? 'No denied or copyleft licenses were found.'
      : 'Licenses were not looked up.';
    container.append(note);
  } else {
    const list = document.createElement('ul');
    list.dataset.role = 'risk-licenses';
    for (const entry of flagged.slice(0, 50)) {
      const item = document.createElement('li');
      const label = `${entry.dependency.name}@${entry.dependency.version ?? 'unresolved'} · ${entry.licenses.join(' OR ') || 'no license recorded'}`;
      const span = document.createElement('span');
      span.textContent = label;
      item.append(span);
      const risk = document.createElement('span');
      risk.className = entry.denied ? 'risk-severity severity-critical' : 'evidence';
      risk.textContent = entry.denied ? 'denied' : entry.risk;
      item.append(risk);
      list.append(item);
    }
    container.append(list);
  }

  if (report.caveats.length > 0) {
    const caveats = document.createElement('p');
    caveats.className = 'unavailable';
    caveats.dataset.role = 'risk-caveats';
    caveats.textContent = report.caveats.join(' ');
    container.append(caveats);
  }
}
