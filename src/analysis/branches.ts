import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Graph } from '../types.ts';
import { buildAdjacency } from './analysis.ts';
import { impactFromPaths, isSafeRevision } from './impact.ts';
import {
  assertRepository,
  getCommit,
  gitFailure,
  mergeChanges,
  parseNameStatus,
  parseNumstat,
  totalChanges,
  type ReviewResult,
} from './review.ts';
import type { BranchDivergence } from './review-types.ts';
import type { TimelineCommit } from './timeline.ts';

const run = promisify(execFile);

const FIELD_SEPARATOR = '\u001f';
const MAX_BRANCHES = 100;
const MAX_BASE_CHANGED = 2000;
/** Local names tried, in order, when the remote names no default branch. */
const CONVENTIONAL_BASES = ['main', 'master', 'trunk', 'develop'];

export interface BranchSync {
  /** The upstream's short name, e.g. `origin/feature`. */
  name: string;
  ahead: number;
  behind: number;
  /** The upstream is configured but no longer exists (deleted on the remote). */
  gone: boolean;
}

export interface BranchSummary {
  /** Short name: `feature/x` for a local branch, `origin/feature/x` for a remote one. */
  name: string;
  kind: 'local' | 'remote';
  /** The branch HEAD points at. */
  current: boolean;
  /** This branch is the base everything else is compared with. */
  isBase: boolean;
  tip: TimelineCommit;
  /** Sync with the configured upstream; null when none is configured. */
  upstream: BranchSync | null;
  /**
   * Divergence from the base; null for the base itself. `merged` means every commit on
   * the branch is already reachable from the base (ahead is zero).
   */
  againstBase: { ahead: number; behind: number; merged: boolean } | null;
}

export interface BranchBase {
  name: string;
  hash: string;
  /** Why this branch is the base: asked for, the remote's default, a conventional name, or HEAD. */
  source: 'requested' | 'remote-default' | 'conventional' | 'current';
}

export type BranchesResult =
  | {
      available: true;
      /** The checked-out branch, or null when HEAD is detached. */
      current: string | null;
      head: string | null;
      base: BranchBase | null;
      branches: BranchSummary[];
      /** True when more branches exist than were listed. */
      capped: boolean;
    }
  | { available: false; reason: 'no-git' | 'git-error' | 'unknown-revision'; detail?: string };

/**
 * Local and remote branches, most recently committed first, each with its sync against
 * its upstream and its divergence from the base.
 *
 * A remote branch that some local branch already tracks is folded into that local branch's
 * upstream column rather than listed twice. Counts come from the local object store: they
 * are as fresh as the last fetch. Strabo never fetches implicitly; the operator asks for a
 * fetch, push, or sync through the Branches panel's actions (`src/analysis/branch-actions.ts`).
 */
export async function listBranches(root: string, requestedBase?: string): Promise<BranchesResult> {
  try {
    await assertRepository(root);
    const head = await resolveCommit(root, 'HEAD');
    const current = (await gitOrEmpty(root, ['symbolic-ref', '-q', '--short', 'HEAD'])).trim() || null;
    const base = await resolveBase(root, requestedBase, current);
    if (requestedBase && !base) {
      return { available: false, reason: 'unknown-revision', detail: `Unknown revision "${requestedBase}".` };
    }

    const rows = await readRefs(root, base?.hash ?? null);
    const tracked = new Set(rows.filter((row) => row.kind === 'local' && row.upstream).map((row) => row.upstream));
    const listed = rows.filter((row) => row.kind === 'local' || !tracked.has(row.name));
    const kept = listed.slice(0, MAX_BRANCHES);

    const againstBase = base
      ? await divergenceFor(root, base.hash, kept)
      : new Map<string, { ahead: number; behind: number }>();

    const branches = kept.map((row): BranchSummary => {
      const isBase = base !== null && row.name === base.name;
      const counts = againstBase.get(row.name);
      return {
        name: row.name,
        kind: row.kind,
        current: row.current,
        isBase,
        tip: row.tip,
        upstream: row.upstream ? parseTrack(row.upstream, row.track) : null,
        againstBase:
          base && !isBase && counts ? { ahead: counts.ahead, behind: counts.behind, merged: counts.ahead === 0 } : null,
      };
    });
    return { available: true, current, head, base, branches, capped: listed.length > kept.length };
  } catch (error) {
    const failure = gitFailure(error);
    return failure.available ? { available: false, reason: 'git-error' } : failure;
  }
}

