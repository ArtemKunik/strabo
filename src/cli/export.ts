import fs from 'node:fs';
import path from 'node:path';

import { resolveRepositoryRoot } from '../boundary/repository-root.ts';
import { getCachedGraph } from '../cache/graph-cache.ts';
import { readEnv } from '../config.ts';
import { exportGraph, type GraphExportFormat } from '../export/graph-export.ts';
import { selectViewModel } from '../export/select-view.ts';
import { exportSite } from '../export/site.ts';
import { renderViewModelSvg } from '../export/svg.ts';
import { describeRepository } from '../repository.ts';

const GRAPH_FORMATS: GraphExportFormat[] = ['json', 'dot', 'mermaid'];

export interface ExportIo {
  write?: (text: string) => void;
  writeError?: (text: string) => void;
}

export async function runExportCommand(
  argv: readonly string[],
  io: ExportIo = {},
): Promise<number> {
  const write = io.write ?? ((text: string) => void process.stdout.write(text));
  const writeError = io.writeError ?? ((text: string) => void process.stderr.write(text));

  if (hasFlag(argv, 'site')) {
    return runSiteExport(argv, writeError);
  }
  const env = readEnv(process.env, argv);
  const format = (flagValue(argv, 'format') ?? 'json').toLowerCase();
  const out = flagValue(argv, 'out');

  if (format !== 'svg' && !GRAPH_FORMATS.includes(format as GraphExportFormat)) {
    writeError(`strabo export: unsupported format "${format}". Use json, dot, mermaid, or svg.\n`);
    return 2;
  }

  const repository = resolveRepositoryRoot({
    workspaceRoot: env.root,
    scanCeiling: env.scanCeiling,
    requested: flagValue(argv, 'repository'),
  });
  const cached = await getCachedGraph(repository.root);
  const descriptor = await describeRepository(repository.root);

  let body: string;
  if (format === 'svg') {
    const depth = numberFlag(argv, 'block-depth');
    const model = selectViewModel({
      root: repository.root,
      descriptor,
      cached,
      view: flagValue(argv, 'view'),
      blockDepth: depth,
      blockPrefix: flagValue(argv, 'block-prefix'),
    });
    body = renderViewModelSvg(model, { title: descriptor.name });
  } else {
    body = exportGraph(cached.report.graph, {
      format: format as GraphExportFormat,
      fingerprint: cached.fingerprint,
      revision: cached.fingerprint?.split(':')[0] ?? null,
      generatedAt: cached.report.scannedAt,
      includeDeclare: hasFlag(argv, 'include-declare'),
    });
  }

  if (out) {
    const target = path.resolve(out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    writeError(`strabo export: wrote ${format} to ${target}\n`);
  } else {
    write(body);
  }
  return 0;
}

async function runSiteExport(
  argv: readonly string[],
  writeError: (text: string) => void,
): Promise<number> {
  const out = flagValue(argv, 'out') ?? 'strabo-site';
  const workspaceRoot = path.resolve(process.env.STRABO_ROOT?.trim() || process.cwd());
  const scanCeiling = path.resolve(process.env.STRABO_SCAN_CEILING?.trim() || workspaceRoot);
  const positionals = argv.filter((arg) => !arg.startsWith('-'));
  const pages = await exportSite({
    workspaceRoot,
    scanCeiling,
    outDir: out,
    repositories: positionals.length > 0 ? positionals : [workspaceRoot],
  });
  writeError(`strabo export: wrote ${pages.length} map(s) to ${path.resolve(out)}\n`);
  return 0;
}

function flagValue(argv: readonly string[], name: string): string | undefined {
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

function numberFlag(argv: readonly string[], name: string): number | undefined {
  const parsed = Number.parseInt(flagValue(argv, name) ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}
