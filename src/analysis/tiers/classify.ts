import path from 'node:path';

import { DECLARED_GROUPS_FILE } from '../units.ts';
import { globToRegExp } from './declared.ts';
import { countLines, readText } from './read.ts';
import {
  ANNOTATION_RULES,
  FILE_KIND_RULES,
  FILENAME_RULES,
  FRAMEWORK_RULES,
  PATH_TOKEN_RULES,
  ROUTE_RULES,
  isTestFile,
  type Language,
} from './rules.ts';
import { extractTables } from './table.ts';
import {
  TIER_ORDER,
  type DeclaredTier,
  type Tier,
  type TierClassification,
  type TierEvidence,
  type TierStrength,
} from './types.ts';

const STRENGTH_RANK: Record<TierStrength, number> = {
  declared: 6,
  framework: 5,
  annotation: 4,
  endpoint: 3,
  'file-kind': 2,
  'path-token': 1,
  graph: 0,
};

/** Classify one file from its recorded content and path, with the evidence behind it. */
export function classifyTierContent(
  file: string,
  content: string,
  declared: readonly DeclaredTier[] = [],
): TierClassification {
  const language = languageOf(file);
  const evidence: TierEvidence[] = [];
  const lines = countLines(content);
  const tables = extractTables(file, content);

  const declaredMatch = declared.find((entry) =>
    entry.globs.some((glob) => globToRegExp(glob).test(file)),
  );
  if (declaredMatch) {
    // An operator-stated tier wins outright and is labelled as announced, not observed.
    return {
      file,
      tier: declaredMatch.tier,
      mixed: false,
      evidence: [
        { tier: declaredMatch.tier, strength: 'declared', detail: `declared in ${DECLARED_GROUPS_FILE}` },
      ],
      lines,
      tables,
    };
  }

  const imports = importText(content);
  for (const rule of FRAMEWORK_RULES[language] ?? []) {
    const hit = rule.pattern.exec(imports);
    if (hit) {
      evidence.push({ tier: rule.tier, strength: 'framework', detail: `imports ${hit[0].trim()}` });
    }
  }
  for (const rule of ANNOTATION_RULES[language] ?? []) {
    const hit = rule.pattern.exec(content);
    if (hit) {
      evidence.push({ tier: rule.tier, strength: 'annotation', detail: `annotation ${hit[0].trim()}` });
    }
  }
  for (const rule of ROUTE_RULES[language] ?? []) {
    const hit = rule.pattern.exec(content);
    if (hit) {
      evidence.push({ tier: rule.tier, strength: 'endpoint', detail: `declares route ${hit[0].trim()}` });
    }
  }
  for (const rule of FILE_KIND_RULES) {
    if (rule.test(file)) {
      evidence.push({ tier: rule.tier, strength: 'file-kind', detail: rule.detail });
    }
  }
  if (!isTestFile(file)) {
    for (const rule of FILENAME_RULES) {
      if (rule.pattern.test(file)) {
        evidence.push({ tier: rule.tier, strength: 'file-kind', detail: rule.detail });
      }
    }
  }
  if (evidence.length === 0) {
    const segments = file.split('/').slice(0, -1).map((segment) => segment.toLowerCase());
    for (const rule of PATH_TOKEN_RULES) {
      const token = rule.tokens.find((candidate) => segments.includes(candidate));
      if (token) {
        evidence.push({ tier: rule.tier, strength: 'path-token', detail: `path token \`${token}\`` });
        break;
      }
    }
  }

  if (evidence.length === 0) {
    return { file, tier: 'unclassified', mixed: false, evidence: [], lines, tables };
  }

  const byTier = new Map<Tier, number>();
  for (const entry of evidence) {
    byTier.set(entry.tier, Math.max(byTier.get(entry.tier) ?? 0, STRENGTH_RANK[entry.strength]));
  }
  const strongest = Math.max(...byTier.values());
  const top = TIER_ORDER.filter((tier) => byTier.get(tier) === strongest);
  return {
    file,
    tier: top[0] ?? 'unclassified',
    // Two tiers at the same strongest evidence is a mixed file, not a forced choice.
    mixed: top.length > 1,
    evidence,
    lines,
    tables,
  };
}

/** Classify every file, reading bounded source. Files that cannot be read are unclassified. */
export function classifyTiers(
  root: string,
  files: readonly string[],
  declared: readonly DeclaredTier[] = [],
): { files: TierClassification[]; skipped: string[] } {
  const classified: TierClassification[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const content = readText(root, file);
    if (content === null) {
      skipped.push(file);
      continue;
    }
    classified.push(classifyTierContent(file, content, declared));
  }
  return { files: classified, skipped };
}

function languageOf(file: string): Language {
  const extension = path.extname(file).toLowerCase();
  if (['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) return 'js';
  if (extension === '.rs') return 'rust';
  if (extension === '.java') return 'java';
  if (extension === '.kt' || extension === '.kts') return 'kotlin';
  if (extension === '.cs') return 'csharp';
  if (extension === '.py') return 'python';
  if (extension === '.go') return 'go';
  if (['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx', '.h'].includes(extension)) return 'cpp';
  if (extension === '.sql') return 'sql';
  if (extension === '.proto') return 'proto';
  return 'other';
}

/**
 * The import-ish lines of a file, joined, so a framework token is matched in an import.
 *
 * A line is kept when it starts with an import keyword or when it calls `require(...)`
 * anywhere, so a CommonJS `const express = require('express')` is read like an ESM import
 * rather than missed by the line-start test.
 */
function importText(content: string): string {
  return content
    .split(/\r?\n/)
    .filter(
      (line) =>
        /^\s*(?:import|export|use|using|from|require|package|#include)\b/.test(line) ||
        /\brequire\s*\(/.test(line),
    )
    .join('\n');
}