/**
 * Review a branch against a base: what the branch changed since it left the base, whether
 * it would merge cleanly, and which of the base's newer changes its own files build on.
 *
 * The change set is `merge-base..tip`, the same three-dot comparison a pull request shows,
 * so commits the base gained after the branch left it never appear as the branch's work.
 * Impact is traced through the checked-out graph; `checkedOut` says when that graph is not
 * the branch's own.
 */
export async function reviewBranch(
  root: string,
  graph: Graph,
  branch: string,
  requestedBase?: string,
): Promise<ReviewResult> {
  if (!branch.trim() || !isSafeRevision(branch)) {
    return { available: false, reason: 'unknown-revision', detail: `Unknown revision "${branch}".` };
  }
  try {
    await assertRepository(root);
    const current = (await gitOrEmpty(root, ['symbolic-ref', '-q', '--short', 'HEAD'])).trim() || null;
    const [tip, base, head] = await Promise.all([
      resolveCommit(root, branch),
      resolveBase(root, requestedBase, current),
      resolveCommit(root, 'HEAD'),
    ]);
    if (!tip) {
      return { available: false, reason: 'unknown-revision', detail: `Unknown revision "${branch}".` };
    }
    if (!base) {
      const detail = requestedBase ? `Unknown revision "${requestedBase}".` : 'No base branch to compare with.';
      return { available: false, reason: 'unknown-revision', detail };
    }
    const mergeBase = (await gitOrEmpty(root, ['merge-base', base.hash, tip])).trim();
    if (!mergeBase) {
      return {
        available: false,
        reason: 'git-error',
        detail: `"${branch}" and "${base.name}" share no history.`,
      };
    }

    const [nameStatus, numstat, counts, baseChangedRaw, commit, conflicts] = await Promise.all([
      git(root, ['diff', '--name-status', '-z', '-M', mergeBase, tip]),
      git(root, ['diff', '--numstat', '-z', '-M', mergeBase, tip]),
      git(root, ['rev-list', '--left-right', '--count', `${base.hash}...${tip}`]),
      git(root, ['diff', '--name-only', '-z', mergeBase, base.hash]),
      getCommit(root, tip),
      trialMerge(root, base.hash, tip),
    ]);
    const { files, excluded } = mergeChanges(parseNameStatus(nameStatus), parseNumstat(numstat), graph, 'branch');
    const [behind = 0, ahead = 0] = counts.trim().split(/\s+/).map((value) => Number.parseInt(value, 10) || 0);
    const baseChangedAll = baseChangedRaw.split('\0').filter(Boolean);
    const baseChanged = baseChangedAll.slice(0, MAX_BASE_CHANGED);
    const branchPaths = new Set(files.flatMap((file) => [file.path, ...(file.previousPath ? [file.previousPath] : [])]));

    const divergence: BranchDivergence = {
      branch,
      base: base.name,
      tipHash: tip,
      baseHash: base.hash,
      mergeBase,
      ahead,
      behind,
      baseChanged,
      baseChangedCapped: baseChangedAll.length > baseChanged.length,
      overlap: baseChangedAll.filter((file) => branchPaths.has(file)).sort(),
      conflicts,
      movedUnderneath: movedUnderneath(graph, [...branchPaths], baseChangedAll),
      checkedOut: head === tip,
    };
    return {
      available: true,
      kind: 'branch',
      ref: branch,
      ...(commit ? { commit } : {}),
      branch: divergence,
      files,
      totals: totalChanges(files),
      impact: impactFromPaths(
        graph,
        files.map((file) => file.path),
      ),
      excluded,
    };
  } catch (error) {
    return gitFailure(error);
  }
}

