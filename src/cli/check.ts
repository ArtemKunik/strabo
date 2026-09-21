import path from 'node:path';

import {
  buildBaseline,
  parseFailOnRules,
  runCheck,
  type CheckOptions,
  type CheckRule,
} from '../check/check.ts';
import { defaultBaselinePath, readBaseline, writeBaseline } from '../check/baseline.ts';
import { readEnv } from '../config.ts';

export interface CheckIo {
  write?: (text: string) => void;
}

export async function runCheckCommand(
  argv: readonly string[],
  io: CheckIo = {},
): Promise<number> {
  const write = io.write ?? ((text: string) => void process.stdout.write(text));
  const env = readEnv(process.env, argv);
  const rules: CheckRule[] = [];
  if (hasFlag(argv, 'fail-on-cycles')) {
    rules.push('cycles');
  }
  if (hasFlag(argv, 'fail-on-layer-violations')) {
    rules.push('layer-violations');
  }
  if (hasFlag(argv, 'fail-on-new-smells')) {
    rules.push('new-smells');
  }
  if (hasFlag(argv, 'fail-on-health-regression')) {
    rules.push('health-regression');
  }
  for (const rule of parseFailOnRules(collectFailOnValues(argv))) {
    if (!rules.includes(rule)) {
      rules.push(rule);
    }
  }

  const options: CheckOptions = {
    workspaceRoot: env.root,
    scanCeiling: env.scanCeiling,
    requested: flagValue(argv, 'repository'),
    rules,
    healthRegressionPct:
      numberFlag(argv, 'fail-on-health-regression') ??
      numberFlag(argv, 'health-regression-pct') ??
      0,
  };

  const baselineFile = flagValue(argv, 'baseline');
  const target = baselineFile ? path.resolve(baselineFile) : defaultBaselinePath(env.root);

  if (hasFlag(argv, 'write-baseline')) {
    const baseline = await buildBaseline(options);
    writeBaseline(target, baseline);
    write(
      `strabo check: baseline written to ${target}\n` +
        `${baseline.findings.length} recorded findings · health ${baseline.healthScore ?? 'unavailable'}\n`,
    );
    return 0;
  }

  const result = await runCheck({ ...options, baseline: readBaseline(target) });

  if (flagValue(argv, 'format') === 'json') {
    write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    write(renderHuman(result, target));
  }
  return result.passed ? 0 : 1;
}

function renderHuman(result: Awaited<ReturnType<typeof runCheck>>, baselinePath: string): string {
  const lines: string[] = [];
  lines.push(`strabo check · ${result.repository} @ ${result.revision ?? 'no revision'}`);
  lines.push(
    result.rules.length > 0 ? `rules: ${result.rules.join(', ')}` : 'rules: (none enabled)',
  );
  if (result.passed) {
    lines.push('PASS: no new findings for the enabled rules.');
  } else {
    lines.push(`FAIL: ${result.findings.length} finding(s) not in the baseline.`);
    for (const finding of result.findings) {
      lines.push(`  [${finding.rule}] ${finding.node} — ${finding.detail}`);
    }
  }
  if (result.baselined.length > 0) {
    lines.push(`baselined: ${result.baselined.length} (from ${baselinePath})`);
  }
  for (const warning of result.warnings) {
    lines.push(`warning [${warning.rule}]: ${warning.detail}`);
  }
  lines.push(`health ${result.healthScore ?? 'unavailable'}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Every `--fail-on <rules>` / `--fail-on=<rules>` value, in order. The comma-separated
 * lists are resolved by `parseFailOnRules`; this only gathers them.
 */
export function collectFailOnValues(argv: readonly string[]): string[] {
  const values: string[] = [];
  const prefix = '--fail-on=';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length).trim();
      if (value) {
        values.push(value);
      }
    } else if (arg === '--fail-on') {
      const value = (argv[index + 1] ?? '').trim();
      if (value && !value.startsWith('-')) {
        values.push(value);
      }
    }
  }
  return values;
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg.startsWith(prefix)) {
      const value = arg.slice(prefix.length).trim();
      return value || undefined;
    }
    if (arg === `--${name}`) {
      const value = (argv[index + 1] ?? '').trim();
      return value.startsWith('-') || !value ? undefined : value;
    }
  }
  return undefined;
}

function numberFlag(argv: readonly string[], name: string): number | undefined {
  const parsed = Number.parseInt(flagValue(argv, name) ?? '', 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
}
