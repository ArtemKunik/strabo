import { assertRepository } from './review.ts';
import { run } from '../process.ts';

/**
 * The few Git operations Strabo performs on the operator's behalf: fetch, push, and a
 * fast-forward-only sync. Everything else here stays read-only.
 *
 * Safety rules, in order:
 * - No value ever reaches a shell; `execFile` passes an argument vector.
 * - A branch or remote name is matched against a strict pattern *before* it is passed, so
 *   it can never be read as an option (`--force`, `--upload-pack=…`).
 * - The tool never force-pushes, never rebases, and sync only fast-forwards: a diverged
 *   branch is reported, not merged.
 * - Credential prompts are disabled, so an unauthenticated push fails with a reason rather
 *   than hanging on an invisible prompt.
 * - The process is time-bounded and its failure is classified for the panel.
 */

const ACTION_TIMEOUT_MS = 120_000;
/** First character is alphanumeric, which rules out a leading `-` being read as an option. */
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type BranchActionName = 'fetch' | 'push' | 'pull' | 'sync';

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
  | 'dirty'
  | 'not-fast-forward';

export interface BranchActionFailure {
  available: false;
  action: BranchActionName;
  reason: BranchActionReason;
  detail: string;
}

export interface BranchActionResult {
  available: true;
  action: BranchActionName;
  /** The branch the action ran on, for push and sync. */
  branch?: string;
  /** The remote(s) contacted. */
  remotes: string[];
  /** True when sync updated the working tree with a fast-forward. */
  fastForwarded: boolean;
  /** True when commits were sent to a remote. */
  pushed: boolean;
  /** One line for the status bar. */
  message: string;
  /** Bounded command output, for the panel. */
  output: string;
}

/** Whether a branch name is safe to pass to Git (no option, no ref-expression). */
export function isSafeBranch(name: string): boolean {
  if (!SAFE_REF.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  return true;
}

/** Fetch every remote the listed branches track, else the default remote. */
export async function fetchBranches(root: string, requestedRemote?: string): Promise<BranchActionResult | BranchActionFailure> {
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
      const { stdout } = await gitAction(root, ['fetch', '--prune', remote]);
      const text = String(stdout).trim();
      if (text) output.push(text);
    }
    return {
      available: true,
      action: 'fetch',
      remotes: targets,
      fastForwarded: false,
      pushed: false,
      message: `Fetched ${targets.join(', ')}.`,
      output: bound(output.join('\n')),
    };
  });
}

/** Push one local branch to its upstream, publishing it when no upstream is set. */
export async function pushBranch(root: string, branch: string): Promise<BranchActionResult | BranchActionFailure> {
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
    let setUpstream = false;
    if (!remote || !merge) {
      const fallback = defaultRemote(remotes);
      if (!fallback) {
        return fail('push', 'no-remote', 'No remote to publish this branch to.');
      }
      remote = fallback;
      merge = `refs/heads/${branch}`;
      setUpstream = true;
    }
    if (!remotes.includes(remote) || !merge.startsWith('refs/heads/')) {
      return fail('push', 'git-error', `"${branch}" has an upstream this tool will not push to.`);
    }

    const { stdout, stderr } = await gitAction(root, [
      'push',
      ...(setUpstream ? ['--set-upstream'] : []),
      remote,
      `${branch}:${merge}`,
    ]);
    return {
      available: true,
      action: 'push',
      branch,
      remotes: [remote],
      fastForwarded: false,
      pushed: true,
      message: `${setUpstream ? 'Published' : 'Pushed'} ${branch} to ${remote}.`,
      output: bound([String(stdout), String(stderr)].join('\n').trim()),
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
export async function pullBranch(root: string, branch: string): Promise<BranchActionResult | BranchActionFailure> {
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
        remotes: [remote],
        fastForwarded: false,
        pushed: false,
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
      remotes: [remote],
      fastForwarded: true,
      pushed: false,
      message: `Fast-forwarded ${branch} to ${upstreamRef}.`,
      output: '',
    };
  });
}

/**
 * Sync the checked-out branch: fetch its upstream, fast-forward when behind (refusing a
 * diverged branch or a dirty tree), then push when ahead.
 */
export async function syncBranch(root: string, branch: string): Promise<BranchActionResult | BranchActionFailure> {
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
      remotes: [remote],
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

async function guard(
  action: BranchActionName,
  root: string,
  fn: () => Promise<BranchActionResult | BranchActionFailure>,
): Promise<BranchActionResult | BranchActionFailure> {
  try {
    await assertRepository(root);
    return await fn();
  } catch (error) {
    return { available: false, action, reason: classifyFailure(error), detail: firstLine(error) };
  }
}

function classifyFailure(error: unknown): BranchActionReason {
  const failure = error as { killed?: boolean; signal?: string; code?: unknown; message?: string };
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
