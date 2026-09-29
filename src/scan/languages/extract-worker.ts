import { parentPort } from 'node:worker_threads';

import { EXTRACTORS, type ExtractRequest, type ExtractResponse } from './extract-tasks.ts';

/**
 * The worker side of the parse/extract pool (Phase 18 P4).
 *
 * One worker owns its own copy of the tree-sitter runtime, so grammars load once per worker
 * and every parse in this thread is serialised by the worker's own event loop. The main
 * thread sends one `{ id, language, file, content }` at a time and awaits the reply, so
 * deterministic order is the main thread's job, not the worker's.
 */
if (parentPort) {
  const port = parentPort;

  port.on('message', (request: ExtractRequest) => {
    void handle(request);
  });

  async function handle(request: ExtractRequest): Promise<void> {
    const extract = EXTRACTORS[request.language];
    if (!extract) {
      const response: ExtractResponse = {
        id: request.id,
        ok: false,
        error: `No extractor for language "${request.language}".`,
      };
      port.postMessage(response);
      return;
    }
    try {
      const { facts, diagnostics } = await extract(request.file, request.content);
      port.postMessage({ id: request.id, ok: true, facts, diagnostics } satisfies ExtractResponse);
    } catch (error) {
      // A grammar that will not load, or a parser crash, is reported as a failed task; the
      // main thread turns it into a diagnostic rather than failing the whole scan.
      port.postMessage({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies ExtractResponse);
    }
  }
}
