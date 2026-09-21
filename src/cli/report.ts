import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { computeCoverage } from '../analysis/coverage.ts';
import { impactFromPaths } from '../analysis/impact.ts';
import { parseNameStatus } from '../analysis/review.ts';
import type { ReviewStatus } from '../analysis/review-types.ts';
import {
  computeStructuralDiff,
  type StructuralDiff,
  type StructuralDiffResult,
} from '../analysis/structural-diff.ts';
import { resolveRepositoryRoot } from '../boundary/repository-root.ts';
import { getCachedGraph } from '../cache/graph-cache.ts';
import { collectFindings, parseFailOnRules, type CheckRule } from '../check/check.ts';
import { readEnv } from '../config.ts';
import { revisionFromFingerprint } from '../status.ts';
import { collectFailOnValues } from './check.ts';

const run = promisify(execFile);

export interface ReportIo {
  write?: (text: string) => void;
}

export interface ReportChange {
  path: string;
  previousPath?: string;
  status: ReviewStatus;
}

export interface ReportHotspot {
  file: string;
  findings: Array<{ rule: string; detail: string }>;
}

/**
 * The headless PR report: what changed between two revisions, what it can reach, the
 * structural events the two graphs imply, and where the change lands among the recorded
 * findings. Every section is evidence from the scan or Git; a base that cannot be read is
 * named `unavailable`, never shown as an empty diff.
 */
export interface ReportDocument {
  repository: string;
  root: string;
  base: string;
  baseRevision: string | null;
  head: string | null;
  generatedAt: string;
  changedFiles: ReportChange[];
  reach: {
    changed: string[];
    affected: Array<{ id: string; distance: number }>;
    outsideGraph: string[];
  };
  untestedReach: string[];
  hotspotsTouched: ReportHotspot[];
  structural: StructuralDiffResult;
  warnings: string[];
}

export async function runReportCommand(
  argv: readonly string[],
  io: ReportIo = {},
): Promise<number> {
  const write = io.write ?? ((text: string) => void process.stdout.write(text));
  const env = readEnv(process.env, argv);
  const base = flagValue(argv, 'base');
  if (!base) {
    write('strabo report: --base <ref> is required.\n');
    return 1;
  }
  const format = flagValue(argv, 'format') ?? 'md';
  if (format !== 'md' && format !== 'json') {
    write(`strabo report: unsupported --format "${format}" (expected md or json).\n`);
    return 1;
  }

  const repository = resolveRepositoryRoot({
    workspaceRoot: env.root,
    scanCeiling: env.scanCeiling,
    requested: flagValue(argv, 'repository'),
  });
  const cached = await getCachedGraph(repository.root);
  const graph = cached.report.graph;
  const head = revisionFromFingerprint(cached.fingerprint);

  const structural = await computeStructuralDiff(repository.root, base, {
    headGraph: graph,
    headRevision: head,
    repository: repository.name,
  });

  const warnings: string[] = [];
  const changedFiles = structural.available
    ? await readChangedFiles(repository.root, structural.baseRevision, warnings)
    : [];
  const changedPaths = changedFiles.map((change) => change.path);
  const impact = impactFromPaths(graph, changedPaths);

  const coverage = computeCoverage(graph);
  const reached = new Set(coverage.reached);
  const tests = new Set(coverage.testFiles);
  const untestedReach = impact.affected
    .map((entry) => entry.id)
    .filter((id) => !reached.has(id) && !tests.has(id))
    .sort();

  const findings = await collectFindings(repository.root, repository.name, graph, true);
  const hotspotsTouched = changedPaths
    .map((file) => ({
      file,
      findings: findings
        .filter((finding) => finding.node === file || finding.key.includes(file))
        .map((finding) => ({ rule: finding.rule, detail: finding.detail })),
    }))
    .filter((entry) => entry.findings.length > 0);

  const document: ReportDocument = {
    repository: repository.name,
    root: repository.root,
    base,
    baseRevision: structural.available ? structural.baseRevision : null,
    head,
    generatedAt: new Date().toISOString(),
    changedFiles,
    reach: {
      changed: changedPaths,
      affected: impact.affected,
      outsideGraph: impact.outsideGraph,
    },
    untestedReach,
    hotspotsTouched,
    structural,
    warnings,
  };

  const failOn = parseFailOnRules(collectFailOnValues(argv));
  const failed = reportFails(failOn, structural);

  write(format === 'json' ? `${JSON.stringify(document, null, 2)}\n` : renderMarkdown(document));
  return failed ? 1 : 0;
}

/**
 * Which `--fail-on` rules a report can trip. Only the structural events the report itself
 * computes count: cycles introduced (cycle) and wrong-way tier edges added (tier). Any
 * other named rule is inert here, and no rule fails the command by default.
 */
function reportFails(failOn: readonly CheckRule[], structural: StructuralDiffResult): boolean {
  if (!structural.available) {
    return false;
  }
  const { diff } = structural;
  return (
    (failOn.includes('cycles') && diff.cyclesIntroduced.length > 0) ||
    (failOn.includes('layer-violations') && diff.tierEdgesAdded.length > 0)
  );
}

