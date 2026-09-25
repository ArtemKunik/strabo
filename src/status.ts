import { fingerprint } from './cache/graph-cache.ts';
import { run } from './process.ts';

export interface Freshness {
  indexed: {
    fingerprint: string | null;
    revision: string | null;
    generatedAt: string | null;
  };
  current: {
    fingerprint: string | null;
    revision: string | null;
  };
  behind: number | null;
  stale: boolean;
}

export function revisionFromFingerprint(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const head = value.split(':')[0] ?? '';
  return /^[0-9a-f]{7,40}$/.test(head) ? head : null;
}

export async function computeFreshness(
  root: string,
  indexedFingerprint: string | null,
  generatedAt: string | null,
): Promise<Freshness> {
  const currentFingerprint = await fingerprint(root);
  const indexedRevision = revisionFromFingerprint(indexedFingerprint);
  const currentRevision = revisionFromFingerprint(currentFingerprint);
  return {
    indexed: {
      fingerprint: indexedFingerprint,
      revision: indexedRevision,
      generatedAt,
    },
    current: {
      fingerprint: currentFingerprint,
      revision: currentRevision,
    },
    behind: await commitsBetween(root, indexedRevision, currentRevision),
    stale: currentFingerprint !== indexedFingerprint,
  };
}

async function commitsBetween(
  root: string,
  indexed: string | null,
  current: string | null,
): Promise<number | null> {
  if (!indexed || !current) {
    return null;
  }
  if (indexed === current) {
    return 0;
  }
  try {
    const { stdout } = await run('git', ['rev-list', '--count', `${indexed}..${current}`], {
      cwd: root,
      windowsHide: true,
    });
    const parsed = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
