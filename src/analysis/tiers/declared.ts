import fs from 'node:fs';
import path from 'node:path';
import { Document, isMap, isScalar, isSeq, parse as parseYaml, parseDocument, YAMLSeq } from 'yaml';

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

/** The header a new `strabo.groups.yml` starts with, so the file explains itself. */
const NEW_GROUPS_HEADER = [
  'Tier declarations for this repository, read by the tier lens (/analysis/tiers).',
  'A declared tier overrides the derived one. Globs are POSIX, `**` matches any depth, and the',
  'first matching entry wins, so specific globs go first.',
];

/** Why a tier assignment was refused, or where it was written. */
export type TierAssignment =
  | { ok: true; file: string; tier: Tier; glob: string; created: boolean }
  | { ok: false; error: string };

/**
 * Declare `glob` as `tier` in `strabo.groups.yml`, creating the file when there is none.
 *
 * The entry goes first, since the first matching entry wins and an assignment made from the
 * map is always more specific than the broad globs already there; when the first entry
 * already names this tier, the glob joins it. Comments and the rest of the file are kept.
 * The glob must be repository-relative: no absolute path, no `..` segment, one line.
 */
export function assignDeclaredTier(root: string, tier: string, glob: string): TierAssignment {
  if (!TIER_ORDER.includes(tier as Tier) || tier === 'unclassified') {
    return { ok: false, error: `Unknown tier "${tier}".` };
  }
  const pattern = toPosix(glob.trim().replace(/\\/g, '/'));
  if (
    !pattern ||
    pattern.length > 300 ||
    /[\r\n]/.test(pattern) ||
    pattern.startsWith('/') ||
    /^[a-z]:/i.test(pattern) ||
    pattern.split('/').includes('..')
  ) {
    return { ok: false, error: `"${glob}" is not a repository-relative glob.` };
  }
  const file = path.join(root, DECLARED_GROUPS_FILE);
  let content: string | null = null;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    content = null;
  }
  const parsed = parseDocument(content ?? '');
  if (parsed.errors.length > 0) {
    return { ok: false, error: `${DECLARED_GROUPS_FILE} does not parse; fix it by hand first.` };
  }
  let document: Document = parsed;
  if (parsed.contents === null) {
    document = new Document({ tiers: [] });
    document.commentBefore = NEW_GROUPS_HEADER.map((line) => ` ${line}`).join('\n');
  }
  if (!isMap(document.contents)) {
    return { ok: false, error: `${DECLARED_GROUPS_FILE} is not a mapping; fix it by hand first.` };
  }
  let tiers: unknown = document.get('tiers', true);
  if (!isSeq(tiers)) {
    tiers = new YAMLSeq();
    document.set('tiers', tiers);
  }
  const list = tiers as YAMLSeq;
  const first = list.items[0];
  const firstGlobs = isMap(first) ? first.get('globs', true) : undefined;
  if (isMap(first) && first.get('tier') === tier && isSeq(firstGlobs)) {
    if (!firstGlobs.items.some((item) => (isScalar(item) ? item.value : item) === pattern)) {
      firstGlobs.add(document.createNode(pattern));
    }
  } else {
    list.items.unshift(document.createNode({ tier, globs: [pattern] }));
  }
  fs.writeFileSync(file, document.toString(), 'utf8');
  return { ok: true, file: DECLARED_GROUPS_FILE, tier: tier as Tier, glob: pattern, created: content === null };
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
