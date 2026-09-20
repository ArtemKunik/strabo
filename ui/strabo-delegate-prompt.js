/**
 * Agent delegation prompts: the evidence-based markdown handed to an AI coding agent.
 *
 * Pure functions only: no DOM, no fetch.
 */

/* ------------------------------------------------- Agent delegation prompts */

export const DELEGATE_AGENTS = ['opencode', 'claude'];

/** Upper bound so a delegated prompt stays well under HTTP and CLI arg limits. */
export const MAX_DELEGATE_PROMPT = 20000;

const DELEGATE_TASKS = {
  node: 'Assess this file: its role in the repository, its blast radius, and the risk of changing it.',
  edge: 'Explain this dependency: why it exists (from the evidence) and the impact of changing it.',
  diagnostic: 'Resolve this diagnostic: explain the cause and propose the smallest safe fix.',
  commit: 'Summarise what this change did and what it may still affect in the working tree.',
  member: 'Explain this member: what it does and how it is wired to state.',
  review: 'Explain this change set as a function of the app: what capability or behaviour it adds, changes, or removes for a user of the app — not just which files and lines moved. Read the actual diff for the listed files to ground the explanation.',
  view: 'Give an architectural overview of this view: hotspots, coupling, and where to look first.',
  group: 'Assess this set of files together: shared role, coupling between them, and the risk of changing them as a group.',
};

/** Facts shown per file inside a group's evidence section — lower than a single item's
 * cap so a large selection still gives every file some representation before the
 * overall prompt is truncated. */
const MAX_FACTS_PER_GROUP_ITEM = 6;

/** Files rendered inside a group's evidence section; the rest are only named. */
const MAX_GROUP_ITEMS = 30;

function renderFacts(lines, facts, cap) {
  if (facts.length === 0) {
    lines.push('- No further evidence recorded for this item.');
    return;
  }
  for (const fact of facts.slice(0, cap)) {
    lines.push(`- ${String(fact).slice(0, 300)}`);
  }
  if (facts.length > cap) {
    lines.push(`- …and ${facts.length - cap} more recorded fact(s) (truncated).`);
  }
}

/**
 * Build an evidence-based delegation prompt for an AI coding agent.
 *
 * Pure function: only the recorded facts in `target` are rendered, nothing is
 * inferred. `target` is `{ kind, id?, label?, detail?, evidence? }` where kind is
 * one of node | edge | diagnostic | commit | member | view | group and `evidence` is
 * an array of short fact strings. A `group` target additionally carries `items`, one
 * `{ id?, label?, evidence? }` per selected file, each rendered as its own subsection —
 * a flat merged evidence list would blur which fact belongs to which file. Returns
 * capped markdown, or throws for an unknown agent so callers fail loudly instead of
 * launching the wrong tool.
 */
export function buildAgentPrompt({ agent, repository, target }) {
  if (!DELEGATE_AGENTS.includes(agent)) {
    throw new Error(`Unknown delegate agent: ${agent}`);
  }
  const item = target ?? { kind: 'view' };
  const kind = DELEGATE_TASKS[item.kind] ? item.kind : 'view';
  const items = kind === 'group' && Array.isArray(item.items) ? item.items.filter(Boolean) : null;
  const title = item.label ?? item.id ?? (items ? `${items.length} file(s)` : 'repository view');
  const lines = [`# Strabo task — ${title}`, ''];
  lines.push(`Repository: ${repository?.name ?? 'unknown'} (${repository?.root ?? 'unknown'})`);
  lines.push(
    `Target: ${kind}${items ? ` (${items.length} file(s))` : item.id ? ` \`${item.id}\`` : ''}`,
  );
  lines.push('');
  lines.push('## Recorded evidence (from the Strabo scan — do not invent links)');
  lines.push('');
  if (items) {
    if (items.length === 0) {
      lines.push('- No files recorded in this selection.');
    } else {
      for (const entry of items.slice(0, MAX_GROUP_ITEMS)) {
        lines.push(`### ${entry.label ?? entry.id ?? 'file'}${entry.id ? ` (\`${entry.id}\`)` : ''}`);
        renderFacts(lines, (entry.evidence ?? []).filter(Boolean), MAX_FACTS_PER_GROUP_ITEM);
        lines.push('');
      }
      if (items.length > MAX_GROUP_ITEMS) {
        const rest = items.slice(MAX_GROUP_ITEMS).map((entry) => entry.id ?? entry.label ?? 'file');
        lines.push(`### …and ${items.length - MAX_GROUP_ITEMS} more file(s) (not detailed)`);
        lines.push(`- ${rest.join(', ').slice(0, 500)}`);
        lines.push('');
      }
    }
  } else {
    const facts = Array.isArray(item.evidence) ? item.evidence.filter(Boolean) : [];
    if (item.detail) {
      facts.unshift(String(item.detail));
    }
    renderFacts(lines, facts, 20);
  }
  lines.push('');
  lines.push('## Task');
  lines.push('');
  lines.push(DELEGATE_TASKS[kind]);
  lines.push('');
  lines.push(`Work inside \`${repository?.root ?? '.'}\`. Quote file paths and line numbers for every claim.`);
  const prompt = lines.join('\n');
  return prompt.length > MAX_DELEGATE_PROMPT ? `${prompt.slice(0, MAX_DELEGATE_PROMPT)}\n\n…(truncated)` : prompt;
}
