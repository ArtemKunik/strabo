import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { classifyLicenseExpression, isDeniedLicense, parseDeniedLicenses } from '../../src/index.ts';
import {
  findManifestFiles,
  parseCargoLock,
  parseGradleBuildScript,
  parseGradleVersionCatalog,
  parseMavenPom,
  parseNpmLock,
  parseNpmManifest,
  readDependencies,
} from '../../src/risk/inventory.ts';
import { createOsvClient, fixedVersions, normalizeSeverity, type OsvVulnerability } from '../../src/index.ts';
import { createLicenseClient } from '../../src/index.ts';
import { computeRiskReport } from '../../src/index.ts';
import { npmPackageOf } from '../../src/scan/scan-js.ts';
import { collectPolyglotExternalImports, mavenCoordinateMatches } from '../../src/index.ts';
import type { FetchLike, ResponseCache } from '../../src/index.ts';
import type { Graph } from '../../src/index.ts';

const created: string[] = [];

after(() => {
  for (const directory of created) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function tempDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-risk-'));
  created.push(directory);
  return directory;
}

function memoryCache(): ResponseCache {
  const store = new Map<string, unknown>();
  return {
    get: (key) => (store.has(key) ? (store.get(key) as unknown) : null),
    set: (key, value) => void store.set(key, value),
  };
}

const ok =
  (body: unknown): FetchLike =>
  async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

test('npmPackageOf extracts the package from bare specifiers', () => {
  assert.equal(npmPackageOf('lodash'), 'lodash');
  assert.equal(npmPackageOf('lodash/fp'), 'lodash');
  assert.equal(npmPackageOf('@scope/pkg'), '@scope/pkg');
  assert.equal(npmPackageOf('@scope/pkg/sub'), '@scope/pkg');
  assert.equal(npmPackageOf('node:fs'), null);
  assert.equal(npmPackageOf('data:text/javascript,1'), null);
  assert.equal(npmPackageOf('#internal'), null);
  assert.equal(npmPackageOf('./local'), null);
  assert.equal(npmPackageOf('/rooted'), null);
});

test('parseNpmLock reads lockfile v3 packages, direct, and dev flags', () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'app',
        dependencies: { lodash: '^4.0.0' },
        devDependencies: { vitest: '^1.0.0' },
      },
      'node_modules/lodash': { version: '4.17.21' },
      'node_modules/@scope/pkg': { version: '2.0.0' },
      'node_modules/a/node_modules/nested': { version: '1.0.0' },
      'node_modules/vitest': { version: '1.6.0', dev: true },
    },
  };
  const dependencies = parseNpmLock(JSON.stringify(lock), 'package-lock.json');
  const byName = new Map(dependencies.map((entry) => [entry.name, entry]));

  assert.equal(byName.get('lodash')?.version, '4.17.21');
  assert.equal(byName.get('lodash')?.direct, true);
  assert.equal(byName.get('@scope/pkg')?.direct, false);
  assert.equal(byName.get('nested')?.version, '1.0.0');
  assert.equal(byName.get('vitest')?.dev, true);
});

test('parseNpmLock reads the nested v1 dependency tree', () => {
  const lock = {
    lockfileVersion: 1,
    dependencies: {
      lodash: { version: '4.17.20', dependencies: { nested: { version: '1.0.0' } } },
    },
  };
  const names = parseNpmLock(JSON.stringify(lock), 'package-lock.json').map((entry) => entry.name);
  assert.deepEqual(names.sort(), ['lodash', 'nested']);
});

test('parseNpmManifest leaves versions unresolved because ranges are not exact', () => {
  const entries = parseNpmManifest(
    JSON.stringify({ dependencies: { lodash: '^4.17.0' }, devDependencies: { vitest: '^1.0.0' } }),
    'package.json',
  );
  assert.deepEqual(entries.map((entry) => [entry.name, entry.version, entry.dev ?? false]), [
    ['lodash', null, false],
    ['vitest', null, true],
  ]);
});

test('parseCargoLock skips local path packages and marks direct crates', () => {
  const lock = [
    '[[package]]',
    'name = "serde"',
    'version = "1.0.200"',
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    '',
    '[[package]]',
    'name = "local-crate"',
    'version = "0.1.0"',
    '',
  ].join('\n');
  const manifest = ['[dependencies]', 'serde = "1.0"', ''].join('\n');

  const dependencies = parseCargoLock(lock, 'Cargo.lock', manifest);
  assert.deepEqual(dependencies.map((entry) => [entry.name, entry.version, entry.direct]), [
    ['serde', '1.0.200', true],
  ]);
});

