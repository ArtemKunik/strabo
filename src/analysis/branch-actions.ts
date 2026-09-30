import { listBranches } from './branches.ts';
import { assertRepository } from './review.ts';
import { run } from '../process.ts';

/**
 * The Git operations Strabo performs on the operator's behalf: push a branch, drop the
 * stale local branches a listing already identified, and build the URL that opens a new
 * merge request on the branch's forge.
 *
 * The rest of Strabo only reads; these three are explicit, guarded actions. The safety
 * rules mirror the ones the read-only rework kept:
 *
 * - No value ever reaches a shell; `execFile` passes an argument vector.
 * - A branch or remote name is matched against a strict pattern *before* it is passed, so it
 *   can never be read as an option (`--force`, `--upload-pack=…`).
 * - The push is a normal push — never forced — so a diverged upstream is reported, not
 *   overwritten. A branch with no upstream is published with `--set-upstream`.
 * - A branch is only dropped when the listing already calls it stale: its upstream is gone,
 *   or it is fully merged into the base. The checked-out and base branches are never dropped.
 * - Credential prompts are disabled, the process is time-bounded, and a failure is classified.
 *
 * The merge-request URL is built from the remote URL alone; no forge token is stored and no
 * request reaches the forge from the server. Opening the URL is the browser's job.
 */

const ACTION_TIMEOUT_MS = 120_000;
/** First character is alphanumeric, which rules out a leading `-` being read as an option. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type BranchActionName = 'fetch' | 'pull' | 'push' | 'sync' | 'drop';

export type BranchActionReason =
  | 'no-git'
  | 'git-error'
  | 'timeout'
  | 'auth'
  | 'unknown-branch'
  | 'unknown-remote'
  | 'no-remote'
  | 'no-upstream'
  | 'not-current'
  | 'not-fast-forward'
  | 'not-stale'
  | 'dirty'
  | 'unknown-forge';

export interface BranchActionFailure {
  available: false;
  action: BranchActionName;
  reason: BranchActionReason;
  detail: string;
}

export interface PushResult {
  available: true;
  action: 'push';
  branch: string;
  /** The remote the branch was sent to. */
  remote: string;
  /** True when the branch had no upstream and one was set by this push. */
  published: boolean;
  /** One line for the status bar. */
  message: string;
  /** Bounded command output, for the panel. */
  output: string;
}

/** A branch the drop action refused, and why. */
export interface DropSkip {
  name: string;
  reason: BranchActionReason;
  detail?: string;
}

export interface DropResult {
  available: true;
  action: 'drop';
  /** The local branches that were deleted. */
  dropped: string[];
  /** The branches that were left alone, each with the reason. */
  skipped: DropSkip[];
  message: string;
  output: string;
}

export type BranchPushResult = PushResult | BranchActionFailure;
export type BranchDropResult = DropResult | BranchActionFailure;

/** The remotes a fetch contacted, and its bounded output. */
export interface FetchResult {
  available: true;
  action: 'fetch';
  /** The remote(s) contacted. */
  remotes: string[];
  message: string;
  output: string;
}

/**
 * A pull that fast-forwarded a branch, or found it already up to date. `fastForwarded` says
 * whether the branch moved; a diverged branch is a {@link BranchActionFailure} instead.
 */
export interface PullResult {
  available: true;
  action: 'pull';
  branch: string;
  remote: string;
  /** True when the branch was advanced to its upstream. */
  fastForwarded: boolean;
  message: string;
  output: string;
}

/** A sync: fetch, fast-forward when behind, then push when ahead. */
export interface SyncResult {
  available: true;
  action: 'sync';
  /** The branch the action ran on, for push and sync. */
  branch: string;
  remote: string;
  fastForwarded: boolean;
  pushed: boolean;
  message: string;
  output: string;
}

export type BranchFetchResult = FetchResult | BranchActionFailure;
export type BranchPullResult = PullResult | BranchActionFailure;
export type BranchSyncResult = SyncResult | BranchActionFailure;

export interface MergeRequestSuccess {
  available: true;
  forge: 'github' | 'gitlab' | 'bitbucket';
  /** The forge page that opens a new merge request for the branch. */
  url: string;
  /** The repository's page, for a forge whose new-merge-request URL is not known. */
  webUrl: string;
  branch: string;
  /** The branch the merge request would target, without its remote prefix. */
  base: string;
}

export interface MergeRequestFailure {
  available: false;
  reason: BranchActionReason;
  detail: string;
  webUrl?: string;
}

export type MergeRequestResult = MergeRequestSuccess | MergeRequestFailure;

