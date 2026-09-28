import fs from 'node:fs';
import path from 'node:path';

import { matchesGlob } from '../glob.ts';

export interface Codeowners {
  /** The owner for a repository-relative file, or null when no rule matches. */
  ownerOf(file: string): string | null;
}

const LOCATIONS = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];

function ownerToken(tokens: readonly string[]): string | null {
  for (const token of tokens) {
    if (token.startsWith('@') || token.includes('@')) {
      return token.startsWith('@') ? token.slice(1) : token;
    }
  }
  return null;
}

/**
 * Read a repository's CODEOWNERS file, applying the last matching rule (the documented rule).
 *
 * Only the first owner token is kept: ownership needs a single name for the candidate report,
 * and a rule with several owners still names the team or user that leads the glob.
 */
export function readCodeowners(root: string): Codeowners {
  for (const location of LOCATIONS) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(root, location), 'utf8');
    } catch {
      continue;
    }
    const rules: Array<{ pattern: string; owner: string }> = [];
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      if (line === '') {
        continue;
      }
      const parts = line.split(/\s+/);
      const pattern = parts[0];
      const owner = ownerToken(parts.slice(1));
      if (pattern && owner) {
        rules.push({ pattern, owner });
      }
    }
    return {
      ownerOf(file: string): string | null {
        const posix = file.replace(/\\/g, '/');
        let owner: string | null = null;
        for (const rule of rules) {
          if (matchesPattern(posix, rule.pattern)) {
            owner = rule.owner;
          }
        }
        return owner;
      },
    };
  }
  return { ownerOf: () => null };
}

function matchesPattern(file: string, pattern: string): boolean {
  if (pattern.startsWith('/')) {
    return matchesGlob(file, pattern.slice(1));
  }
  if (pattern.includes('/')) {
    return matchesGlob(file, pattern) || matchesGlob(file, `**/${pattern}`);
  }
  return matchesGlob(path.posix.basename(file), pattern) || matchesGlob(file, `**/${pattern}`);
}