test('parseMavenPom resolves properties, drops test scope marking, and reports caveats', () => {
  const pom = [
    '<project>',
    '  <properties><guava.version>32.0.0-jre</guava.version></properties>',
    '  <dependencies>',
    '    <dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>${guava.version}</version></dependency>',
    '    <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency>',
    '    <dependency><groupId>no.version</groupId><artifactId>thing</artifactId></dependency>',
    '  </dependencies>',
    '</project>',
  ].join('\n');

  const parsed = parseMavenPom(pom, 'pom.xml');
  assert.deepEqual(
    parsed.dependencies.map((entry) => [entry.name, entry.version, entry.dev ?? false]),
    [
      ['com.google.guava:guava', '32.0.0-jre', false],
      ['junit:junit', '4.13.2', true],
      ['no.version:thing', null, false],
    ],
  );
  assert.equal(parsed.caveats.length, 1);
});

test('collectPolyglotExternalImports records Rust crates and JVM packages only', () => {
  const files = ['src/lib.rs', 'src/Main.java'];
  const content = new Map([
    ['src/lib.rs', ['use serde::Deserialize;', 'use crate::local::Thing;', 'extern crate tokio;'].join('\n')],
    ['src/Main.java', ['import java.util.List;', 'import com.fasterxml.jackson.databind.ObjectMapper;'].join('\n')],
  ]);
  const imports = collectPolyglotExternalImports(files, content);

  assert.deepEqual(
    imports.map((entry) => [entry.package, entry.ecosystem, entry.kind]),
    [
      ['serde', 'cargo', 'use'],
      ['tokio', 'cargo', 'extern-crate'],
      ['com.fasterxml.jackson.databind', 'maven', 'import'],
    ],
  );
});

test('mavenCoordinateMatches maps a package to a groupId conservatively', () => {
  assert.equal(mavenCoordinateMatches('com.google.guava', 'com.google.guava:guava'), true);
  assert.equal(mavenCoordinateMatches('com.google.common.collect', 'com.google.guava:guava'), false);
  assert.equal(mavenCoordinateMatches('org.junit.jupiter.api', 'org.junit.jupiter:junit-jupiter'), true);
  // A package shorter than the groupId is not a claimed match.
  assert.equal(mavenCoordinateMatches('org.junit', 'org.junit.jupiter:junit-jupiter'), false);
});

test('classifyLicenseExpression handles atoms, OR, and AND', () => {
  assert.equal(classifyLicenseExpression('MIT'), 'permissive');
  assert.equal(classifyLicenseExpression('MPL-2.0'), 'weak-copyleft');
  assert.equal(classifyLicenseExpression('GPL-3.0-only'), 'strong-copyleft');
  assert.equal(classifyLicenseExpression('Weird-License'), 'unknown');
  // You may choose either branch of an OR, so it takes the least risky.
  assert.equal(classifyLicenseExpression('MIT OR GPL-3.0-only'), 'permissive');
  // Both branches of an AND must be satisfied, so it takes the most risky.
  assert.equal(classifyLicenseExpression('MIT AND GPL-3.0-only'), 'strong-copyleft');
});

test('isDeniedLicense and parseDeniedLicenses apply the policy', () => {
  assert.equal(isDeniedLicense(['GPL-3.0-only']), true);
  assert.equal(isDeniedLicense(['MIT']), false);
  assert.equal(isDeniedLicense(['MIT OR GPL-3.0-only']), true);
  assert.equal(parseDeniedLicenses('MIT,WTFPL').has('MIT'), true);
  assert.equal(parseDeniedLicenses(undefined).has('AGPL-3.0-only'), true);
});

test('createOsvClient batches, fetches details, and normalizes severity', async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    if (url.endsWith('/v1/querybatch')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: [{ vulns: [{ id: 'GHSA-1' }] }, {}] }),
        text: async () => '',
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'GHSA-1',
        summary: 'Prototype pollution',
        database_specific: { severity: 'HIGH' },
        affected: [{ ranges: [{ events: [{ fixed: '4.17.21' }] }] }],
        aliases: ['CVE-2021-23337'],
      }),
      text: async () => '',
    };
  };

  const client = createOsvClient({ fetchImpl, cache: memoryCache() });
  const results = await client.query([
    { ecosystem: 'npm', name: 'lodash', version: '4.17.20' },
    { ecosystem: 'npm', name: 'clean', version: '1.0.0' },
  ]);

  assert.equal(results[0]?.length, 1);
  assert.equal(results[1]?.length, 0);
  assert.equal(normalizeSeverity(results[0]?.[0] ?? { id: '' }), 'high');
  assert.deepEqual(fixedVersions(results[0]?.[0] ?? { id: '' }), ['4.17.21']);
  assert.ok(calls.some((url) => url.endsWith('/v1/vulns/GHSA-1')));
});