/**
 * Base-side changes the branch's files reach through their imports, nearest first.
 *
 * A breadth-first walk forward from every branch file at once, so each reached node keeps
 * the branch file closest to it. Paths the branch itself changed are left out: they are
 * `overlap`, not code that moved underneath.
 */
export function movedUnderneath(
  graph: Graph,
  branchPaths: readonly string[],
  baseChanged: readonly string[],
): BranchDivergence['movedUnderneath'] {
  const { forward } = buildAdjacency(graph);
  const changedOnBase = new Set(baseChanged);
  const own = new Set(branchPaths);
  const seen = new Map<string, { via: string; distance: number }>();
  let frontier: string[] = [];
  for (const start of [...own].sort()) {
    if (forward.has(start)) {
      seen.set(start, { via: start, distance: 0 });
      frontier.push(start);
    }
  }
  let distance = 0;
  while (frontier.length > 0 && distance < 50) {
    distance += 1;
    const next: string[] = [];
    for (const id of frontier) {
      const via = seen.get(id)?.via ?? id;
      for (const target of forward.get(id) ?? []) {
        if (!seen.has(target)) {
          seen.set(target, { via, distance });
          next.push(target);
        }
      }
    }
    frontier = next;
  }
  return [...seen.entries()]
    .filter(([id]) => changedOnBase.has(id) && !own.has(id))
    .map(([id, entry]) => ({ id, via: entry.via, distance: entry.distance }))
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
}

/** Parse `%(upstream:track,nobracket)`: empty when in sync, `gone`, or `ahead N, behind M`. */
export function parseTrack(name: string, track: string): BranchSync {
  if (/\bgone\b/.test(track)) {
    return { name, ahead: 0, behind: 0, gone: true };
  }
  const ahead = Number.parseInt(/ahead (\d+)/.exec(track)?.[1] ?? '0', 10);
  const behind = Number.parseInt(/behind (\d+)/.exec(track)?.[1] ?? '0', 10);
  return { name, ahead, behind, gone: false };
}

interface RefRow {
  name: string;
  kind: 'local' | 'remote';
  current: boolean;
  tip: TimelineCommit;
  upstream: string;
  track: string;
  /** `ahead behind` against the base, when this Git computed it in the same pass. */
  aheadBehind: string;
}

const REF_FIELDS = [
  '%(refname)',
  '%(refname:short)',
  '%(HEAD)',
  '%(objectname)',
  '%(objectname:short)',
  '%(authorname)',
  '%(authordate:iso-strict)',
  '%(subject)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
];

/**
 * Read every branch in one `for-each-ref`. With a base, Git 2.41+ also counts ahead/behind
 * in that same pass (`%(ahead-behind:)`); an older Git rejects the atom, and the list is
 * read again without it so {@link divergenceFor} can count per branch instead.
 */
async function readRefs(root: string, baseHash: string | null): Promise<RefRow[]> {
  const read = (withCounts: boolean) =>
    git(root, [
      'for-each-ref',
      '--sort=-committerdate',
      `--format=${[...REF_FIELDS, ...(withCounts && baseHash ? [`%(ahead-behind:${baseHash})`] : [])].join('%1f')}`,
      'refs/heads',
      'refs/remotes',
    ]);
  let stdout: string;
  try {
    stdout = await read(true);
  } catch (error) {
    if (!baseHash) throw error;
    stdout = await read(false);
  }
  return parseRefs(stdout);
}

/** Parse the {@link readRefs} output, dropping a remote's symbolic `HEAD`. */
export function parseRefs(stdout: string): RefRow[] {
  const rows: RefRow[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [
      refname = '',
      name = '',
      headMark = '',
      hash = '',
      shortHash = '',
      author = '',
      date = '',
      subject = '',
      upstream = '',
      track = '',
      aheadBehind = '',
    ] = line.split(FIELD_SEPARATOR);
    if (!hash || refname.endsWith('/HEAD')) continue;
    rows.push({
      name,
      kind: refname.startsWith('refs/remotes/') ? 'remote' : 'local',
      current: headMark === '*',
      tip: { hash, shortHash, author, date, subject },
      upstream,
      track,
      aheadBehind: aheadBehind.trim(),
    });
  }
  return rows;
}

