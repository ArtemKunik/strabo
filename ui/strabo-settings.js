/**
 * The Settings panel: client preferences and the runtime server settings.
 *
 * Client preferences (theme, default detail, labels, reduce motion) live in localStorage
 * and take effect immediately. Server settings (the scan ceiling, the widening opt-in, and
 * the online risk switch) are read from `/settings` and written back with `PUT /settings`;
 * the server persists them, so they survive a restart.
 *
 * `applyAppearance` is the only place that touches the document: it resolves the theme
 * (including `system`) to `dark`/`light`, sets `data-theme`, and sets `data-reduce-motion`
 * when either the preference or the OS asks for it.
 */

export const SETTINGS_KEY = 'strabo.settings.v1';

export const THEMES = ['system', 'dark', 'light'];
export const DETAIL_MODES = ['block', 'file'];

/** The client preference defaults, also the shape `readSettings` always returns. */
export function defaultSettings() {
  return { theme: 'system', defaultDetail: 'block', labels: true, reduceMotion: false };
}

function sanitize(parsed, defaults) {
  const settings = { ...defaults };
  if (!parsed || typeof parsed !== 'object') {
    return settings;
  }
  if (THEMES.includes(parsed.theme)) settings.theme = parsed.theme;
  if (DETAIL_MODES.includes(parsed.defaultDetail)) settings.defaultDetail = parsed.defaultDetail;
  if (typeof parsed.labels === 'boolean') settings.labels = parsed.labels;
  if (typeof parsed.reduceMotion === 'boolean') settings.reduceMotion = parsed.reduceMotion;
  return settings;
}

export function readSettings(storage = globalThis.localStorage) {
  const defaults = defaultSettings();
  try {
    const raw = storage?.getItem(SETTINGS_KEY);
    if (!raw) return defaults;
    return sanitize(JSON.parse(raw), defaults);
  } catch {
    return defaults;
  }
}

export function writeSettings(settings, storage = globalThis.localStorage) {
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(sanitize(settings, defaultSettings())));
  } catch {
    // Storage is optional; a blocked quota only costs persistence.
  }
}

/** Resolve `system` to the OS preference; every other value passes through. */
export function resolveTheme(theme, prefersLight = false) {
  if (theme === 'light' || theme === 'dark') return theme;
  return prefersLight ? 'light' : 'dark';
}

/** Reduce motion is on when the preference asks for it or the OS does. */
export function effectiveReduceMotion(settings, prefersReducedMotion = false) {
  return Boolean(settings?.reduceMotion) || Boolean(prefersReducedMotion);
}

/**
 * Apply the appearance preferences to the document.
 *
 * Returns the resolved theme so the caller can restyle anything (the canvas) that reads
 * more than CSS variables. `options` exists so tests can inject a root and a matchMedia.
 */
export function applyAppearance(settings, options = {}) {
  const root = options.root ?? document.documentElement;
  const matchMedia = options.matchMedia ?? globalThis.matchMedia?.bind(globalThis);
  const prefersLight = Boolean(matchMedia?.('(prefers-color-scheme: light)')?.matches);
  const prefersReduced = Boolean(matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  const theme = resolveTheme(settings.theme, prefersLight);
  root.dataset.theme = theme;
  if (effectiveReduceMotion(settings, prefersReduced)) {
    root.dataset.reduceMotion = '1';
  } else {
    delete root.dataset.reduceMotion;
  }
  return theme;
}

/**
 * Watch the OS colour-scheme and reduced-motion preferences, re-applying `settings`
 * whenever they change. Returns a teardown function. Only one listener per query is kept.
 */
export function watchSystemPreferences(settings, onChange) {
  const matchMedia = globalThis.matchMedia?.bind(globalThis);
  if (!matchMedia) {
    return () => {};
  }
  const queries = [
    matchMedia('(prefers-color-scheme: light)'),
    matchMedia('(prefers-reduced-motion: reduce)'),
  ];
  const listeners = queries.map((query) => {
    const handler = () => onChange(settings);
    query.addEventListener?.('change', handler);
    return () => query.removeEventListener?.('change', handler);
  });
  return () => {
    for (const remove of listeners) remove();
  };
}

function field(labelText, control) {
  const wrap = document.createElement('label');
  wrap.className = 'setting-field';
  const label = document.createElement('span');
  label.className = 'setting-label';
  label.textContent = labelText;
  wrap.append(label, control);
  return wrap;
}

function textInput(value, { placeholder = '', readOnly = false } = {}) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value ?? '';
  input.placeholder = placeholder;
  input.readOnly = readOnly;
  input.spellcheck = false;
  return input;
}

function selectInput(value, options, onChange) {
  const select = document.createElement('select');
  for (const [optionValue, text] of options) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = text;
    select.append(option);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function checkboxInput(checked, onChange) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = Boolean(checked);
  input.addEventListener('change', () => onChange(input.checked));
  return input;
}

