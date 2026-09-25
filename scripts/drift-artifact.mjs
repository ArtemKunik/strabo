import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectDrift } from '../src/analysis/drift.ts';
import { renderDriftArtifact } from '../src/export/drift-artifact.ts';

/**
 * Phase 31 O4: write the published architecture-drift artifact.
 *
 * Reads the per-revision structural measures through `collectDrift` and renders one
 * self-contained HTML page (inline SVG chart) stamped with the repository's source revision
 * and the build date. The renderer is pure, so re-running on the same revision produces
 * byte-identical output except the build date. The default repository is this checkout, and
 * the default output is `docs/drift/index.html` beside the other generated docs artifacts
 * (`docs/bench/`).
 *
 * Usage:
 *   node scripts/drift-artifact.mjs [path] [--out=<file>] [--limit=<n>]
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function flagValue(argv, name) {
  const prefix = `--${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length).trim();
      return value || undefined;
    }
    if (arg === `--${name}`) {
      const value = (argv[index + 1] ?? '').trim();
      return value.startsWith('-') || !value ? undefined : value;
    }
  }
  return undefined;
}

const argv = process.argv.slice(2);
const positional = argv.find((arg) => !arg.startsWith('-'));
const root = path.resolve(positional ?? repoRoot);
const out = path.resolve(flagValue(argv, 'out') ?? path.join(root, 'docs', 'drift', 'index.html'));
const limit = Number.parseInt(flagValue(argv, 'limit') ?? '8', 10) || 8;

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  process.stderr.write(`drift-artifact: not a directory: ${root}\n`);
  process.exit(1);
}

let revision = null;
try {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim() || null;
} catch {
  revision = null;
}

const repository = path.basename(root);
const generatedAt = new Date().toISOString();
const report = await collectDrift(root, repository, { limit });
const html = renderDriftArtifact(report, { revision, generatedAt, repository });

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);

const recorded = report.available ? report.series.filter((series) => series.points.some((point) => point.value !== null)).length : 0;
process.stdout.write(
  `drift-artifact: wrote ${out} (revision ${revision ?? 'unavailable'}, ${report.points.length} revisions, ${recorded} recorded measures)\n`,
);
