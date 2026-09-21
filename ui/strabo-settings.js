/**
 * The Settings panel: client preferences and the runtime server settings.
 *
 * Client preferences (theme, default detail, labels, reduce motion) live in localStorage
 * and take effect immediately. Server settings (the scan ceiling and the online risk
 * switch) are read from `/settings` and written back with `PUT /settings`; the server
 * persists them, so they survive a restart. Whether the ceiling may be widened is a
 * startup-only permission (`STRABO_ALLOW_CEILING_WIDENING` / `--allow-ceiling-widening`)
 * and is shown read-only: a request must never be able to grant itself a wider boundary.
 *
 * `applyAppearance` is the only place that touches the document: it resolves the theme
 * (including `system`) to `dark`/`light`, sets `data-theme`, and sets `data-reduce-motion`
 * when either the preference or the OS asks for it.
 */

import { probeWebGL2, setWebglPreferred, webglPreferred, webglRefused } from './strabo-renderer-preference.js';
import { narratorKeyLabel, narratorModelsLabel, narratorTestLabel } from './strabo-narrator.js';

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

function button(text, onClick) {
  const control = document.createElement('button');
  control.type = 'button';
  control.textContent = text;
  control.addEventListener('click', onClick);
  return control;
}

const LOCK_LABELS = {
  endpoint: 'the endpoint',
  model: 'the model',
  apiKeyEnv: 'the key source',
  budget: 'the request budget',
  sendSource: 'the Send source toggle',
};

/** The "set by STRABO_NARRATOR_MODEL" caption that marks an environment-locked field. */
function lockedNote(envVar, what) {
  const element = document.createElement('span');
  element.className = 'setting-locked';
  element.textContent = `set by ${envVar}`;
  element.title = `${what ?? 'This value'} is set by ${envVar} and cannot be overridden here.`;
  return element;
}

/**
 * Settings → Narrator: the in-app setup for the opt-in narrator.
 *
 * Provider preset, model with Fetch models, API key source (none / environment variable by
 * name / key stored on this machine, write-only), Send source, request budget, and Test
 * connection. Environment-set fields render as locked. `handlers.narratorState` carries the
 * transient UI state (key mode, fetched models, the last test result) that the controller
 * owns so a re-render does not lose it.
 */