/** Whether a branch name is safe to pass to Git (no option, no ref-expression). */
export function isSafeBranch(name: string): boolean {
  if (!SAFE_REF.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  return true;
}

/**
 * Push one local branch to its upstream, publishing it and setting the upstream when none
 * is configured. The push is never forced, so a diverged branch fails with Git's own reason.
 */
export async function pushBranch(root: string, branch: string): Promise<BranchPushResult> {
  return guard('push', root, async () => {
    if (!isSafeBranch(branch)) {
      return fail('push', 'unknown-branch', `Refusing to push "${branch}".`);
    }
    if (!(await branchExists(root, branch))) {
      return fail('push', 'unknown-branch', `No local branch named "${branch}".`);
    }
    const remotes = await listRemotes(root);
    if (remotes.length === 0) {
      return fail('push', 'no-remote', 'This repository has no configured remote.');
    }

    let remote = await gitValue(root, ['config', '--get', `branch.${branch}.remote`]);
    let merge = await gitValue(root, ['config', '--get', `branch.${branch}.merge`]);
    let published = false;
    if (!remote || !merge) {
      const fallback = defaultRemote(remotes);
      if (!fallback) {
        return fail('push', 'no-remote', 'No remote to publish this branch to.');
      }
      remote = fallback;
      merge = `refs/heads/${branch}`;
      published = true;
    }
    if (!remotes.includes(remote) || !merge.startsWith('refs/heads/')) {
      return fail('push', 'git-error', `"${branch}" has an upstream this tool will not push to.`);
    }

    const { stdout, stderr } = await gitAction(root, [
      'push',
      ...(published ? ['--set-upstream'] : []),
      remote,
      `${branch}:${merge}`,
    ]);
    return {
      available: true,
      action: 'push',
      branch,
      remote,
      published,
      message: `${published ? 'Published' : 'Pushed'} ${branch} to ${remote}.`,
      output: bound([String(stdout), String(stderr)].join('\n').trim()),
    };
  });
}

/**
 * Delete the named local branches, but only the ones the listing already calls stale: an
 * upstream that is gone, or work fully merged into the base. A branch that is checked out,
 * is the base, is remote-only, or is neither stale nor merged is skipped with its reason,
 * never deleted. The deletion is `git branch -D`, because a gone-upstream branch is often
 * unmerged by design; the staleness check upstream of it is what makes that safe.
 */
export async function dropBranches(root: string, names: readonly string[]): Promise<BranchDropResult> {
  return guard('drop', root, async () => {
    const requested = [...new Set(names.map((name) => String(name).trim()).filter(Boolean))];
    const dropped: string[] = [];
    const skipped: DropSkip[] = [];
    if (requested.length === 0) {
      return fail('drop', 'unknown-branch', 'No branches were named to drop.');
    }

    const listing = await listBranches(root);
    if (!listing.available) {
      return fail('drop', listing.reason === 'unknown-revision' ? 'unknown-branch' : 'no-git', listing.detail ?? 'No branches to inspect.');
    }
    const local = new Map(listing.branches.filter((branch) => branch.kind === 'local').map((branch) => [branch.name, branch]));

    const output: string[] = [];
    for (const name of requested) {
      if (!isSafeBranch(name)) {
        skipped.push({ name, reason: 'unknown-branch', detail: `Refusing to drop "${name}".` });
        continue;
      }
      const branch = local.get(name);
      if (!branch) {
        skipped.push({ name, reason: 'unknown-branch', detail: `No local branch named "${name}".` });
        continue;
      }
      if (branch.current) {
        skipped.push({ name, reason: 'not-current', detail: `"${name}" is checked out.` });
        continue;
      }
      if (branch.isBase) {
        skipped.push({ name, reason: 'not-stale', detail: `"${name}" is the base being compared against.` });
        continue;
      }
      const stale = branch.upstream?.gone === true || branch.againstBase?.merged === true;
      if (!stale) {
        skipped.push({
          name,
          reason: 'not-stale',
          detail: `"${name}" has a live upstream and unmerged work.`,
        });
        continue;
      }
      try {
        const { stdout, stderr } = await gitAction(root, ['branch', '-D', name]);
        const text = [String(stdout), String(stderr)].join('\n').trim();
        if (text) output.push(text);
        dropped.push(name);
      } catch (error) {
        skipped.push({ name, reason: 'git-error', detail: firstLine(error) });
      }
    }

    const message = dropped.length > 0
      ? `Dropped ${dropped.length} stale branch(es): ${dropped.join(', ')}.`
      : `No stale branches dropped${skipped.length > 0 ? ` (${skipped.length} skipped)` : ''}.`;
    return { available: true, action: 'drop', dropped, skipped, message, output: bound(output.join('\n')) };
  });
}

/**
 * Fetch every remote the listed branches track, else the default remote, with `--prune`.
 *
 * The counts the Branches panel shows are as fresh as the last fetch, so this is what makes
 * them live. It only updates remote-tracking refs; the working tree is untouched.
 */
export async function fetchBranches(root: string, requestedRemote?: string): Promise<BranchFetchResult> {
  return guard('fetch', root, async () => {
    const remotes = await listRemotes(root);
    if (remotes.length === 0) {
      return fail('fetch', 'no-remote', 'This repository has no configured remote.');
    }

    let targets: string[];
    if (requestedRemote) {
      if (!SAFE_REMOTE.test(requestedRemote) || !remotes.includes(requestedRemote)) {
        return fail('fetch', 'unknown-remote', `Unknown remote "${requestedRemote}".`);
      }
      targets = [requestedRemote];
    } else {
      targets = [...new Set(await upstreamRemotes(root))].filter((remote) => remotes.includes(remote)).sort();
      if (targets.length === 0) {
        const fallback = defaultRemote(remotes);
        targets = fallback ? [fallback] : [];
      }
      if (targets.length === 0) {
        return fail('fetch', 'no-remote', 'No upstream remote to fetch from.');
      }
    }

    const output: string[] = [];
    for (const remote of targets) {
      const { stdout, stderr } = await gitAction(root, ['fetch', '--prune', remote]);
      const text = [String(stdout), String(stderr)].join('\n').trim();
      if (text) output.push(text);
    }
    return {
      available: true,
      action: 'fetch',
      remotes: targets,
      message: `Fetched ${targets.join(', ')}.`,
      output: bound(output.join('\n')),
    };
  });
}

/**
 * Pull a local branch: fetch its upstream and fast-forward it, never pushing.
 *
 * The checked-out branch is advanced with `merge --ff-only` so the working tree follows; any
 * other local branch is advanced through its ref (`git fetch <remote> <remote>:<branch>`),
 * which Git refuses to update when it would not be a fast-forward. A diverged or dirty tree
 * is reported, not merged.
 */
export async function pullBranch(root: string, branch: string): Promise<BranchPullResult> {
  return guard('pull', root, async () => {
    if (!isSafeBranch(branch)) {
      return fail('pull', 'unknown-branch', `Refusing to pull "${branch}".`);
    }
    if (!(await branchExists(root, branch))) {
      return fail('pull', 'unknown-branch', `No local branch named "${branch}".`);
    }
    const remote = await gitValue(root, ['config', '--get', `branch.${branch}.remote`]);
    const merge = await gitValue(root, ['config', '--get', `branch.${branch}.merge`]);
    if (!remote || !merge) {
      return fail('pull', 'no-upstream', `"${branch}" has no upstream to pull from.`);
    }
    const remotes = await listRemotes(root);
    if (!remotes.includes(remote) || !merge.startsWith('refs/heads/')) {
      return fail('pull', 'git-error', `"${branch}" has an upstream this tool will not pull from.`);
    }

    await gitAction(root, ['fetch', '--prune', remote]);
    const upstreamRef = await gitValue(root, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]);
    if (!upstreamRef) {
      return fail('pull', 'no-upstream', `"${branch}" has no upstream to pull from.`);
    }
    const counts = await gitValue(root, ['rev-list', '--left-right', '--count', `${branch}...${upstreamRef}`]);
    const [ahead = 0, behind = 0] = counts.trim().split(/\s+/).map((value) => Number.parseInt(value, 10) || 0);
    if (behind === 0) {
      return {
        available: true,
        action: 'pull',
        branch,
        remote,
        fastForwarded: false,
        message: ahead > 0
          ? `${branch} is ${ahead} commit(s) ahead of ${upstreamRef}; nothing to pull.`
          : `${branch} is already up to date with ${upstreamRef}.`,
        output: '',
      };
    }

    const current = await currentBranch(root);
    if (current === branch) {
      try {
        await gitAction(root, ['merge', '--ff-only', upstreamRef]);
      } catch (error) {
        return classifyMergeFailure(error, 'pull', branch, upstreamRef);
      }
    } else {
      const remoteBranch = merge.slice('refs/heads/'.length);
      try {
        await gitAction(root, ['fetch', remote, `${remoteBranch}:${branch}`]);
      } catch (error) {
        return classifyMergeFailure(error, 'pull', branch, upstreamRef);
      }
    }
    return {
      available: true,
      action: 'pull',
      branch,
      remote,
      fastForwarded: true,
      message: `Fast-forwarded ${branch} to ${upstreamRef}.`,
      output: '',
    };
  });
}

