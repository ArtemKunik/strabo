import fs from 'node:fs';
import path from 'node:path';

import { findManifestFiles } from '../risk/inventory.ts';
import type { PublishedCoordinate } from '../types.ts';

/**
 * The repository's own published coordinate, read from its manifest.
 *
 * A package.json `name`, a Cargo.toml `[package] name`, or a pom.xml
 * `groupId:artifactId` is a declaration, not a guess: a repository that names itself
 * `@acme/core` is what a sibling's `import '@acme/core'` can be resolved against. A
 * repository that publishes nothing returns null rather than a name derived from its
 * directory, so a cross-repo flow is never invented from a folder name.
 */
export function readPublishedCoordinate(root: string): PublishedCoordinate | null {
  const manifests = findManifestFiles(root);
  return fromNpm(root, manifests) ?? fromCargo(root, manifests) ?? fromMaven(root, manifests);
}

function fromNpm(root: string, manifests: string[]): PublishedCoordinate | null {
  const file = manifests.find((entry) => path.basename(entry) === 'package.json');
  if (!file) {
    return null;
  }
  const content = read(root, file);
  if (content === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(content) as { name?: unknown };
    const name = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    return name === '' ? null : { ecosystem: 'npm', name, source: file };
  } catch {
    return null;
  }
}

function fromCargo(root: string, manifests: string[]): PublishedCoordinate | null {
  const file = manifests.find((entry) => path.basename(entry) === 'Cargo.toml');
  if (!file) {
    return null;
  }
  const content = read(root, file);
  const name = content === null ? null : tomlPackageName(content);
  return name === null ? null : { ecosystem: 'cargo', name, source: file };
}

function fromMaven(root: string, manifests: string[]): PublishedCoordinate | null {
  const file = manifests.find((entry) => path.basename(entry) === 'pom.xml');
  if (!file) {
    return null;
  }
  const content = read(root, file);
  if (content === null) {
    return null;
  }
  // Strip `<parent>` so the parent's groupId is not mistaken for this project's.
  const project = content.replace(/<parent>[\s\S]*?<\/parent>/i, '');
  const groupId = firstTag(project, 'groupId');
  const artifactId = firstTag(project, 'artifactId');
  if (!groupId || !artifactId) {
    return null;
  }
  return { ecosystem: 'maven', name: `${groupId}:${artifactId}`, source: file };
}

/** The first `name = "..."` inside Cargo.toml's `[package]` section. */
function tomlPackageName(content: string): string | null {
  let inPackage = false;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inPackage = line === '[package]';
      continue;
    }
    if (!inPackage || line.startsWith('#')) {
      continue;
    }
    const match = /^name\s*=\s*["']([^"']+)["']/.exec(line);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

function firstTag(content: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>\\s*([^<\\s]+)\\s*</${tag}>`).exec(content);
  return match?.[1] ?? null;
}

function read(root: string, file: string): string | null {
  try {
    return fs.readFileSync(path.join(root, file), 'utf8');
  } catch {
    return null;
  }
}
