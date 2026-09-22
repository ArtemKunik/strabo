import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  SETTINGS_KEY,
  applyAppearance,
  defaultSettings,
  effectiveReduceMotion,
  readSettings,
  resolveTheme,
  writeSettings,
} from '../../ui/strabo-settings.js';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = String(value);
    },
    removeItem: (key) => {
      delete data[key];
    },
    _data: data,
  };
}

test('readSettings returns defaults when nothing is stored or the value is corrupt', () => {
  assert.deepEqual(readSettings(fakeStorage()), defaultSettings());
  assert.deepEqual(readSettings(fakeStorage({ [SETTINGS_KEY]: '{not json' })), defaultSettings());
  assert.deepEqual(readSettings(undefined), defaultSettings());
});

test('readSettings ignores unknown values and keeps the valid ones', () => {
  const storage = fakeStorage({
    [SETTINGS_KEY]: JSON.stringify({
      theme: 'neon',
      defaultDetail: 'file',
      labels: false,
      allLabels: 'yes',
      reduceMotion: 'yes',
      extra: 1,
    }),
  });
  assert.deepEqual(readSettings(storage), {
    theme: 'system',
    defaultDetail: 'file',
    labels: false,
    allLabels: false,
    reduceMotion: false,
    commitEnabled: false,
  });
});

test('writeSettings round-trips a sanitized preference set', () => {
  const storage = fakeStorage();
  writeSettings(
    { theme: 'light', defaultDetail: 'file', labels: false, allLabels: true, reduceMotion: true, commitEnabled: true },
    storage,
  );
  assert.deepEqual(readSettings(storage), {
    theme: 'light',
    defaultDetail: 'file',
    labels: false,
    allLabels: true,
    reduceMotion: true,
    commitEnabled: true,
  });
});

test('the commit action is off by default and only a boolean turns it on', () => {
  assert.equal(defaultSettings().commitEnabled, false);
  const storage = fakeStorage({ [SETTINGS_KEY]: JSON.stringify({ commitEnabled: 'yes' }) });
  assert.equal(readSettings(storage).commitEnabled, false);
  const on = fakeStorage({ [SETTINGS_KEY]: JSON.stringify({ commitEnabled: true }) });
  assert.equal(readSettings(on).commitEnabled, true);
});

test('resolveTheme follows the OS only for the system setting', () => {
  assert.equal(resolveTheme('system', true), 'light');
  assert.equal(resolveTheme('system', false), 'dark');
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('light', false), 'light');
});

test('effectiveReduceMotion is on when either the setting or the OS asks', () => {
  assert.equal(effectiveReduceMotion({ reduceMotion: false }, false), false);
  assert.equal(effectiveReduceMotion({ reduceMotion: true }, false), true);
  assert.equal(effectiveReduceMotion({ reduceMotion: false }, true), true);
});

test('applyAppearance writes the resolved theme and reduce-motion attributes', () => {
  const root = { dataset: {} };
  const matchMedia = (query) => ({ matches: query.includes('prefers-color-scheme: light') });

  const theme = applyAppearance({ theme: 'system', reduceMotion: false }, { root, matchMedia });
  assert.equal(theme, 'light');
  assert.equal(root.dataset.theme, 'light');
  assert.equal(root.dataset.reduceMotion, undefined);

  applyAppearance({ theme: 'dark', reduceMotion: true }, { root, matchMedia });
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(root.dataset.reduceMotion, '1');

  applyAppearance({ theme: 'dark', reduceMotion: false }, { root, matchMedia });
  assert.equal(root.dataset.reduceMotion, undefined);
});
