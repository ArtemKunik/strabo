import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildMemberMap } from '../../src/analysis/member-map.ts';
import { resolveTypeRefs } from '../../src/analysis/type-refs.ts';
import type { CodeSymbol } from '../../src/scan/languages/symbols.ts';
import type { Graph } from '../../src/types/graph.ts';

const FILE = 'app/model/KeyTheory.kt';

function graphOf(ids: string[], edges: Array<[string, string]> = []): Graph {
  return {
    nodes: ids.map((id) => ({ id, kind: 'module', directory: id.slice(0, id.lastIndexOf('/')) })) as Graph['nodes'],
    edges: edges.map(([source, target]) => ({
      source,
      target,
      kind: 'import',
      evidence: { line: 1, specifier: target, resolution: 'exact' },
    })) as Graph['edges'],
    diagnostics: [],
    excluded: [],
  };
}

function field(owner: string, name: string, type: string): CodeSymbol {
  return { name, kind: 'field', visibility: 'public', owner, type, line: 1 };
}

test('resolveTypeRefs ties a type to this file, an import, or a same-folder file, in that order', () => {
  const symbols: CodeSymbol[] = [
    { name: 'Key', kind: 'type', visibility: 'public', owner: '', line: 1 },
    field('Key', 'quality', 'KeyQuality'),
    field('Key', 'root', 'NoteName'),
    field('Key', 'chord', 'ChordDefinition'),
    field('Key', 'label', 'String'),
    field('Key', 'self', 'Key'),
  ];
  const memberMap = buildMemberMap(FILE, symbols, []);
  const graph = graphOf(
    [FILE, 'app/model/NoteName.kt', 'app/chords/ChordDefinition.kt', 'app/model/KeyQuality.kt', 'app/other/KeyQuality.kt'],
    [[FILE, 'app/chords/ChordDefinition.kt']],
  );

  assert.deepEqual(resolveTypeRefs(FILE, memberMap, graph), {
    Key: { file: FILE, basis: 'this-file' },
    KeyQuality: { file: 'app/model/KeyQuality.kt', basis: 'same-folder' },
    NoteName: { file: 'app/model/NoteName.kt', basis: 'same-folder' },
    ChordDefinition: { file: 'app/chords/ChordDefinition.kt', basis: 'import' },
  });
});

test('resolveTypeRefs leaves out a name with more than one candidate', () => {
  const symbols: CodeSymbol[] = [field('Key', 'root', 'NoteName')];
  const memberMap = buildMemberMap(FILE, symbols, []);
  const graph = graphOf(
    [FILE, 'app/a/NoteName.kt', 'app/b/NoteName.kt'],
    [[FILE, 'app/a/NoteName.kt'], [FILE, 'app/b/NoteName.kt']],
  );
  assert.deepEqual(resolveTypeRefs(FILE, memberMap, graph), {});
});
