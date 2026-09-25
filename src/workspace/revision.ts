import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { excludedDirectory } from '../scan/exclusions.ts';
import { run } from '../process.ts';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** Extensions the workspace extractors read: contracts, SQL, and DTO or data-access source. */
const RELEVANT_EXTENSIONS = new Set([
  '.proto', '.json', '.yaml', '.yml', '.sql',
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.kt', '.kts', '.java', '.cs', '.rs',
  '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h',
]);

export class RevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevisionError';
  }
}

/** A revision written to a temporary directory, so the file-based extractors can read it. */
export interface MaterializedRevision {
  root: string;
  files: number;
  /** Remove the temporary directory. Safe to call more than once. */
  cleanup(): void;
}

/** A ref must look like a ref: it goes to git as an argument, never to a shell. */
export function assertRef(ref: string): string {
  if (!/^[A-Za-z0-9._/@^~{}-][A-Za-z0-9._/@^~{}:-]*$/.test(ref) || ref.startsWith('-') || ref.includes('..')) {
    throw new RevisionError(`"${ref}" is not a usable revision.`);
  }
  return ref;
}

/**
 * Write the files of one revision that the workspace extractors can read into a temporary
 * directory.
 *
 * Blobs come from `git cat-file --batch`, one process for the whole tree, and are filtered
 * the way the working-tree walk is: generated directories are pruned, and oversized or
 * binary files are left out. Nothing is written into the repository.
 */
export async function materializeRevision(root: string, ref: string): Promise<MaterializedRevision> {
  assertRef(ref);
  let listing: string;
  try {
    const { stdout } = await run('git', ['ls-tree', '-r', '-l', '-z', ref], {
      cwd: root,
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf8',
    });
    listing = stdout;
  } catch {
    throw new RevisionError(`The revision "${ref}" does not exist in ${path.basename(root)}.`);
  }

  const wanted: Array<{ sha: string; file: string }> = [];
  let total = 0;
  for (const entry of listing.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab === -1) {
      continue;
    }
    const [, type, sha, size] = entry.slice(0, tab).trim().split(/\s+/);
    const file = entry.slice(tab + 1);
    if (type !== 'blob' || !sha || !RELEVANT_EXTENSIONS.has(path.posix.extname(file).toLowerCase())) {
      continue;
    }
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes > MAX_FILE_BYTES || total + bytes > MAX_TOTAL_BYTES) {
      continue;
    }
    const directory = path.posix.dirname(file);
    if (directory !== '.' && excludedDirectory(directory)) {
      continue;
    }
    total += bytes;
    wanted.push({ sha, file });
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'strabo-rev-'));
  const materialized: MaterializedRevision = {
    root: directory,
    files: 0,
    cleanup(): void {
      fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };

  try {
    const blobs = await readBlobs(
      root,
      wanted.map((entry) => entry.sha),
    );
    wanted.forEach((entry, index) => {
      const content = blobs[index];
      if (!content || content.includes(0)) {
        return;
      }
      const target = path.join(directory, ...entry.file.split('/'));
      if (!target.startsWith(directory + path.sep)) {
        return;
      }
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        materialized.files += 1;
      } catch {
        // A path the platform cannot represent is left out rather than failing the revision.
      }
    });
  } catch (error) {
    materialized.cleanup();
    throw error;
  }
  return materialized;
}

/** The blobs for these object ids, in order, from one `git cat-file --batch` process. */
function readBlobs(root: string, shas: string[]): Promise<Array<Buffer | null>> {
  if (shas.length === 0) {
    return Promise.resolve([]);
  }
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', () => {
      const output = Buffer.concat(chunks);
      const blobs: Array<Buffer | null> = [];
      let offset = 0;
      while (blobs.length < shas.length && offset < output.length) {
        const newline = output.indexOf(0x0a, offset);
        if (newline === -1) {
          break;
        }
        const header = output.subarray(offset, newline).toString('utf8').split(' ');
        if (header[1] === 'missing' || header.length < 3) {
          blobs.push(null);
          offset = newline + 1;
          continue;
        }
        const size = Number(header[2]);
        blobs.push(output.subarray(newline + 1, newline + 1 + size));
        offset = newline + 1 + size + 1;
      }
      while (blobs.length < shas.length) {
        blobs.push(null);
      }
      resolve(blobs);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(`${shas.join('\n')}\n`);
  });
}