test('createOsvClient skips queries without an exact version', async () => {
  let called = false;
  const fetchImpl: FetchLike = async () => {
    called = true;
    return { ok: true, status: 200, json: async () => ({ results: [] }), text: async () => '' };
  };
  const client = createOsvClient({ fetchImpl, cache: memoryCache() });
  const results = await client.query([{ ecosystem: 'npm', name: 'lodash', version: '' }]);
  assert.deepEqual(results, [[]]);
  assert.equal(called, false);
});

test('createLicenseClient reads SPDX licenses and reports unknown versions as null', async () => {
  const fetchImpl: FetchLike = async (url) => {
    if (url.includes('/packages/lodash/')) {
      return { ok: true, status: 200, json: async () => ({ licenses: ['MIT'] }), text: async () => '' };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  const client = createLicenseClient({ fetchImpl, cache: memoryCache() });
  const results = await client.lookup([
    { ecosystem: 'npm', name: 'lodash', version: '4.17.21' },
    { ecosystem: 'npm', name: 'missing', version: '9.9.9' },
  ]);
  assert.deepEqual(results[0]?.licenses, ['MIT']);
  assert.equal(results[1], null);
});

test('readDependencies finds manifests and prefers a lockfile over package.json', () => {
  const root = tempDir();
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { lodash: '^4.0.0' } },
        'node_modules/lodash': { version: '4.17.21' },
      },
    }),
  );
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ dependencies: { lodash: '^4.0.0' } }),
  );

  const manifests = findManifestFiles(root);
  assert.ok(manifests.includes('package-lock.json'));
  assert.ok(manifests.includes('package.json'));

  const { dependencies } = readDependencies(root, manifests);
  // The lockfile's resolved version wins; package.json does not duplicate it.
  assert.deepEqual(dependencies.map((entry) => [entry.name, entry.version]), [['lodash', '4.17.21']]);
});

test('computeRiskReport joins advisories to importing files and their blast radius', async () => {
  const root = tempDir();
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { lodash: '^4.0.0' } },
        'node_modules/lodash': { version: '4.17.20' },
      },
    }),
  );

  const graph: Graph = {
    nodes: [
      { id: 'a.ts', kind: 'module', directory: '.' },
      { id: 'b.ts', kind: 'module', directory: '.' },
    ],
    edges: [
      { source: 'b.ts', target: 'a.ts', kind: 'import', evidence: { line: 1, specifier: './a', resolution: 'exact' } },
    ],
    diagnostics: [],
    excluded: [],
    // b.ts imports a module that imports lodash; only a.ts imports lodash directly.
    externalImports: [
      { file: 'a.ts', line: 1, specifier: 'lodash', package: 'lodash', ecosystem: 'npm', kind: 'import' },
    ],
  };

  const osv = createOsvClient({
    cache: memoryCache(),
    fetchImpl: async (url) => {
      if (url.endsWith('/v1/querybatch')) {
        return { ok: true, status: 200, json: async () => ({ results: [{ vulns: [{ id: 'GHSA-1' }] }] }), text: async () => '' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'GHSA-1',
          summary: 'Prototype pollution',
          database_specific: { severity: 'CRITICAL' },
        }),
        text: async () => '',
      };
    },
  });

  const report = await computeRiskReport(root, graph, {
    online: true,
    osv,
    licenses: createLicenseClient({ cache: memoryCache(), fetchImpl: ok({ licenses: ['MIT'] }) }),
  });

  assert.equal(report.inventory.total, 1);
  assert.equal(report.advisories.length, 1);
  const advisory = report.advisories[0];
  assert.equal(advisory?.severity, 'critical');
  assert.deepEqual(advisory?.importedBy, ['a.ts']);
  // a.ts changed; b.ts imports a.ts, so it is impacted at distance 1.
  assert.deepEqual(advisory?.impactedFiles, [
    { id: 'a.ts', distance: 0 },
    { id: 'b.ts', distance: 1 },
  ]);
  assert.equal(report.licenses[0]?.licenses[0], 'MIT');
  assert.equal(report.summary.critical, 1);
});

test('computeRiskReport is offline by default and says so', async () => {
  const root = tempDir();
  fs.writeFileSync(
    path.join(root, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: '4.17.21' } } }),
  );
  const graph: Graph = { nodes: [], edges: [], diagnostics: [], excluded: [], externalImports: [] };

  const report = await computeRiskReport(root, graph, { online: false });
  assert.equal(report.online, false);
  assert.deepEqual(report.advisories, []);
  assert.ok(report.caveats.some((entry) => /disabled/i.test(entry)));
});

