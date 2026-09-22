import { pathToFileURL } from 'node:url';

import { runCheckCommand } from './cli/check.ts';
import { runExportCommand } from './cli/export.ts';
import { runReportCommand, runSummaryCommand } from './cli/report.ts';
import { configFromEnv, readEnv } from './config.ts';
import { startMcpServer } from './mcp/server.ts';
import { createStraboServer } from './server.ts';
import { createRestart } from './server-restart.ts';
import { attachTerminal } from './terminal/ws.ts';

const USAGE = `strabo — map a repository's files, dependencies, and change impact

Usage:
  strabo [path]                       start the standalone server
  strabo serve [path]                 same, with an explicit subcommand
  strabo export [path] --format=<fmt> write a portable graph (json, dot, mermaid, svg)
  strabo check [path] [rules]         run headless checks for CI
  strabo report [path] --base <ref>   report a change against a base revision
  strabo report [path]                report the whole repository
  strabo summary [path]               the repository report, always repository-scoped
  strabo mcp                          serve the recorded analysis over MCP (stdio)

Export options:
  --format=json|dot|mermaid|svg   output format (default json)
  --out=<file>                    write to a file instead of stdout
  --view=file|block|system        view to render for svg (default file)
  --include-declare               draw declare edges (dashed), off by default

Report options:
  --base=<ref>                    compare HEAD against this revision (change report)
  --format=md|json|html|pdf       repository report format (default md; pdf needs --out)
  --out=<file>                    write the report to a file instead of stdout
  --no-change                     omit the pending change set
  --no-smells / --no-hotspots / --no-ownership   skip an analysis (named as not computed)
  --fail-on <rules>               fail only for these rules (cycle, tier, …)

Check rules (only the ones named can fail the build):
  --fail-on-cycles
  --fail-on-layer-violations
  --fail-on-new-smells
  --fail-on-health-regression[=pct]
  --fail-on cycle,tier            comma-separated aliases for the same rules
  --baseline=<file>               baseline to compare against
  --write-baseline                record the current findings as the baseline
  --format=json                   machine-readable result

Environment: STRABO_ROOT, STRABO_CONFIG, STRABO_SCAN_CEILING, STRABO_STATE_DIR,
STRABO_AUTO_REBUILD, PORT, STRABO_HOST
`;

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'export':
      return runExportCommand(rest);
    case 'check':
      return runCheckCommand(rest);
    case 'report':
      return runReportCommand(rest);
    case 'summary':
      return runSummaryCommand(rest);
    case 'mcp':
      return runMcp(rest);
    case 'serve':
      return startServer(rest);
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    default:
      return startServer(argv);
  }
}

function runMcp(argv: readonly string[]): number {
  const config = configFromEnv(process.env, argv);
  startMcpServer(config);
  return 0;
}

function startServer(argv: readonly string[]): number {
  const env = readEnv(process.env, argv);
  const config = configFromEnv(process.env, argv);
  const app = createStraboServer(config);
  const httpServer = app.listen(env.port, env.host, () => {
    config.serverLog?.(`serving ${env.root} on http://${env.host}:${env.port}`);
    config.serverLog?.(`scan ceiling: ${env.scanCeiling}`);
    if (env.host === '0.0.0.0' || env.host === '::') {
      config.serverLog?.(
        'listening on every interface: anyone on the network can browse and read inside the scan ceiling',
      );
    }
  });
  // The standalone server owns its process, so Settings can relaunch it. An embedded host
  // never sets this, and `POST /settings/restart` then answers 501.
  config.restart = createRestart(httpServer);
  attachTerminal(httpServer, config);
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `[strabo] ${error instanceof Error ? error.message : 'command failed'}\n`,
      );
      process.exitCode = 1;
    });
}