function narratorSection(handlers = {}) {
  const group = section('Narrator');
  group.id = 'setting-narrator';
  const view = handlers.narrator;
  const state = handlers.narratorState ?? {};
  if (!view) {
    group.append(note('Loading narrator settings…'));
    return group;
  }
  const locked = view.locked ?? {};

  // Provider preset: fills the endpoint and suggests models; every field stays editable.
  const presets = handlers.presets ?? [];
  const presetSelect = document.createElement('select');
  const currentPresetId =
    state.presetId ??
    presets.find((preset) => preset.endpoint && preset.endpoint === view.endpoint)?.id ??
    'custom';
  for (const preset of presets) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    presetSelect.append(option);
  }
  presetSelect.value = currentPresetId;
  presetSelect.id = 'narrator-preset';
  presetSelect.disabled = Boolean(locked.endpoint || locked.model);
  presetSelect.addEventListener('change', () => {
    const preset = presets.find((candidate) => candidate.id === presetSelect.value);
    handlers.onNarratorState?.({ presetId: presetSelect.value, models: preset?.models ?? [] });
    if (!preset || preset.id === 'custom') {
      return;
    }
    const patch = {};
    if (!locked.endpoint) patch.endpoint = preset.endpoint;
    if (!locked.model && preset.models.length > 0) patch.model = preset.models[0];
    handlers.onNarratorChange?.(patch);
  });
  group.append(field('Provider preset', presetSelect));

  // Endpoint.
  const endpointInput = textInput(view.endpoint ?? '', {
    placeholder: 'https://api.example.com/v1/chat/completions',
    readOnly: Boolean(locked.endpoint),
  });
  endpointInput.id = 'narrator-endpoint';
  group.append(field('Endpoint', endpointInput));
  if (locked.endpoint) {
    group.append(lockedNote(locked.endpoint, 'The endpoint'));
  }

  // Model with Fetch models.
  const modelInput = textInput(view.model ?? '', {
    placeholder: 'model id',
    readOnly: Boolean(locked.model),
  });
  modelInput.id = 'narrator-model';
  const modelList = document.createElement('datalist');
  modelList.id = 'narrator-model-options';
  for (const model of state.models ?? []) {
    const option = document.createElement('option');
    option.value = model;
    modelList.append(option);
  }
  modelInput.setAttribute('list', modelList.id);
  const fetchButton = button('Fetch models', () => {
    fetchButton.disabled = true;
    Promise.resolve(handlers.onFetchModels?.({ endpoint: endpointInput.value.trim(), model: modelInput.value.trim() }))
      .then((result) => handlers.onNarratorState?.({ models: result?.models ?? [], modelsNote: narratorModelsLabel(result) }))
      .catch((error) => handlers.onNarratorState?.({ modelsNote: error.message ?? 'Could not list models.' }))
      .finally(() => {
        fetchButton.disabled = false;
      });
  });
  fetchButton.disabled = Boolean(locked.endpoint) || presets.length === 0;
  fetchButton.id = 'narrator-fetch-models';
  const modelRow = document.createElement('div');
  modelRow.className = 'setting-row';
  modelRow.append(modelInput, fetchButton);
  group.append(field('Model', modelRow), modelList);
  if (state.modelsNote) {
    group.append(note(state.modelsNote));
  }
  if (locked.model) {
    group.append(lockedNote(locked.model, 'The model'));
  }

  // API key source: none / environment variable by name / key stored on this machine.
  const keyMode = state.keyMode ?? (locked.apiKeyEnv ? 'env' : view.apiKeyEnv ? 'env' : view.key?.storedSet ? 'stored' : 'none');
  const keySelect = document.createElement('select');
  for (const [value, text] of [
    ['none', 'None (local endpoints)'],
    ['env', 'Environment variable'],
    ['stored', 'Stored on this machine'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    keySelect.append(option);
  }
  keySelect.value = keyMode;
  keySelect.id = 'narrator-key-source';
  keySelect.disabled = Boolean(locked.apiKeyEnv);
  group.append(field('API key source', keySelect));
  group.append(note(narratorKeyLabel(view.key)));

  if (keyMode === 'env') {
    const envInput = textInput(view.apiKeyEnv ?? 'STRABO_NARRATOR_API_KEY', {
      placeholder: 'STRABO_NARRATOR_API_KEY',
      readOnly: Boolean(locked.apiKeyEnv),
    });
    envInput.id = 'narrator-key-env';
    const saveEnv = button('Use variable', () => handlers.onNarratorChange?.({ apiKeyEnv: envInput.value.trim() }));
    saveEnv.id = 'narrator-key-env-save';
    const envRow = document.createElement('div');
    envRow.className = 'setting-row';
    envRow.append(envInput, saveEnv);
    group.append(field('Variable name', envRow));
    group.append(note('The panel only shows whether the variable is set, never its value.'));
  } else if (keyMode === 'stored') {
    const keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.id = 'narrator-key';
    keyInput.placeholder = 'paste the key (write-only)';
    keyInput.autocomplete = 'off';
    const storeButton = button('Store key', () => {
      if (!keyInput.value.trim()) {
        return;
      }
      storeButton.disabled = true;
      Promise.resolve(handlers.onStoreKey?.(keyInput.value.trim()))
        .then(() => {
          keyInput.value = '';
        })
        .catch(() => {})
        .finally(() => {
          storeButton.disabled = false;
        });
    });
    storeButton.id = 'narrator-key-store';
    const clearButton = button('Remove stored key', () => handlers.onClearKey?.());
    clearButton.id = 'narrator-key-clear';
    const keyRow = document.createElement('div');
    keyRow.className = 'setting-row';
    keyRow.append(keyInput, storeButton, clearButton);
    group.append(field('Stored key', keyRow));
    group.append(
      note(
        'Stored in the state directory with owner-only permissions, bound to this host. It is never shown again, logged, or sent anywhere but the endpoint.',
      ),
    );
  } else {
    group.append(note('No key is sent. Use this for a local Ollama or LM Studio endpoint.'));
  }

  keySelect.addEventListener('change', () => {
    const next = keySelect.value;
    handlers.onNarratorState?.({ keyMode: next });
    if (next !== 'stored') {
      handlers.onClearKey?.();
    }
    handlers.onNarratorChange?.({ apiKeyEnv: next === 'env' ? view.apiKeyEnv ?? null : null });
  });

  // Send source toggle and request budget.
  const sendSourceToggle = checkboxInput(view.sendSource, (value) => handlers.onNarratorChange?.({ sendSource: value }));
  sendSourceToggle.disabled = Boolean(locked.sendSource);
  group.append(field('Send source', sendSourceToggle));
  group.append(
    note('Off: only recorded facts are sent. On: recorded source snippets are sent too, framed as untrusted data.'),
  );
  if (locked.sendSource) {
    group.append(lockedNote(locked.sendSource, 'The Send source toggle'));
  }

  const budgetInput = document.createElement('input');
  budgetInput.type = 'number';
  budgetInput.min = '1';
  budgetInput.id = 'narrator-budget';
  budgetInput.value = view.requestBudget ?? '';
  budgetInput.readOnly = Boolean(locked.budget);
  const budgetSave = button('Save budget', () =>
    handlers.onNarratorChange?.({ requestBudget: Number.parseInt(budgetInput.value, 10) || null }),
  );
  budgetSave.disabled = Boolean(locked.budget);
  budgetSave.id = 'narrator-budget-save';
  const budgetRow = document.createElement('div');
  budgetRow.className = 'setting-row';
  budgetRow.append(budgetInput, budgetSave);
  group.append(field('Request budget per session', budgetRow));
  if (locked.budget) {
    group.append(lockedNote(locked.budget, 'The request budget'));
  }

  // Test connection: a minimal prompt that reports latency and the model that replied.
  const testButton = button('Test connection', () => {
    testButton.disabled = true;
    Promise.resolve(handlers.onTestConnection?.({ endpoint: endpointInput.value.trim(), model: modelInput.value.trim() }))
      .then((result) => handlers.onNarratorState?.({ test: result }))
      .catch((error) => handlers.onNarratorState?.({ test: { ok: false, reason: 'provider-error', detail: error.message } }))
      .finally(() => {
        testButton.disabled = false;
      });
  });
  testButton.id = 'narrator-test';
  group.append(field('Connection', testButton));
  group.append(note(narratorTestLabel(state.test)));

  // Save the endpoint and model as typed; the preset already saved them, but Custom does not.
  const saveButton = button('Save endpoint and model', () =>
    handlers.onNarratorChange?.({
      ...(locked.endpoint ? {} : { endpoint: endpointInput.value.trim() }),
      ...(locked.model ? {} : { model: modelInput.value.trim() }),
    }),
  );
  saveButton.id = 'narrator-save';
  group.append(saveButton);

  group.append(
    note('The narrator is opt-in. Nothing is contacted until an endpoint and model are set and a request is made.'),
  );
  return group;
}

/**
 * The renderer choice, which is a preference about how the map is drawn rather than how
 * it looks, so it gets its own section.
 *
 * Unlike every other client preference this one cannot apply in place: Cytoscape fixes
 * its renderer when the map is constructed. The toggle therefore reloads, and says so
 * before it is clicked rather than surprising the operator afterwards.
 */
function renderingSection() {
  const group = section('Rendering');
  const available = probeWebGL2();
  const armed = webglPreferred();

  const toggle = checkboxInput(armed, (value) => {
    setWebglPreferred(value);
    window.location.reload();
  });
  toggle.disabled = !available;
  group.append(field('GPU rendering (WebGL2)', toggle));

  if (!available) {
    group.append(
      note('This browser exposes no WebGL2 context, so the map draws on the 2D canvas.'),
    );
    return group;
  }
  if (armed && webglRefused()) {
    group.append(
      note(
        'WebGL failed to start in this tab and the map fell back to the 2D canvas. Open a new tab to try again.',
      ),
    );
    return group;
  }
  group.append(
    note(
      'Draws the map on the GPU. Changing this reloads the page. Diagnostics reports the renderer actually in use.',
    ),
  );
  return group;
}

/**
 * Render the settings form into `container`.
 *
 * `handlers.onPref(key, value)` is called for every client preference change;
 * `onSaveCeiling(valueOrNull)` and `onToggleRisk(boolean)`
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

  container.append(renderingSection());

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
          ? 'Widening is enabled for this process (startup flag), so the ceiling may also be raised above the start boundary.'
          : 'Widening is off for this process: the ceiling can only be narrowed. Restart with STRABO_ALLOW_CEILING_WIDENING=1 (or --allow-ceiling-widening) to permit raising it.',
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
      note(
        'Whether widening is permitted is a startup-only setting, shown here read-only. ' +
          'It is never accepted from the browser, so this panel cannot widen what the server may read.',
      ),
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

  container.append(
    narratorSection({
      narrator: server?.narrator ?? null,
      presets: handlers.presets,
      narratorState: handlers.narratorState,
      onNarratorState: handlers.onNarratorState,
      onNarratorChange: handlers.onNarratorChange,
      onFetchModels: handlers.onFetchModels,
      onTestConnection: handlers.onTestConnection,
      onStoreKey: handlers.onStoreKey,
      onClearKey: handlers.onClearKey,
    }),
  );

  if (status) {
    const line = document.createElement('p');
    line.className = `setting-status${statusError ? ' is-error' : ''}`;
    line.textContent = status;
    container.append(line);
  }
}
