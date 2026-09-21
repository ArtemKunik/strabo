import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import express from 'express';

import { createStraboRouter } from '../../src/api/router.ts';
import { createSettingsStore } from '../../src/state/settings-store.ts';
import { buildTourRequest, TOUR_EVIDENCE_LIMIT, TOUR_MAX_PARAGRAPHS, TOUR_MIN_PARAGRAPHS } from '../../src/narrator/tour.ts';

const passport = {
  repository: 'system-repo',
  size: { files: 13, edges: 9, directories: 8, tests: 0, diagnostics: 0, excluded: 0 },
  languages: [{ language: 'Kotlin', files: 3 }, { language: 'Rust', files: 4 }],
  entryPoints: [{ file: 'crates/alpha/src/main.rs', reason: 'Cargo.toml bin' }],
  topDirectories: [],
  topFiles: [],
  cycles: { total: 0, largest: [] },
  untested: { total: 0, files: [] },
};

const route = {
  repository: 'system-repo',
  entryPoints: [
    { file: 'crates/alpha/src/main.rs', reason: 'Cargo.toml bin', source: 'crates/alpha/Cargo.toml', unit: 'crates/alpha' },
  ],
  order: [
    { file: 'crates/alpha/src/main.rs', depth: 0, from: null, entry: 'crates/alpha/src/main.rs', entryPoint: true, fanIn: 0, tier: 'unclassified' as const, unit: 'crates/alpha' },
    { file: 'crates/alpha/src/service.rs', depth: 1, from: 'crates/alpha/src/main.rs', entry: 'crates/alpha/src/main.rs', entryPoint: false, fanIn: 2, tier: 'unclassified' as const, unit: 'crates/alpha' },
  ],
  unreached: [{ file: 'crates/beta/src/lib.rs', unit: 'crates/beta', fanIn: 0, tier: 'unclassified' as const }],
  units: [
    {
      summary: { id: 'crates/alpha', name: 'alpha', ecosystem: 'cargo', why: 'crate `alpha`', role: 'library' as const, roleEvidence: 'no frontend evidence', files: 4, routed: 2, unreached: 0, entryPoints: 1 },
      files: [],
      unreached: [],
    },
  ],
  summary: { entryPoints: 1, routed: 2, unreached: 1, units: 1, skipped: 0 },
};

test('the tour instruction asks for a five-to-seven-paragraph guided tour', () => {
  const { instruction } = buildTourRequest(passport, route);
  assert.match(instruction, new RegExp(`${TOUR_MIN_PARAGRAPHS}-to-${TOUR_MAX_PARAGRAPHS}-paragraph`));
  assert.match(instruction, /entry points/);
  assert.match(instruction, /not recorded/);
});

test('the tour evidence carries the recorded passport and route facts', () => {
  const { evidence } = buildTourRequest(passport, route);
  assert.match(evidence, /repository: system-repo/);
  assert.match(evidence, /Kotlin: 3 file\(s\)/);
  assert.match(evidence, /crates\/alpha\/src\/main\.rs \(Cargo\.toml bin; unit crates\/alpha\)/);
  assert.match(evidence, /alpha \[crates\/alpha\]/);
  assert.match(evidence, /1\. crates\/alpha\/src\/service\.rs \[unit crates\/alpha\] \(reached from crates\/alpha\/src\/main\.rs; 2 importer\(s\); tier unclassified\)/);
  assert.match(evidence, /files no entry point reaches: 1/);
});

test('a missing passport or route is stated, not invented', () => {
  const missing = buildTourRequest(null, null);
  assert.match(missing.evidence, /size: not recorded/);
  assert.match(missing.evidence, /languages:\n- not recorded/);
  assert.match(missing.evidence, /none declared by a manifest/);
  assert.match(missing.evidence, /empty: no entry point reaches any file/);
  assert.doesNotMatch(missing.evidence, /undefined|null/);
});

test('a route wider than the tour limit is truncated within the evidence budget', () => {
  const order = Array.from({ length: 400 }, (_, index) => ({
    file: `src/file${String(index).padStart(3, '0')}.ts`,
    depth: index,
    from: index === 0 ? null : 'src/file000.ts',
    entry: 'src/file000.ts',
    entryPoint: index === 0,
    fanIn: 0,
    tier: 'unclassified' as const,
    unit: '.',
  }));
  const { evidence } = buildTourRequest(
    { ...passport, entryPoints: [] },
    { ...route, order, summary: { ...route.summary, routed: order.length } },
  );
  assert.match(evidence, /further file\(s\) not listed/);
  assert.ok(evidence.length <= TOUR_EVIDENCE_LIMIT + 64, `evidence was ${evidence.length} chars`);
});

const created: string[] = [];
const servers: Array<ReturnType<typeof express.application.listen>> = [];

after(() => {
  for (const server of servers) {
    server.close();
  }
  for (const directory of created) {
    try {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // The OS will reclaim the temp directory.
    }
  }
});

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      servers.push(server);
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

test('POST /narrator/tour is inert without a configured narrator', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-tour-'));
  created.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), "import { util } from './util';\nexport const x = util;\n");
  fs.writeFileSync(path.join(root, 'src', 'util.ts'), 'export const util = 1;\n');

  const host = express();
  host.use(express.json());
  host.use(
    '/api/strabo',
    createStraboRouter(
      { workspaceRoot: root, scanCeiling: root },
      undefined,
      createSettingsStore({ file: path.join(root, 'settings.json') }),
      { env: {} },
    ),
  );
  const base = await listen(host);

  const response = await fetch(`${base}/api/strabo/narrator/tour`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, 200);
  const reply = (await response.json()) as { available: boolean; reason?: string };
  assert.equal(reply.available, false);
  assert.equal(reply.reason, 'not-configured');
});