function section(title) {
  const group = document.createElement('section');
  group.className = 'setting-section';
  const heading = document.createElement('h4');
  heading.textContent = title;
  group.append(heading);
  return group;
}

function note(text) {
  const paragraph = document.createElement('p');
  paragraph.className = 'setting-note';
  paragraph.textContent = text;
  return paragraph;
}

/**
 * Render the settings form into `container`.
 *
 * `handlers.onPref(key, value)` is called for every client preference change;
 * `onSaveCeiling(valueOrNull)`, `onToggleWidening(boolean)`, and `onToggleRisk(boolean)`
 * return promises and may reject with an `Error` whose message is shown inline. The
 * controller re-renders afterwards, so this function does not keep its own copy of the
 * server values.
 */
export function renderSettings(container, handlers = {}) {
  const { prefs = defaultSettings(), server = null, status = null, statusError = false } = handlers;
  container.replaceChildren();

  const heading = document.createElement('h3');
  heading.textContent = 'Settings';
  container.append(heading);

  const local = section('Appearance');
  local.append(
    field(
      'Theme',
      selectInput(prefs.theme, [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']], (value) =>
        handlers.onPref?.('theme', value),
      ),
    ),
    field('Reduce motion', checkboxInput(prefs.reduceMotion, (value) => handlers.onPref?.('reduceMotion', value))),
    field(
      'Default detail',
      selectInput(prefs.defaultDetail, [['block', 'Directories'], ['file', 'Files']], (value) =>
        handlers.onPref?.('defaultDetail', value),
      ),
    ),
    field('Show node labels', checkboxInput(prefs.labels, (value) => handlers.onPref?.('labels', value))),
    note('Preferences are stored in this browser.'),
  );
  container.append(local);

  const remote = section('Server');
  if (!server) {
    remote.append(note('Loading server settings…'));
  } else {
    remote.append(field('Start root', textInput(server.workspaceRoot, { readOnly: true })));

    const ceilingInput = textInput(server.scanCeiling);
    const saveButton = document.createElement('button');
    saveButton.type = 'button';
    saveButton.textContent = 'Save';
    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.textContent = 'Reset';
    resetButton.title = 'Restore the ceiling the server started with';
    const ceilingRow = document.createElement('div');
    ceilingRow.className = 'setting-row';
    ceilingRow.append(ceilingInput, saveButton, resetButton);
    remote.append(field('Scan ceiling', ceilingRow));

    remote.append(
      note(
        server.allowCeilingWidening
          ? 'Saved on the server: the read boundary may be narrowed or widened, and the change survives a restart.'
          : 'Saved on the server: narrowing applies immediately and survives a restart. Widening past the current boundary needs "Allow widening".',
      ),
    );

    const statusLine = document.createElement('p');
    statusLine.className = 'setting-status';
    statusLine.hidden = true;
    remote.append(statusLine);

    const report = (message, isError) => {
      statusLine.hidden = false;
      statusLine.textContent = message;
      statusLine.classList.toggle('is-error', Boolean(isError));
    };

    saveButton.addEventListener('click', () => {
      saveButton.disabled = true;
      Promise.resolve(handlers.onSaveCeiling?.(ceilingInput.value.trim()))
        .then(() => report('Scan ceiling updated.', false))
        .catch((error) => report(error.message ?? 'Could not update the scan ceiling.', true))
        .finally(() => {
          saveButton.disabled = false;
        });
    });
    resetButton.addEventListener('click', () => {
      resetButton.disabled = true;
      Promise.resolve(handlers.onSaveCeiling?.(null))
        .then(() => report('Scan ceiling reset.', false))
        .catch((error) => report(error.message ?? 'Could not reset the scan ceiling.', true))
        .finally(() => {
          resetButton.disabled = false;
        });
    });

    remote.append(
      field(
        'Allow widening',
        checkboxInput(server.allowCeilingWidening, (value) => {
          Promise.resolve(handlers.onToggleWidening?.(value)).catch((error) =>
            report(error.message ?? 'Could not change ceiling widening.', true),
          );
        }),
      ),
    );
    remote.append(
      note('Permits the scan ceiling to grow beyond the boundary the server started with.'),
    );
    remote.append(
      field(
        'Online risk lookup',
        checkboxInput(server.riskOnline, (value) => {
          Promise.resolve(handlers.onToggleRisk?.(value)).catch((error) =>
            report(error.message ?? 'Could not change the risk lookup.', true),
          );
        }),
      ),
    );
    if (server.riskDeniedLicenses && server.riskDeniedLicenses.length > 0) {
      remote.append(note(`Denied licenses: ${server.riskDeniedLicenses.join(', ')}`));
    }
    remote.append(
      note('Enabling the lookup contacts OSV.dev and deps.dev; inventory works without it.'),
    );
  }
  container.append(remote);

  if (status) {
    const line = document.createElement('p');
    line.className = `setting-status${statusError ? ' is-error' : ''}`;
    line.textContent = status;
    container.append(line);
  }
}