/**
 * Sync the checked-out branch: fetch its upstream, fast-forward when behind (refusing a
 * diverged branch or a dirty tree), then push when ahead.
 */
export async function syncBranch(root: string, branch: string): Promise<BranchSyncResult> {
  return guard('sync', root, async () => {
    if (!isSafeBranch(branch)) {
      return fail('sync', 'unknown-branch', `Refusing to sync "${branch}".`);
    }
    const current = await currentBranch(root);
    if (current !== branch) {
      return fail('sync', 'not-current', `"${branch}" is not checked out; sync only runs on the current branch.`);
    }

    const remote = await gitValue(root, ['config', '--get', `branch.${branch}.remote`]);
    const merge = await gitValue(root, ['config', '--get', `branch.${branch}.merge`]);
    if (!remote || !merge) {
      return fail('sync', 'no-upstream', `"${branch}" has no upstream to sync with.`);
    }

    await gitAction(root, ['fetch', '--prune', remote]);
    const upstreamRef = await gitValue(root, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`]);
    if (!upstreamRef) {
      return fail('sync', 'no-upstream', `"${branch}" has no upstream to sync with.`);
    }
    const counts = await gitValue(root, ['rev-list', '--left-right', '--count', `${branch}...${upstreamRef}`]);
    const [ahead = 0, behind = 0] = counts.trim().split(/\s+/).map((value) => Number.parseInt(value, 10) || 0);

    let fastForwarded = false;
    if (behind > 0) {
      try {
        await gitAction(root, ['merge', '--ff-only', upstreamRef]);
        fastForwarded = true;
      } catch (error) {
        return classifyMergeFailure(error, 'sync', branch, upstreamRef);
      }
    }

    let pushed = false;
    if (!fastForwarded && ahead > 0) {
      await gitAction(root, ['push', remote, `${branch}:${merge}`]);
      pushed = true;
    }

    const message = fastForwarded
      ? `Fast-forwarded ${branch} to ${upstreamRef}.`
      : pushed
        ? `Pushed ${branch} to ${remote}.`
        : `${branch} is already in sync with ${upstreamRef}.`;
    return {
      available: true,
      action: 'sync',
      branch,
      remote,
      fastForwarded,
      pushed,
      message,
      output: '',
    };
  });
}

function classifyMergeFailure(
  error: unknown,
  action: 'pull' | 'sync',
  branch: string,
  upstreamRef: string,
): BranchActionFailure {
  const message = error instanceof Error ? error.message : String(error);
  if (/local changes|would be overwritten|Please commit|Please stash|unstaged|untracked working tree/i.test(message)) {
    const verb = action === 'sync' ? 'syncing' : 'pulling';
    return { available: false, action, reason: 'dirty', detail: `Working tree is not clean; commit or stash before ${verb} ${branch}.` };
  }
  return {
    available: false,
    action,
    reason: 'not-fast-forward',
    detail: `"${branch}" and "${upstreamRef}" have diverged; a fast-forward is not possible.`,
  };
}

/**
 * The forge URL that opens a new merge request for `branch` into `base`, from the remote's
 * URL alone. GitHub, GitLab, and Bitbucket are named; any other host returns its repository
 * page with `unknown-forge` rather than inventing a route it does not know.
 */
export function forgeMergeRequestUrl(remoteUrl: string, branch: string, base: string): MergeRequestResult {
  const parsed = parseRemoteUrl(remoteUrl);
  if (!parsed) {
    return { available: false, reason: 'unknown-remote', detail: `Cannot read a web host from "${remoteUrl}".` };
  }
  const { host, path: repositoryPath } = parsed;
  const webUrl = `https://${host}/${repositoryPath}`;
  const source = encodeURIComponent(branch);
  const target = encodeURIComponent(base);

  if (host === 'github.com' || host.endsWith('.github.com')) {
    return { available: true, forge: 'github', url: `${webUrl}/compare/${target}...${source}?expand=1`, webUrl, branch, base };
  }
  if (host === 'gitlab.com' || host.split('.').includes('gitlab')) {
    return {
      available: true,
      forge: 'gitlab',
      url: `${webUrl}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${source}&merge_request%5Btarget_branch%5D=${target}`,
      webUrl,
      branch,
      base,
    };
  }
  if (host === 'bitbucket.org') {
    return { available: true, forge: 'bitbucket', url: `${webUrl}/pull-requests/new?source=${source}&dest=${target}`, webUrl, branch, base };
  }
  return { available: false, reason: 'unknown-forge', detail: `No merge-request URL is known for ${host}.`, webUrl };
}

/**
 * The merge-request URL for a local branch: the branch's own remote (else the default one),
 * and the base the Branches panel compares against. The base's remote prefix is dropped, so
 * an `origin/main` base becomes a `main` target.
 */
export async function mergeRequest(root: string, branch: string, requestedBase?: string): Promise<MergeRequestResult> {
  if (!isSafeBranch(branch)) {
    return { available: false, reason: 'unknown-branch', detail: `Refusing to open a merge request for "${branch}".` };
  }
  try {
    await assertRepository(root);
  } catch (error) {
    return { available: false, reason: 'no-git', detail: firstLine(error) };
  }

  const listing = await listBranches(root, requestedBase);
  if (!listing.available) {
    return {
      available: false,
      reason: listing.reason === 'unknown-revision' ? 'unknown-branch' : 'no-git',
      detail: listing.detail ?? 'No branches to compare with.',
    };
  }
  const baseName = (requestedBase || listing.base?.name || 'main').replace(/^[^/]+\//, '');

  const remote = (await gitValue(root, ['config', '--get', `branch.${branch}.remote`])) || 'origin';
  const remoteUrl = await gitValue(root, ['config', '--get', `remote.${remote}.url`]);
  if (!remoteUrl) {
    return { available: false, reason: 'no-remote', detail: 'This repository has no configured remote URL.' };
  }
  return forgeMergeRequestUrl(remoteUrl, branch, baseName);
}

/** A remote URL split into its host and repository path: `git@host:group/repo.git` or an HTTP(S)/SSH URL. */
export function parseRemoteUrl(remoteUrl: string): { host: string; path: string } | null {
  const url = String(remoteUrl).trim();
  if (!url) return null;
  let host = '';
  let repositoryPath = '';
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url);
  if (!url.includes('://') && scp) {
    host = scp[1] ?? '';
    repositoryPath = scp[2] ?? '';
  } else {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      repositoryPath = parsed.pathname;
    } catch {
      return null;
    }
  }
  repositoryPath = repositoryPath.replace(/^\/+/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!host || !repositoryPath) return null;
  return { host: host.toLowerCase(), path: repositoryPath };
}

async function guard<T>(
  action: BranchActionName,
  root: string,
  fn: () => Promise<T | BranchActionFailure>,
): Promise<T | BranchActionFailure> {
  try {
    await assertRepository(root);
    return await fn();
  } catch (error) {
    return fail(action, classifyFailure(error), firstLine(error));
  }
}

function classifyFailure(error: unknown): BranchActionReason {
  const failure = error as { killed?: boolean; signal?: string; message?: string };
  const message = failure.message ?? String(error);
  if (/not a git repository|not inside a Git working tree|dubious ownership/i.test(message)) return 'no-git';
  if (failure.killed || failure.signal === 'SIGTERM' || /timed? ?out/i.test(message)) return 'timeout';
  if (/Authentication failed|could not read Username|could not read Password|Permission denied|terminal prompts disabled|invalid username or password|invalid credentials|access denied|repository not found/i.test(message)) {
    return 'auth';
  }
  return 'git-error';
}

function fail(action: BranchActionName, reason: BranchActionReason, detail: string): BranchActionFailure {
  return { available: false, action, reason, detail };
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n').map((line) => line.trim()).find(Boolean) ?? message;
}

function bound(text: string, limit = 4000): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…` : text;
}

async function listRemotes(root: string): Promise<string[]> {
  const stdout = await gitValue(root, ['remote']);
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean).sort();
}

/** Remote names the local branches track, from one `for-each-ref`. */
async function upstreamRemotes(root: string): Promise<string[]> {
  const stdout = await gitValue(root, ['for-each-ref', '--format=%(upstream:remotename)', 'refs/heads']);
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function defaultRemote(remotes: readonly string[]): string | null {
  if (remotes.includes('origin')) return 'origin';
  return remotes.length === 1 ? remotes[0] ?? null : null;
}

async function currentBranch(root: string): Promise<string | null> {
  const name = await gitValue(root, ['symbolic-ref', '-q', '--short', 'HEAD']);
  return name || null;
}

async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

async function gitValue(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await gitAction(root, args);
    return String(stdout).trim();
  } catch {
    return '';
  }
}

function gitAction(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return run('git', args, {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
    timeout: ACTION_TIMEOUT_MS,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}
