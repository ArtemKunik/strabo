import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { collectDrift } from '../analysis/drift.ts';
import { resolveRepositoryRoot } from '../boundary/repository-root.ts';
import { getCachedGraph } from '../cache/graph-cache.ts';
import { describeRepository } from '../repository.ts';
import { renderDriftArtifact } from './drift-artifact.ts';
import { exportGraph } from './graph-export.ts';
import { selectViewModel } from './select-view.ts';
import { renderViewModelSvg } from './svg.ts';

const run = promisify(execFile);

/** Revisions charted per demo repository; enough to show drift without an unbounded scan. */
const SITE_DRIFT_LIMIT = 8;

export interface SiteExportOptions {
  workspaceRoot: string;
  scanCeiling?: string;
  outDir: string;
  repositories: readonly string[];
  generatedAt?: string;
}

export interface SitePage {
  name: string;
  slug: string;
  revision: string | null;
  nodes: number;
  edges: number;
  /** Whether a drift chart with recorded measures was written for this repository. */
  drift: boolean;
}

export async function exportSite(options: SiteExportOptions): Promise<SitePage[]> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const outDir = path.resolve(options.outDir);
  fs.mkdirSync(outDir, { recursive: true });

  const targets =
    options.repositories.length > 0 ? options.repositories : [options.workspaceRoot];
  const pages: SitePage[] = [];

  for (const requested of targets) {
    const repository = resolveRepositoryRoot({
      workspaceRoot: options.workspaceRoot,
      scanCeiling: options.scanCeiling ?? options.workspaceRoot,
      requested,
    });
    const cached = await getCachedGraph(repository.root);
    const descriptor = await describeRepository(repository.root);
    const slug = slugify(repository.name);
    const directory = path.join(outDir, slug);
    fs.mkdirSync(directory, { recursive: true });

    const model = selectViewModel({ root: repository.root, descriptor, cached, view: 'system' });
    const svg = renderViewModelSvg(model, { title: descriptor.name, generatedAt });
    const revision = cached.fingerprint?.split(':')[0] ?? null;

    // Drift needs the repository's own commit history, so a directory nested inside a larger
    // worktree is reported unavailable rather than charting the enclosing repository.
    const root = path.resolve(repository.root);
    const drift = (await gitWorktreeRoot(root)) === root
      ? await collectDrift(root, descriptor.name, { limit: SITE_DRIFT_LIMIT })
      : null;
    const driftHtml = renderDriftArtifact(drift, {
      revision,
      generatedAt,
      repository: descriptor.name,
      reason: 'not-a-repository-root',
    });

    const json = exportGraph(cached.report.graph, {
      format: 'json',
      fingerprint: cached.fingerprint,
      revision,
      generatedAt,
    });
    const mermaid = exportGraph(cached.report.graph, {
      format: 'mermaid',
      fingerprint: cached.fingerprint,
      revision,
      generatedAt,
    });

    fs.writeFileSync(path.join(directory, 'drift.html'), driftHtml);
    fs.writeFileSync(path.join(directory, 'map.svg'), svg);
    fs.writeFileSync(path.join(directory, 'map.json'), json);
    fs.writeFileSync(path.join(directory, 'map.mmd'), mermaid);
    fs.writeFileSync(
      path.join(directory, 'index.html'),
      renderRepositoryPage(descriptor.name, svg, revision, generatedAt),
    );

    pages.push({
      name: descriptor.name,
      slug,
      revision,
      nodes: cached.report.graph.nodes.length,
      edges: cached.report.graph.edges.length,
      drift: drift !== null && drift.available,
    });
  }

  fs.writeFileSync(path.join(outDir, 'index.html'), renderIndexPage(pages, generatedAt));
  return pages;
}

function renderRepositoryPage(
  name: string,
  svg: string,
  revision: string | null,
  generatedAt: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(name)} — Strabo map</title>
<style>body{margin:0;background:#0c1016;color:#c8d2e0;font-family:ui-sans-serif,system-ui,sans-serif}header{padding:16px 24px;border-bottom:1px solid #2b3444}h1{font-size:18px;margin:0 0 4px}.meta{color:#8b93a7;font-size:13px}.links{margin-top:8px;display:flex;gap:12px}.links a{color:#4c9aff;text-decoration:none;font-size:13px}</style>
</head>
<body>
<header>
<h1>${escapeHtml(name)}</h1>
<p class="meta">indexed at ${escapeHtml(revision ?? 'no revision')} · generated ${escapeHtml(generatedAt)}</p>
<div class="links"><a href="drift.html">Drift</a><a href="map.json">JSON</a><a href="map.mmd">Mermaid</a><a href="map.svg">SVG</a><a href="../">All repositories</a></div>
</header>
${svg}
</body>
</html>
`;
}

function renderIndexPage(pages: SitePage[], generatedAt: string): string {
  const items = pages
    .map(
      (page) =>
        `<li><a href="${escapeHtml(page.slug)}/index.html">${escapeHtml(page.name)}</a> <span>${page.nodes} nodes · ${page.edges} edges · ${escapeHtml(page.revision ?? 'no revision')}${page.drift ? ' · drift' : ''}</span></li>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Strabo demo maps</title>
<style>body{margin:0;padding:32px;background:#0c1016;color:#c8d2e0;font-family:ui-sans-serif,system-ui,sans-serif}h1{font-size:20px}li{margin:8px 0}a{color:#4c9aff;text-decoration:none;font-size:15px}span{color:#8b93a7;font-size:13px;margin-left:8px}.meta{color:#8b93a7;font-size:13px}</style>
</head>
<body>
<h1>Strabo demo maps</h1>
<p class="meta">generated ${escapeHtml(generatedAt)}</p>
<ul>
${items}
</ul>
</body>
</html>
`;
}

/** The worktree root git resolves for `root`, or `null` when `root` is not in a worktree. */
async function gitWorktreeRoot(root: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd: root });
    const toplevel = stdout.trim();
    return toplevel ? path.resolve(toplevel) : null;
  } catch {
    return null;
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'repository';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
