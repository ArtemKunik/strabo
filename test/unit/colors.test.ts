import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as graph from '../../ui/strabo-core.js';
import { clusterSeriesClass } from '../../ui/strabo-member-map.js';
import { THEMES } from '../../ui/strabo-settings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const stylesPath = path.resolve(here, '..', '..', 'ui', 'styles.css');
const styles = fs.readFileSync(stylesPath, 'utf8');

/** The custom properties declared in the `:root` block that opens at `start`. */
function tokensIn(start) {
  const open = styles.indexOf('{', start);
  const close = styles.indexOf('}', open);
  const body = styles.slice(open + 1, close);
  const tokens = new Map();
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens.set(match[1], match[2].trim());
  }
  return tokens;
}

const darkStart = styles.indexOf(':root {');
const dark = tokensIn(darkStart);
const lightStart = styles.indexOf(":root[data-theme='light']");
const light = tokensIn(lightStart);

/**
 * Every theme's token block, keyed by theme id. `dark` is the bare `:root`; every other
 * theme (the light theme and the colour themes) is a `:root[data-theme='<id>']` block.
 */
const themes = new Map();
themes.set('dark', dark);
for (const match of styles.matchAll(/:root\[data-theme='([^']+)'\]\s*\{/g)) {
  themes.set(match[1], tokensIn(match.index));
}

const STATUS_TOKENS = ['--status-good', '--status-warning', '--status-serious', '--status-critical'];
const TIER_TOKENS = ['frontend', 'api', 'domain', 'data', 'integration', 'infra', 'build', 'tests'].map(
  (tier) => `--tier-${tier}`,
);

function channels(hex) {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((character) => character + character)
          .join('')
      : value;
  return [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16));
}

