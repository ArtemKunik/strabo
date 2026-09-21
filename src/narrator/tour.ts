import type { ReadingRoute } from '../analysis/route.ts';
import type { RepositoryPassport } from '../analysis/passport.ts';

/**
 * The guided tour is model-generated narrative, framed like every other narrator request.
 *
 * Only the recorded passport and reading route become evidence; the instruction asks for a
 * five-to-seven-paragraph onboarding tour, and a fact the evidence does not carry stays
 * unsaid. The builder is pure so the tour can be shaped and checked without a provider.
 */
export interface TourRequest {
  instruction: string;
  evidence: string;
}

/** The paragraph band the tour asks for, stated in the instruction. */
export const TOUR_MIN_PARAGRAPHS = 5;
export const TOUR_MAX_PARAGRAPHS = 7;

/** Bound on the evidence text, so a huge route cannot crowd out the instruction. */
export const TOUR_EVIDENCE_LIMIT = 12_000;

/** Most routed files listed before the evidence says it truncated. */
export const TOUR_ROUTE_LIMIT = 80;

export const TOUR_INSTRUCTION = [
  `Write a ${TOUR_MIN_PARAGRAPHS}-to-${TOUR_MAX_PARAGRAPHS}-paragraph guided onboarding tour of this repository`,
  'for a developer who has never seen it. Use only the recorded evidence and report only what',
  'it supports. Start from the declared entry points and follow the reading route outward, naming',
  'the units and why each exists. Say plainly when a fact is not recorded rather than guessing.',
  'Write flowing prose, lead with the point, and do not restate the evidence line by line or',
  'describe its format.',
].join(' ');

/**
 * Turn the passport and the route into the narrator's evidence.
 *
 * Both facts are optional: a missing passport or an empty route is stated as such rather than
 * filled in, and the route is capped so the evidence stays within its budget.
 */
export function buildTourRequest(
  passport: RepositoryPassport | null | undefined,
  route: ReadingRoute | null | undefined,
): TourRequest {
  const lines: string[] = [];
  lines.push(`repository: ${passport?.repository ?? route?.repository ?? 'unknown'}`);

  const size = passport?.size;
  if (size) {
    lines.push(
      `size: ${size.files} file(s), ${size.edges} edge(s), ${size.directories} directory(ies), ${size.tests} test(s)`,
    );
  } else {
    lines.push('size: not recorded');
  }

  const languages = passport?.languages ?? [];
  lines.push('languages:');
  if (languages.length === 0) {
    lines.push('- not recorded');
  } else {
    for (const language of languages) {
      lines.push(`- ${language.language}: ${language.files} file(s)`);
    }
  }

  const entryPoints = route?.entryPoints ?? [];
  lines.push('declared entry points:');
  if (entryPoints.length === 0) {
    lines.push('- none declared by a manifest');
  } else {
    for (const entry of entryPoints) {
      lines.push(`- ${entry.file} (${entry.reason}; unit ${entry.unit})`);
    }
  }

  const units = route?.units ?? [];
  lines.push('units:');
  if (units.length === 0) {
    lines.push('- not recorded');
  } else {
    for (const unit of units) {
      const summary = unit.summary;
      lines.push(
        `- ${summary.name} [${summary.id}], ${summary.ecosystem}, role ${summary.role} (${summary.roleEvidence}); ` +
          `${summary.routed} of ${summary.files} file(s) routed, ${summary.unreached} no entry point reaches`,
      );
    }
  }

  lines.push('reading route (an importer appears before what it imports):');
  const steps = (route?.order ?? []).slice();
  if (steps.length === 0) {
    lines.push('- empty: no entry point reaches any file');
  } else {
    const shown = steps.slice(0, TOUR_ROUTE_LIMIT);
    for (const step of shown) {
      const reached = step.from ? `reached from ${step.from}` : 'entry point';
      lines.push(
        `${step.depth}. ${step.file} [unit ${step.unit}] (${reached}; ${step.fanIn} importer(s); tier ${step.tier})`,
      );
    }
    if (steps.length > shown.length) {
      lines.push(`- ${steps.length - shown.length} further file(s) not listed`);
    }
  }

  if (route) {
    lines.push(`files no entry point reaches: ${route.summary.unreached} (kept out of the order)`);
  }

  let evidence = lines.join('\n');
  if (evidence.length > TOUR_EVIDENCE_LIMIT) {
    evidence = `${evidence.slice(0, TOUR_EVIDENCE_LIMIT)}\n(evidence truncated)`;
  }
  return { instruction: TOUR_INSTRUCTION, evidence };
}
