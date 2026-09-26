import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import { toPosix } from '../../boundary/repository-root.ts';
import { DECLARED_GROUPS_FILE } from '../units.ts';
import { TIER_ORDER, type DeclaredTier, type Tier } from './types.ts';

/** Read tier overrides from the `tiers` list in `strabo.groups.yml`. */
export function readDeclaredTiers(root: string): DeclaredTier[] {
  let content: string;
  try {
    content = fs.readFileSync(path.join(root, DECLARED_GROUPS_FILE), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return [];
  }
  const entries = (parsed as { tiers?: unknown } | null)?.tiers;
  if (!Array.isArray(entries)) {
    return [];
  }
  const tiers: DeclaredTier[] = [];
  for (const entry of entries) {
    const record = entry as { tier?: unknown; globs?: unknown };
    const tier = typeof record.tier === 'string' && TIER_ORDER.includes(record.tier as Tier)
      ? (record.tier as Tier)
      : null;
    const globs = Array.isArray(record.globs)
      ? record.globs.filter((glob): glob is string => typeof glob === 'string' && glob.trim() !== '')
      : [];
    if (tier && globs.length > 0) {
      tiers.push({ tier, globs });
    }
  }
  return tiers;
}

export function globToRegExp(glob: string): RegExp {
  const pattern = toPosix(glob.replace(/\\/g, '/'));
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(character)) {
      source += `\\${character}`;
    } else {
      source += character;
    }
  }
  return new RegExp(`^${source}$`);
}