/** Ahead/behind against the base per branch: from the listing when present, else `rev-list`. */
async function divergenceFor(
  root: string,
  baseHash: string,
  rows: readonly RefRow[],
): Promise<Map<string, { ahead: number; behind: number }>> {
  const result = new Map<string, { ahead: number; behind: number }>();
  const missing: RefRow[] = [];
  for (const row of rows) {
    const [ahead, behind] = row.aheadBehind.split(/\s+/).map((value) => Number.parseInt(value, 10));
    if (Number.isFinite(ahead) && Number.isFinite(behind)) {
      result.set(row.name, { ahead: ahead as number, behind: behind as number });
    } else {
      missing.push(row);
    }
  }
  const BATCH = 8;
  for (let index = 0; index < missing.length; index += BATCH) {
    await Promise.all(
      missing.slice(index, index + BATCH).map(async (row) => {
        const counts = await gitOrEmpty(root, ['rev-list', '--left-right', '--count', `${baseHash}...${row.tip.hash}`]);
        const [behind, ahead] = counts.trim().split(/\s+/).map((value) => Number.parseInt(value, 10));
        if (Number.isFinite(ahead) && Number.isFinite(behind)) {
          result.set(row.name, { ahead: ahead as number, behind: behind as number });
        }
      }),
    );
  }
  return result;
}

/**
 * The branch to compare with: the one asked for, else the remote's default branch, else a
 * conventional trunk name, else whatever is checked out.
 */
async function resolveBase(root: string, requested: string | undefined, current: string | null): Promise<BranchBase | null> {
  if (requested) {
    if (!isSafeRevision(requested)) return null;
    const hash = await resolveCommit(root, requested);
    return hash ? { name: requested, hash, source: 'requested' } : null;
  }
  const remoteDefault = (await gitOrEmpty(root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])).trim();
  if (remoteDefault) {
    const hash = await resolveCommit(root, remoteDefault);
    if (hash) return { name: remoteDefault, hash, source: 'remote-default' };
  }
  for (const name of CONVENTIONAL_BASES) {
    const hash = await resolveCommit(root, `refs/heads/${name}`);
    if (hash) return { name, hash, source: 'conventional' };
  }
  if (current) {
    const hash = await resolveCommit(root, current);
    if (hash) return { name: current, hash, source: 'current' };
  }
  return null;
}

/**
 * Trial-merge the branch into the base without touching the working tree or the index.
 *
 * `git merge-tree --write-tree` (Git 2.38+) exits 0 for a clean merge and 1 with the
 * conflicted paths listed; anything else, including an older Git that lacks the mode, is
 * reported as unavailable rather than as "no conflicts".
 */
async function trialMerge(root: string, baseHash: string, tip: string): Promise<BranchDivergence['conflicts']> {
  try {
    await run('git', ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', baseHash, tip], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { available: true, clean: true, paths: [] };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; message?: string };
    if (failure.code === 1 && typeof failure.stdout === 'string') {
      return { available: true, clean: false, paths: parseMergeTreeConflicts(failure.stdout) };
    }
    return { available: false, detail: (failure.message ?? String(error)).split('\n')[0] ?? 'trial merge failed' };
  }
}

/** Conflicted paths from `merge-tree --write-tree --name-only -z`: the tree id, then paths. */
export function parseMergeTreeConflicts(stdout: string): string[] {
  const [, ...paths] = stdout.split('\0');
  return [...new Set(paths.filter(Boolean))].sort();
}

async function resolveCommit(root: string, ref: string): Promise<string | null> {
  if (!isSafeRevision(ref)) return null;
  return (await gitOrEmpty(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim() || null;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/** Run a query whose failure only means "no answer" (an unset ref, no merge base). */
async function gitOrEmpty(root: string, args: string[]): Promise<string> {
  try {
    return await git(root, args);
  } catch {
    return '';
  }
}