test('Gradle catalogs and build scripts are inventoried, and a lockfile wins over them', () => {
  const catalog = [
    '[versions]',
    'okhttp = "4.12.0"',
    'composeBom = "2024.12.01"',
    '',
    '[libraries]',
    'okhttp = { group = "com.squareup.okhttp3", name = "okhttp", version.ref = "okhttp" }',
    'compose-bom = { module = "androidx.compose:compose-bom", version = { ref = "composeBom" } }',
    'material3 = { group = "androidx.compose.material3", name = "material3" }',
    'gson = "com.google.code.gson:gson:2.11.0"',
  ].join('\n');
  assert.deepEqual(
    parseGradleVersionCatalog(catalog, 'gradle/libs.versions.toml').map((entry) => [entry.name, entry.version]),
    [
      ['com.squareup.okhttp3:okhttp', '4.12.0'],
      ['androidx.compose:compose-bom', '2024.12.01'],
      ['androidx.compose.material3:material3', null],
      ['com.google.code.gson:gson', '2.11.0'],
    ],
  );

  const script = [
    'dependencies {',
    '    implementation(libs.okhttp)',
    '    implementation("io.airlift:aircompressor:0.27")',
    '    testImplementation "io.mockk:mockk:$mockk"',
    '}',
  ].join('\n');
  assert.deepEqual(
    parseGradleBuildScript(script, 'app/build.gradle.kts').map((entry) => [entry.name, entry.version, entry.dev ?? false]),
    [
      ['io.airlift:aircompressor', '0.27', false],
      ['io.mockk:mockk', null, true],
    ],
  );

  const root = tempDir();
  fs.mkdirSync(path.join(root, 'gradle'));
  fs.writeFileSync(path.join(root, 'gradle', 'libs.versions.toml'), catalog);
  fs.writeFileSync(path.join(root, 'gradle.lockfile'), 'com.squareup.okhttp3:okhttp:4.12.0=runtimeClasspath\nempty=\n');
  const locked = readDependencies(root, findManifestFiles(root));
  assert.deepEqual(locked.dependencies.map((entry) => [entry.name, entry.version]), [['com.squareup.okhttp3:okhttp', '4.12.0']]);
});

test('computeRiskReport does not report platform, local, or builtin imports as undeclared', async () => {
  const root = tempDir();
  fs.writeFileSync(
    path.join(root, 'Cargo.toml'),
    '[package]\nname = "app_core"\n\n[dependencies]\nserde_json = "1"\n',
  );
  fs.writeFileSync(
    path.join(root, 'Cargo.lock'),
    [
      '[[package]]',
      'name = "app_core"',
      'version = "0.1.0"',
      '',
      '[[package]]',
      'name = "serde_json"',
      'version = "1.0.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
    ].join('\n'),
  );
  fs.mkdirSync(path.join(root, 'gradle'));
  fs.writeFileSync(
    path.join(root, 'gradle', 'libs.versions.toml'),
    '[libraries]\nokhttp = "com.squareup.okhttp3:okhttp:4.12.0"\n',
  );

  const files = ['src/main.rs', 'src/alerts.rs', 'tests/it.rs', 'app/src/main/java/com/acme/app/Main.kt', 'app/src/main/java/com/acme/app/ui/Screen.kt'];
  const content = new Map([
    ['src/main.rs', ['mod alerts;', 'use alerts::Rule;', 'use serde_json::Value;', 'use tokio::spawn;'].join('\n')],
    ['src/alerts.rs', 'pub struct Rule;'],
    ['tests/it.rs', 'use app_core::alerts;'],
    [
      'app/src/main/java/com/acme/app/Main.kt',
      [
        'package com.acme.app',
        'import android.os.Bundle',
        'import kotlin.math.max',
        'import com.acme.app.ui.Screen',
        'import okhttp3.MediaType.Companion.toMediaType',
        'import retrofit2.Retrofit',
      ].join('\n'),
    ],
    ['app/src/main/java/com/acme/app/ui/Screen.kt', 'package com.acme.app.ui\nclass Screen'],
  ]);
  const graph: Graph = {
    nodes: [],
    edges: [],
    diagnostics: [],
    excluded: [],
    externalImports: [
      ...collectPolyglotExternalImports(files, content, []),
      { file: 'tools/run.js', line: 1, specifier: 'child_process', package: 'child_process', ecosystem: 'npm', kind: 'import' },
    ],
  };

  const report = await computeRiskReport(root, graph, { online: false });
  // Only the genuinely undeclared ones remain: `tokio` and `retrofit2` have no manifest entry.
  assert.deepEqual(report.inventory.undeclared, ['retrofit2', 'tokio']);
});
