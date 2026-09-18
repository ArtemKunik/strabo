import fs from 'node:fs';

import { assertReadable } from '../boundary/repository-root.ts';

export interface ModuleDepthSignal {
  file: string;
  implementationLines: number;
  interfaceWidth: number;
  exports: number;
  parameters: number;
  publicMembers: number;
  signal: 'pass-through' | 'wide-interface' | 'ok';
}

/**
 * Compare implementation lines with interface width to surface interfaces that may
 * expose too much for the work they hide.
 */
export function analyzeModuleDepth(root: string, files: readonly string[]): ModuleDepthSignal[] {
  return files.map((file) => {
    const content = readSource(root, file);
    const implementationLines = countImplementationLines(content);
    const { exports, parameters, publicMembers } = countInterface(content);
    const interfaceWidth = exports * 2 + parameters + publicMembers;
    return {
      file,
      implementationLines,
      interfaceWidth,
      exports,
      parameters,
      publicMembers,
      signal: classify(implementationLines, exports, interfaceWidth),
    };
  });
}

function readSource(root: string, file: string): string {
  try {
    const absolute = assertReadable(root, file);
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    return '';
  }
}

function countImplementationLines(content: string): number {
  return content
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('//') && !line.trim().startsWith('*'))
    .length;
}

function countInterface(content: string): {
  exports: number;
  parameters: number;
  publicMembers: number;
} {
  const exports = [...content.matchAll(/\bexport\b/g)].length;
  const parameterLists = [...content.matchAll(/\(([^)]*)\)/g)].map((match) => match[1] ?? '');
  const parameters = parameterLists.reduce((total, list) => {
    const trimmed = list.trim();
    return total + (trimmed ? trimmed.split(',').filter(Boolean).length : 0);
  }, 0);
  const publicMembers = [...content.matchAll(/^\s{0,2}(?:public\s+)?(?:readonly\s+)?\w+\s*[:(]/gm)].length;
  return { exports, parameters, publicMembers };
}

function classify(
  implementationLines: number,
  exports: number,
  interfaceWidth: number,
): ModuleDepthSignal['signal'] {
  // A pass-through is judged first: a tiny module with any export is mostly surface area,
  // and would otherwise always also satisfy the wide-interface ratio.
  if (exports > 0 && implementationLines <= 5) {
    return 'pass-through';
  }
  if (implementationLines > 0 && interfaceWidth / implementationLines > 0.5) {
    return 'wide-interface';
  }
  return 'ok';
}
