import type {
  DataEdge,
  DataProductCandidate,
  DatasetNode,
} from '../../types.ts';

/** A writer or reader of a dataset, with the unit and repository it sits in. */
interface Participant {
  repository: string;
  unit: string;
  file: string;
  line: number;
  access: 'read' | 'write' | 'ddl';
}

export interface CandidateInput {
  datasets: readonly DatasetNode[];
  /** Read/write edges whose `source` is a file and whose `evidence` names the repository. */
  edges: readonly DataEdge[];
  /** The unit a file belongs to, for the write/read crossing rule. */
  unitOf: (repository: string, file: string) => string;
  /** A CODEOWNERS owner for a file, or null when none is recorded. */
  codeownerOf: (repository: string, file: string) => string | null;
  /** The owner a declared product gives the dataset, when a product names it. */
  productOwnerOf: (dataset: string) => string | null;
  /** Contract ids that govern a dataset, from `governs` edges. */
  governedBy: ReadonlyMap<string, string[]>;
}

/**
 * The datasets the recorded edges show are shared, each listed as a candidate with its
 * evidence, never promoted to a product (J6).
 *
 * Three shapes: a de facto output port (written in one unit, read in another), "no single
 * writer" (written by two or more units), and "shared without a contract" (read across a
 * repository boundary with no contract that governs it).
 */
export function buildCandidates(input: CandidateInput): DataProductCandidate[] {
  const writers = new Map<string, Participant[]>();
  const readers = new Map<string, Participant[]>();

  for (const edge of input.edges) {
    if ((edge.kind !== 'reads' && edge.kind !== 'writes') || !edge.evidence) {
      continue;
    }
    const participant: Participant = {
      repository: edge.evidence.repository,
      unit: input.unitOf(edge.evidence.repository, edge.source),
      file: edge.source,
      line: edge.evidence.line,
      access: edge.kind === 'reads' ? 'read' : 'write',
    };
    const list = (edge.kind === 'reads' ? readers : writers).get(edge.target) ?? [];
    list.push(participant);
    (edge.kind === 'reads' ? readers : writers).set(edge.target, list);
  }

  const datasets = new Map(input.datasets.map((dataset) => [dataset.id, dataset]));
  const candidates: DataProductCandidate[] = [];
  const ids = [...new Set([...writers.keys(), ...readers.keys()])].sort();
  for (const datasetId of ids) {
    const datasetWriters = dedupe(writers.get(datasetId) ?? []);
    const datasetReaders = dedupe(readers.get(datasetId) ?? []);
    if (datasetWriters.length === 0 && datasetReaders.length === 0) {
      continue;
    }
    const dataset = datasets.get(datasetId);
    const ownership = resolveOwnership(datasetId, datasetWriters, input);
    const kinds = classify(datasetWriters, datasetReaders, input.governedBy.get(datasetId) ?? []);

    for (const { kind, detail } of kinds) {
      candidates.push({
        dataset: datasetId,
        kind,
        writers: datasetWriters,
        readers: datasetReaders,
        detail,
        ownership,
      });
    }
  }
  return candidates.sort((a, b) => a.dataset.localeCompare(b.dataset) || a.kind.localeCompare(b.kind));
}

function classify(
  writers: Participant[],
  readers: Participant[],
  contracts: readonly string[],
): Array<{ kind: DataProductCandidate['kind']; detail: string }> {
  const kinds: Array<{ kind: DataProductCandidate['kind']; detail: string }> = [];
  const writerUnits = new Set(writers.map((entry) => `${entry.repository}\u0000${entry.unit}`));
  const writerRepos = new Set(writers.map((entry) => entry.repository));

  if (writerUnits.size >= 2) {
    kinds.push({
      kind: 'no-single-writer',
      detail: `written by ${writerUnits.size} units; no single writer`,
    });
  }
  const outputReaders = readers.filter(
    (reader) => !writerUnits.has(`${reader.repository}\u0000${reader.unit}`),
  );
  if (writers.length > 0 && outputReaders.length > 0) {
    kinds.push({
      kind: 'output-port',
      detail: `written in ${[...writerUnits].length} unit(s) and read in ${outputReaders.length} place(s) outside them`,
    });
  }
  const crossRepoReaders = readers.filter((reader) => !writerRepos.has(reader.repository));
  if (writers.length > 0 && crossRepoReaders.length > 0 && contracts.length === 0) {
    kinds.push({
      kind: 'shared-without-contract',
      detail: `read across a repository boundary by ${[...new Set(crossRepoReaders.map((entry) => entry.repository))].join(', ')} with no governing contract`,
    });
  }
  return kinds;
}

function resolveOwnership(
  dataset: string,
  writers: Participant[],
  input: CandidateInput,
): DataProductCandidate['ownership'] {
  const descriptor = input.productOwnerOf(dataset);
  if (descriptor) {
    return { source: 'descriptor', owner: descriptor };
  }
  const writer = writers[0];
  if (writer) {
    const owner = input.codeownerOf(writer.repository, writer.file);
    if (owner) {
      return { source: 'codeowners', owner };
    }
    return { source: 'unit', owner: writer.unit };
  }
  return { source: 'unit', owner: null };
}

function dedupe(list: Participant[]): Participant[] {
  const seen = new Set<string>();
  const result: Participant[] = [];
  for (const entry of list.sort(
    (a, b) => a.repository.localeCompare(b.repository) || a.unit.localeCompare(b.unit) || a.file.localeCompare(b.file) || a.line - b.line,
  )) {
    const key = `${entry.repository}\u0000${entry.unit}\u0000${entry.file}\u0000${entry.line}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(entry);
  }
  return result;
}
