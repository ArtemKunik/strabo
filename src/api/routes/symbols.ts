import { Router } from 'express';
import fs from 'node:fs';

import { assertReadable, resolveRepositoryRoot } from '../../boundary/repository-root.ts';
import { buildMemberMap } from '../../analysis/member-map.ts';
import { extractCSharpSymbols } from '../../scan/languages/csharp.ts';
import { extractJavaSymbols } from '../../scan/languages/java.ts';
import { extractKotlinSymbols } from '../../scan/languages/kotlin.ts';
import { extractRustSymbols } from '../../scan/languages/rust.ts';
import type { SymbolExtraction } from '../../scan/languages/symbols.ts';
import type { StraboConfig } from '../../types.ts';
import { sendError } from '../http.ts';

const EXTRACTORS: Record<string, { language: string; extract: (file: string, content: string) => Promise<SymbolExtraction> }> = {
  '.java': { language: 'java', extract: extractJavaSymbols },
  '.rs': { language: 'rust', extract: extractRustSymbols },
  '.cs': { language: 'csharp', extract: extractCSharpSymbols },
  '.kt': { language: 'kotlin', extract: extractKotlinSymbols },
  '.kts': { language: 'kotlin', extract: extractKotlinSymbols },
};

/**
 * Symbol extraction for a single file, on demand.
 *
 * Edges never need members, so extraction is not part of every scan. Languages without a
 * symbol extractor return `available: false` rather than an empty list, so the UI can say
 * "not implemented" instead of implying the file has no members.
 */
export function createSymbolsRouter(config: StraboConfig): Router {
  const router = Router();

  router.get('/symbols', async (request, response) => {
    try {
      const repository = resolveRepositoryRoot({
        workspaceRoot: config.workspaceRoot,
        scanCeiling: config.scanCeiling ?? config.workspaceRoot,
        requested:
          typeof request.query.repository === 'string' ? request.query.repository : undefined,
      });
      const file = typeof request.query.file === 'string' ? request.query.file : '';
      if (!file) {
        response.status(400).json({ error: 'file query parameter is required.' });
        return;
      }

      const extension = file.slice(file.lastIndexOf('.')).toLowerCase();
      const extractor = EXTRACTORS[extension];
      if (!extractor) {
        response.json({
          file,
          available: false,
          reason: 'not-implemented',
          detail: `Symbol extraction is not implemented for "${extension || 'unknown'}" yet.`,
        });
        return;
      }

      const content = fs.readFileSync(assertReadable(repository.root, file), 'utf8');
      const result = await extractor.extract(file, content);
      response.json({
        file,
        language: extractor.language,
        available: true,
        symbols: result.symbols,
        diagnostics: result.diagnostics,
        memberMap: buildMemberMap(file, result.symbols, result.accesses ?? []),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  return router;
}