function luminance(hex) {
  const [r, g, b] = channels(hex).map((channel) => {
    const scaled = channel / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const first = luminance(a);
  const second = luminance(b);
  const [high, low] = first > second ? [first, second] : [second, first];
  return (high + 0.05) / (low + 0.05);
}

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;

/** Remove block and line comments so a colour named in prose is not a colour. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('every colour is defined once: no literals outside a :root block (R10)', () => {
  const offenders = [];
  const lines = styles.split(/\r?\n/);
  let depth = 0;
  let inRoot = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!inRoot && /^:root\b[^{]*\{/.test(trimmed)) {
      inRoot = true;
      depth = 0;
    }
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    if (inRoot) {
      depth += opens - closes;
      if (depth <= 0) {
        inRoot = false;
      }
      return;
    }
    if (COLOR_LITERAL.test(line)) {
      offenders.push(`styles.css:${index + 1}: ${trimmed}`);
    }
  });

  const uiDir = path.resolve(here, '..', '..', 'ui');
  for (const file of fs.readdirSync(uiDir).filter((name) => name.endsWith('.js'))) {
    const source = stripComments(fs.readFileSync(path.join(uiDir, file), 'utf8'));
    source.split(/\r?\n/).forEach((line, index) => {
      if (COLOR_LITERAL.test(line)) {
        offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(offenders, [], `colour literals must live in :root only:\n${offenders.join('\n')}`);
});

test('one name per value: the alias tokens are removed and the scale survives (R12)', () => {
  for (const removed of ['--bg', '--panel', '--muted', '--ink', '--mono']) {
    assert.ok(!dark.has(removed), `${removed} should be removed`);
    assert.ok(!light.has(removed), `${removed} should be removed`);
  }
  for (const kept of ['--bg-1', '--bg-2', '--ink-1', '--ink-3', '--font-mono']) {
    assert.ok(dark.has(kept), `${kept} should survive`);
  }
});

test('alpha comes from a three-step scale and one veiled surface (R13)', () => {
  for (const token of ['--wash', '--hairline', '--veil', '--veiled-surface']) {
    assert.ok(dark.has(token), `${token} should be defined`);
    assert.ok(light.has(token), `${token} should be defined`);
  }
  for (const collapsed of [
    '--chrome',
    '--chrome-strong',
    '--chrome-deep',
    '--chrome-tooltip',
    '--chrome-bar',
    '--chrome-float',
    '--scrim',
  ]) {
    assert.ok(!dark.has(collapsed), `${collapsed} should collapse into --veiled-surface/--veil`);
  }
});

test('the map carries no directory palette: PALETTE and paletteColor are removed', () => {
  assert.ok(!('PALETTE' in graph), 'PALETTE should no longer be exported');
  assert.ok(!('paletteColor' in graph), 'paletteColor should no longer be exported');
  assert.ok(!('paletteKey' in graph), 'paletteKey should no longer be exported');
});

test('the dark status scale clears 3:1 on both surface tokens', () => {
  for (const surface of ['--bg-1', '--bg-2']) {
    const background = dark.get(surface);
    assert.ok(background, `${surface} should be defined`);
    for (const token of STATUS_TOKENS) {
      const value = dark.get(token);
      assert.ok(value, `${token} should be defined`);
      const ratio = contrast(value, background);
      assert.ok(
        ratio >= 3,
        `${token} (${value}) on ${surface} (${background}) is ${ratio.toFixed(2)}:1, below 3:1`,
      );
    }
  }
});

test('every theme defines the same colour tokens as the base dark theme', () => {
  // Fonts, text sizes, and radii are theme-agnostic and live only on the bare `:root`.
  const nonColour = new Set([
    '--font-ui',
    '--font-mono',
    '--text-xs',
    '--text-sm',
    '--text-md',
    '--radius-s',
    '--radius-m',
    '--radius-l',
  ]);
  const expected = [...dark.keys()].filter((key) => !nonColour.has(key)).sort();
  for (const [name, tokens] of themes) {
    const actual = [...tokens.keys()].filter((key) => !nonColour.has(key)).sort();
    assert.deepEqual(actual, expected, `${name} should define the full colour token set`);
  }
});

test('the settings theme list matches the stylesheet theme blocks', () => {
  const explicit = THEMES.filter((theme) => theme !== 'system' && theme !== 'dark').sort();
  const blocks = [...themes.keys()].filter((theme) => theme !== 'dark').sort();
  assert.deepEqual(blocks, explicit, 'every offered theme needs a token block, and vice versa');
});

test('every theme\'s status scale clears 3:1 on both of its surfaces', () => {
  for (const [name, tokens] of themes) {
    for (const surface of ['--bg-1', '--bg-2']) {
      const background = tokens.get(surface);
      assert.ok(background, `${name} ${surface} should be defined`);
      for (const token of STATUS_TOKENS) {
        const value = tokens.get(token);
        assert.ok(value, `${name} ${token} should be defined`);
        const ratio = contrast(value, background);
        assert.ok(
          ratio >= 3,
          `${name} ${token} (${value}) on ${surface} (${background}) is ${ratio.toFixed(2)}:1, below 3:1`,
        );
      }
    }
  }
});

test('the light status scale is defined and distinct from the dark one', () => {
  for (const token of ['--status-good', '--status-warning', '--status-serious', '--status-critical']) {
    assert.ok(light.get(token), `${token} should be defined in the light theme`);
  }
  assert.notEqual(light.get('--status-critical'), dark.get('--status-critical'));
});

test('the old semantic tokens are gone, replaced by the status scale', () => {
  for (const token of ['--ok', '--warn', '--danger', '--cycle']) {
    assert.ok(!dark.has(token), `${token} should be removed in favour of the status scale`);
    assert.ok(!light.has(token), `${token} should be removed in favour of the status scale`);
  }
});

test('the one neutral node fill is defined and equal to the reserved surface', () => {
  assert.equal(dark.get('--node-fill'), '#6b7a8d');
  assert.ok(light.get('--node-fill'));
});

test('the tier hues clear 3:1 on both surfaces in every theme (L10)', () => {
  for (const [name, tokens] of themes) {
    for (const surface of ['--bg-1', '--bg-2']) {
      const background = tokens.get(surface);
      assert.ok(background, `${name} ${surface} should be defined`);
      for (const token of TIER_TOKENS) {
        const value = tokens.get(token);
        assert.ok(value, `${name} ${token} should be defined`);
        const ratio = contrast(value, background);
        assert.ok(
          ratio >= 3,
          `${name} ${token} (${value}) on ${surface} (${background}) is ${ratio.toFixed(2)}:1, below 3:1`,
        );
      }
    }

    const values = TIER_TOKENS.map((token) => tokens.get(token));
    assert.equal(new Set(values).size, 8, `${name}: the eight tier hues should be distinct`);
    const reserved = ['--accent', ...STATUS_TOKENS].map((token) => tokens.get(token));
    for (const value of values) {
      assert.ok(!reserved.includes(value), `${name}: ${value} reuses a reserved accent or status hue`);
    }
  }
});

test('the categorical set is three hues plus a neutral, assigned in fixed order', () => {
  assert.equal(clusterSeriesClass(1), 'series-1');
  assert.equal(clusterSeriesClass(2), 'series-2');
  assert.equal(clusterSeriesClass(3), 'series-3');
  for (const index of [4, 5, 8, 99]) {
    assert.equal(clusterSeriesClass(index), 'series-other');
  }

  const source = fs.readFileSync(path.resolve(here, '..', '..', 'ui', 'strabo-member-map.js'), 'utf8');
  const body = /export function clusterSeriesClass[\s\S]*?\n}/.exec(source);
  assert.ok(body, 'clusterSeriesClass should be defined');
  assert.ok(!body[0].includes('%'), 'clusterSeriesClass must not cycle with a modulo');
});
