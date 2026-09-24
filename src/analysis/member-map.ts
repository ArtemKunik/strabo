import type { CodeSymbol, MemberAccess, ReExport } from '../scan/languages/symbols.ts';

/**
 * The Member map for one file: declared members grouped by type, the names the file
 * re-exports, and data-flow panels derived only from field references the scan recorded
 * inside this file.
 *
 * Nothing is inferred. A member declared in another file appears only when the scan
 * recorded an edge to it — a C++ implementation borrows the fields its own header declares,
 * and each carries `declaredIn` so the map says where it came from. When no field access was
 * recorded, `dataFlow` reports `available: false` rather than showing empty panels that
 * imply there is no wiring. A barrel (`index.ts`) declares no members, so its `reExports` are
 * the only evidence of its public surface.
 */
export interface MemberMapField {
  name: string;
  visibility: string;
  type?: string;
  mutable?: boolean;
  line: number;
  /** The file that declares the field, when that is not the file being mapped. */
  declaredIn?: string;
  /** Distinct methods in this file that read or write the field. */
  reads: number;
  writes: number;
}

export interface MemberMapMethod {
  name: string;
  visibility: string;
  type?: string;
  parameters?: number;
  line: number;
  reads: string[];
  writes: string[];
}

export interface MemberMapType {
  /** Dotted name including enclosing types (`Outer.Inner`). */
  name: string;
  visibility: string;
  line: number;
  fields: MemberMapField[];
  methods: MemberMapMethod[];
}

export interface DataFlowPanels {
  available: boolean;
  reason?: string;
  detail?: string;
  /** Fields read but never written here: values flowing in. */
  sources: string[];
  /** Fields both read and written here: shared state. */
  resources: string[];
  /** Methods that read one field and write another: behaviour. */
  transforms: string[];
  /** Fields written but never read here: values flowing out. */
  sinks: string[];
  caveat?: string;
}

export interface MemberMap {
  file: string;
  available: boolean;
  reason?: string;
  detail?: string;
  types: MemberMapType[];
  /** Names the file forwards from other modules; empty for a file that re-exports nothing. */
  reExports: ReExport[];
  dataFlow: DataFlowPanels;
}

const NO_ACCESS: DataFlowPanels = {
  available: false,
  reason: 'no-field-access',
  detail: 'No field references were recorded in this file.',
  sources: [],
  resources: [],
  transforms: [],
  sinks: [],
};

/** Build the member map for a file from its extracted symbols, field references, and re-exports. */
export function buildMemberMap(
  file: string,
  symbols: CodeSymbol[],
  accesses: MemberAccess[],
  reExports: ReExport[] = [],
): MemberMap {
  const typeSymbols = new Map(
    symbols
      .filter((symbol) => symbol.kind === 'type')
      .map((symbol) => [symbol.owner ? `${symbol.owner}.${symbol.name}` : symbol.name, symbol]),
  );

  // Some extractors do not emit a `type` symbol for a class (Kotlin), so an owner is any
  // name that has members; a matching declaration supplies its visibility and line.
  const owners = new Set<string>();
  for (const symbol of symbols) {
    if (symbol.owner) {
      owners.add(symbol.owner);
    }
  }
  for (const name of typeSymbols.keys()) {
    owners.add(name);
  }

  const lineOf = (owner: string): number => {
    const declared = typeSymbols.get(owner);
    if (declared) {
      return declared.line;
    }
    const member = symbols.find((symbol) => symbol.owner === owner);
    return member?.line ?? Number.MAX_SAFE_INTEGER;
  };

  const types = [...owners]
    .sort((a, b) => lineOf(a) - lineOf(b) || a.localeCompare(b))
    .map((owner) => buildType(owner, typeSymbols.get(owner), symbols, accesses));

  return {
    file,
    available: true,
    types,
    reExports: [...reExports].sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)),
    dataFlow: buildDataFlow(accesses),
  };
}

function buildType(
  fullName: string,
  declared: CodeSymbol | undefined,
  symbols: CodeSymbol[],
  accesses: MemberAccess[],
): MemberMapType {
  const owner = fullName;
  const members = symbols.filter(
    (symbol) => symbol.owner === owner && (symbol.kind === 'field' || symbol.kind === 'property'),
  );
  const methods = symbols.filter((symbol) => symbol.owner === owner && symbol.kind === 'method');
  const ownAccesses = accesses.filter((access) => access.owner === owner);

  const fields: MemberMapField[] = members.map((member) => ({
    name: member.name,
    visibility: member.visibility,
    type: member.type,
    mutable: member.mutable,
    line: member.line,
    declaredIn: member.declaredIn,
    reads: countMethods(ownAccesses, member.name, 'read'),
    writes: countMethods(ownAccesses, member.name, 'write'),
  }));

  return {
    name: owner,
    visibility: declared?.visibility ?? 'not recorded',
    line: declared?.line ?? (symbols.find((symbol) => symbol.owner === owner)?.line ?? 1),
    fields,
    methods: methods.map((method) => {
      const forMethod = ownAccesses.filter((access) => access.method === method.name);
      return {
        name: method.name,
        visibility: method.visibility,
        type: method.type,
        parameters: method.parameters,
        line: method.line,
        reads: fieldsTouched(forMethod, 'read'),
        writes: fieldsTouched(forMethod, 'write'),
      };
    }),
  };
}

function countMethods(accesses: MemberAccess[], field: string, mode: MemberAccess['mode']): number {
  const methods = new Set(
    accesses.filter((access) => access.field === field && access.mode === mode).map((a) => a.method),
  );
  return methods.size;
}

function fieldsTouched(accesses: MemberAccess[], mode: MemberAccess['mode']): string[] {
  return [...new Set(accesses.filter((access) => access.mode === mode).map((a) => a.field))].sort();
}

/** Classify the recorded references into the four reference-design panels. */
function buildDataFlow(accesses: MemberAccess[]): DataFlowPanels {
  if (accesses.length === 0) {
    return { ...NO_ACCESS };
  }

  const byField = new Map<string, { reads: boolean; writes: boolean }>();
  const methodModes = new Map<string, { reads: boolean; writes: boolean }>();
  for (const access of accesses) {
    const entry = byField.get(access.field) ?? { reads: false, writes: false };
    if (access.mode === 'read') {
      entry.reads = true;
    } else {
      entry.writes = true;
    }
    byField.set(access.field, entry);

    if (access.owner) {
      const key = `${access.owner}.${access.method}`;
      const modes = methodModes.get(key) ?? { reads: false, writes: false };
      if (access.mode === 'read') {
        modes.reads = true;
      } else {
        modes.writes = true;
      }
      methodModes.set(key, modes);
    }
  }

  const transforms = new Set<string>();
  for (const [method, modes] of methodModes) {
    if (modes.reads && modes.writes) {
      transforms.add(method);
    }
  }

  const sources: string[] = [];
  const resources: string[] = [];
  const sinks: string[] = [];
  for (const [field, entry] of byField) {
    if (entry.reads && entry.writes) {
      resources.push(field);
    } else if (entry.reads) {
      sources.push(field);
    } else if (entry.writes) {
      sinks.push(field);
    }
  }

  return {
    available: true,
    sources: sources.sort(),
    resources: resources.sort(),
    transforms: [...transforms].sort(),
    sinks: sinks.sort(),
    caveat: 'Derived from field references recorded in this file; cross-file access is not tracked.',
  };
}
