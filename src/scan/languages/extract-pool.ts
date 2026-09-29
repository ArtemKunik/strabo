import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { Diagnostic } from '../../types.ts';
import type { PolyglotLanguage } from './resolvers.ts';
import { EXTRACTORS, type ExtractRequest, type ExtractResponse } from './extract-tasks.ts';

/**
 * A `worker_threads` pool for per-file parse/extract (Phase 18 P4).
 *
 * Parsing is CPU-bound, so one worker per core keeps every core busy; each worker loads its
 * grammars once and parses one file at a time. The main thread hands out tasks to whichever
 * worker is free and collects results by id, then returns them **in input order**, so a
 * parallel scan and a sequential one produce byte-identical facts.
 *
 * The pool is optional: when worker threads are unavailable, or a worker fails to start, the
 * caller falls back to the in-process extractor for that file, which is still correct, only
 * slower. The pool never invents or drops a file's facts.
 */

/** The default pool size: one worker per core, capped so a 64-core host is not swamped. */
export const DEFAULT_POOL_SIZE = Math.max(1, Math.min(os.cpus().length || 1, 8));

/** How long a worker may take on one file before the pool gives up on it. */
const TASK_TIMEOUT_MS = 30_000;

export interface ExtractTask {
  language: PolyglotLanguage;
  file: string;
  content: string;
}

