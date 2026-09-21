import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { stateRoot } from '../state/repository-store.ts';

export const BASELINE_VERSION = 1;

export interface CheckBaseline {
  version: number;
  repository: string;
  revision: string | null;
  fingerprint: string | null;
  generatedAt: string;
  findings: string[];
  healthScore: number | null;
}

export function defaultBaselinePath(root: string): string {
  const digest = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
  return path.join(stateRoot(), `strabo-baseline-${digest}.json`);
}

export function readBaseline(file: string): CheckBaseline | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CheckBaseline>;
    if (parsed.version !== BASELINE_VERSION || !Array.isArray(parsed.findings)) {
      return null;
    }
    return {
      version: BASELINE_VERSION,
      repository: typeof parsed.repository === 'string' ? parsed.repository : '',
      revision: typeof parsed.revision === 'string' ? parsed.revision : null,
      fingerprint: typeof parsed.fingerprint === 'string' ? parsed.fingerprint : null,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
      findings: parsed.findings.filter((entry): entry is string => typeof entry === 'string'),
      healthScore: typeof parsed.healthScore === 'number' ? parsed.healthScore : null,
    };
  } catch {
    return null;
  }
}

export function writeBaseline(file: string, baseline: CheckBaseline): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(baseline, null, 2));
  fs.renameSync(temporary, file);
}