async function readChangedFiles(
  root: string,
  baseRevision: string,
  warnings: string[],
): Promise<ReportChange[]> {
  try {
    const stdout = await git(root, ['diff', '--name-status', '-z', '-M', baseRevision, 'HEAD']);
    return parseNameStatus(stdout)
      .map((change) => ({
        path: change.path,
        ...(change.previousPath ? { previousPath: change.previousPath } : {}),
        status: change.status,
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  } catch (error) {
    warnings.push(`changed files unavailable: ${firstLine(error)}`);
    return [];
  }
}

/* ------------------------------------------------------------------ Markdown */

export function renderMarkdown(document: ReportDocument): string {
  const lines: string[] = [];
  lines.push(`# Strabo report · ${document.repository}`);
  lines.push(
    `Base \`${document.base}\` (${document.baseRevision ?? 'unresolved'}) → HEAD \`${document.head ?? 'unresolved'}\` · ${document.generatedAt}`,
  );
  lines.push('');

  lines.push(`## Changed files (${document.changedFiles.length})`);
  if (document.changedFiles.length === 0) {
    lines.push('- none recorded');
  }
  for (const change of document.changedFiles) {
    const rename = change.previousPath ? ` (from \`${change.previousPath}\`)` : '';
    lines.push(`- \`${change.path}\` — ${change.status}${rename}`);
  }
  lines.push('');

  lines.push(`## Reach (${document.reach.affected.length})`);
  if (document.reach.affected.length === 0) {
    lines.push('- nothing depends on the changed files');
  }
  for (const entry of document.reach.affected) {
    lines.push(`- \`${entry.id}\` — distance ${entry.distance}`);
  }
  if (document.reach.outsideGraph.length > 0) {
    lines.push(`- ${document.reach.outsideGraph.length} changed path(s) outside the scanned graph`);
  }
  lines.push('');

  lines.push('## Structure');
  renderStructure(lines, document.structural);
  lines.push('');

  lines.push(`## Untested reach (${document.untestedReach.length})`);
  if (document.untestedReach.length === 0) {
    lines.push('- every reached file is covered by a test');
  }
  for (const file of document.untestedReach) {
    lines.push(`- \`${file}\``);
  }
  lines.push('');

  lines.push(`## Hotspots touched (${document.hotspotsTouched.length})`);
  if (document.hotspotsTouched.length === 0) {
    lines.push('- no recorded finding names a changed file');
  }
  for (const hotspot of document.hotspotsTouched) {
    for (const finding of hotspot.findings) {
      lines.push(`- \`${hotspot.file}\` — [${finding.rule}] ${finding.detail}`);
    }
  }

  for (const warning of document.warnings) {
    lines.push('');
    lines.push(`> warning: ${warning}`);
  }
  return `${lines.join('\n')}\n`;
}

function renderStructure(lines: string[], structural: StructuralDiffResult): void {
  if (!structural.available) {
    lines.push(
      `- unavailable: ${structural.reason}${structural.detail ? ` — ${structural.detail}` : ''}`,
    );
    return;
  }
  const diff = structural.diff;
  lines.push(`Base \`${structural.baseRevision}\` vs HEAD \`${structural.headRevision ?? 'working tree'}\``);
  if (isStructuralEmpty(diff)) {
    lines.push('- no structural change');
    return;
  }
  section(lines, `Dependency edges added (${diff.edgesAdded.length})`, diff.edgesAdded.map((edge) => `\`${edge.source}\` → \`${edge.target}\` (${edge.kind})`));
  section(lines, `Dependency edges removed (${diff.edgesRemoved.length})`, diff.edgesRemoved.map((edge) => `\`${edge.source}\` → \`${edge.target}\` (${edge.kind})`));
  section(lines, `Cycles introduced (${diff.cyclesIntroduced.length})`, diff.cyclesIntroduced.map(cycleLabel));
  section(lines, `Cycles resolved (${diff.cyclesResolved.length})`, diff.cyclesResolved.map(cycleLabel));
  section(lines, `Wrong-way tier edges added (${diff.tierEdgesAdded.length})`, diff.tierEdgesAdded.map((edge) => `\`${edge.source}\` → \`${edge.target}\` (${edge.kind}, ${edge.unit})`));
  section(lines, `Entry points added (${diff.entryPointsAdded.length})`, diff.entryPointsAdded.map((file) => `\`${file}\``));
  section(lines, `Newly unreached (${diff.newlyUnreached.length})`, diff.newlyUnreached.map((file) => `\`${file}\``));
}

function section(lines: string[], heading: string, items: readonly string[]): void {
  if (items.length === 0) {
    return;
  }
  lines.push(`### ${heading}`);
  for (const item of items) {
    lines.push(`- ${item}`);
  }
}

function cycleLabel(cycle: StructuralDiff['cyclesIntroduced'][number]): string {
  return cycle.members.map((member) => `\`${member}\``).join(' → ');
}

function isStructuralEmpty(diff: StructuralDiff): boolean {
  const counts = diff.counts;
  return (
    counts.edgesAdded === 0 &&
    counts.edgesRemoved === 0 &&
    counts.cyclesIntroduced === 0 &&
    counts.cyclesResolved === 0 &&
    counts.tierEdgesAdded === 0 &&
    counts.entryPointsAdded === 0 &&
    counts.newlyUnreached === 0
  );
}

/* ------------------------------------------------------------------ Helpers */

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
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