export interface ExtractOutcome {
  facts: unknown;
  diagnostics: Diagnostic[];
  /** True when the in-process extractor was used because no worker answered. */
  fellBack: boolean;
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
  /** The task currently assigned, so a timeout can name it. */
  currentId: number | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// src/scan/languages/ (tsx via type-stripping) or dist/scan/languages/ (.js after build): the
// worker module sits beside this one with the same extension, so the URL follows whichever
// file is running rather than assuming `.ts`.
const WORKER_URL = path.join(here, `extract-worker${path.extname(fileURLToPath(import.meta.url))}`);
void path;

/**
 * Whether the pool should be used.
 *
 * Opt-in, off by default. The Phase 18 P7 measurement on a 20k-file corpus found the pool a
 * **net loss** at that scale: each worker re-initialises the WASM tree-sitter runtime, and on
 * the measured machine grammar startup exceeded the parallel parse gain (parse 2.6-3.0s with
 * the pool versus 1.4s without). The pool is kept because it is correct and helps on hosts
 * where worker startup is cheaper and cores are otherwise idle, but it is enabled only when
 * `STRABO_PARSE_WORKERS=1` is set, never silently. `STRABO_NO_PARSE_WORKERS=1` still forces
 * the in-process path.
 */
export function workersAvailable(): boolean {
  if (process.env.STRABO_NO_PARSE_WORKERS === '1') {
    return false;
  }
  if (process.env.STRABO_PARSE_WORKERS !== '1') {
    return false;
  }
  try {
    return typeof Worker === 'function';
  } catch {
    return false;
  }
}

/**
 * Run every task on the pool and return outcomes in the same order as `tasks`.
 *
 * A task whose worker errors, exits, or times out falls back to the in-process extractor,
 * so a flaky worker never loses a file's facts. The pool is always terminated before
 * returning.
 */
export async function extractWithPool(
  tasks: readonly ExtractTask[],
  poolSize: number = DEFAULT_POOL_SIZE,
): Promise<ExtractOutcome[]> {
  if (tasks.length === 0) {
    return [];
  }
  if (!workersAvailable()) {
    return runInProcess(tasks);
  }

  const size = Math.max(1, Math.min(poolSize, tasks.length));
  let workers: PoolWorker[];
  try {
    workers = Array.from({ length: size }, () => spawnWorker());
  } catch {
    // A sandbox that forbids workers: fall back for the whole batch.
    return runInProcess(tasks);
  }

  const outcomes = new Array<ExtractOutcome>(tasks.length);
  const pending = new Map<number, (response: ExtractResponse) => void>();

  try {
    await Promise.all(
      tasks.map((task, index) =>
        runOne(task, index).then((outcome) => {
          outcomes[index] = outcome;
        }),
      ),
    );
  } finally {
    for (const entry of workers) {
      entry.worker.removeAllListeners();
      void entry.worker.terminate();
    }
  }

  return outcomes;

  /** Acquire a free worker, send one task, and resolve with its response or a timeout. */
  function runOne(task: ExtractTask, id: number): Promise<ExtractOutcome> {
    return new Promise<ExtractOutcome>((resolve) => {
      const slot = acquire();
      if (!slot) {
        // All workers gone: fall back for this file.
        resolve(inProcessOutcome(task, true));
        return;
      }
      slot.busy = true;
      slot.currentId = id;

      const timer = setTimeout(() => {
        pending.delete(id);
        slot.busy = false;
        slot.currentId = null;
        resolve(inProcessOutcome(task, true));
      }, TASK_TIMEOUT_MS);

      pending.set(id, (response) => {
        clearTimeout(timer);
        slot.busy = false;
        slot.currentId = null;
        if (response.ok) {
          resolve({
            facts: response.facts,
            diagnostics: response.diagnostics ?? [],
            fellBack: false,
          });
        } else {
          // The worker answered but the extraction failed (e.g. grammar unavailable): a
          // diagnostic, not a silent drop, and no in-process retry that would repeat it.
          resolve({
            facts: undefined,
            diagnostics: [
              {
                file: task.file,
                line: 1,
                severity: 'warning',
                kind: 'parse-failure',
                message: response.error ?? 'Parse worker failed for this file.',
              },
            ],
            fellBack: false,
          });
        }
      });

      const request: ExtractRequest = {
        id,
        language: task.language,
        file: task.file,
        content: task.content,
      };
      slot.worker.postMessage(request);
    });
  }

  function acquire(): PoolWorker | null {
    return workers.find((entry) => !entry.busy && entry.worker.threadId >= 0) ?? null;
  }

  function spawnWorker(): PoolWorker {
    const worker = new Worker(WORKER_URL);
    const slot: PoolWorker = { worker, busy: false, currentId: null };
    worker.on('message', (response: ExtractResponse) => {
      const resolve = pending.get(response.id);
      if (resolve) {
        pending.delete(response.id);
        resolve(response);
      }
    });
    // A worker that dies mid-task fails its current task, which falls back in-process.
    const fail = (): void => {
      if (slot.currentId !== null) {
        const resolve = pending.get(slot.currentId);
        if (resolve) {
          pending.delete(slot.currentId);
          resolve({ id: slot.currentId, ok: false, error: 'Parse worker exited.' });
        }
      }
      slot.busy = false;
      slot.currentId = null;
    };
    worker.on('error', fail);
    worker.on('exit', fail);
    return slot;
  }
}

/** Run every task on the in-process extractor, preserving order. */
async function runInProcess(tasks: readonly ExtractTask[]): Promise<ExtractOutcome[]> {
  const outcomes: ExtractOutcome[] = [];
  for (const task of tasks) {
    outcomes.push(await inProcessOutcome(task, true));
  }
  return outcomes;
}

/** One task extracted on the main thread; used as the fallback path. */
async function inProcessOutcome(task: ExtractTask, fellBack: boolean): Promise<ExtractOutcome> {
  const extract = EXTRACTORS[task.language];
  if (!extract) {
    return {
      facts: undefined,
      diagnostics: [
        {
          file: task.file,
          line: 1,
          severity: 'info',
          kind: 'unsupported',
          message: `No extractor for language "${task.language}"; file skipped.`,
        },
      ],
      fellBack,
    };
  }
  try {
    const { facts, diagnostics } = await extract(task.file, task.content);
    return { facts, diagnostics, fellBack };
  } catch (error) {
    return {
      facts: undefined,
      diagnostics: [
        {
          file: task.file,
          line: 1,
          severity: 'warning',
          kind: 'parse-failure',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
      fellBack,
    };
  }
}
