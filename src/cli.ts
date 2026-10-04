import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

import { runCheckCommand } from './cli/check.ts';
import { runCoverageCommand } from './cli/coverage.ts';
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
  strabo --version                    print the installed version

Server options:
  --port=<n>                      port to listen on (default 3000, or PORT)
  --host=<addr>                   interface to bind (default 127.0.0.1, or STRABO_HOST)
  --allow-remote-terminal         serve the terminal and delegation to non-loopback peers
  strabo export [path] --format=<fmt> write a portable graph (json, dot, mermaid, svg)
  strabo check [path] [rules]         run headless checks for CI
  strabo report [path] --base <ref>   report a change against a base revision
  strabo report [path]                report the whole repository
  strabo summary [path]               the repository report, always repository-scoped
  strabo coverage [path]              test coverage at project, folder (--folder), or file (--file)
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
  --expect=<globs>                scope fence: comma-separated globs the change should stay in
  --no-change                     omit the pending change set
  --no-smells / --no-hotspots / --no-ownership / --no-drift / --no-api
                                  skip an analysis (named as not computed)
  --fail-on <rules>               fail only for these rules (cycle, tier, … or a strabo.rules id)

Coverage options:
  --file=<path>                   coverage for one file, with the tests that reach it
  --folder=<path>                 coverage for a folder and its subtree
  --threshold=<pct>               under-covered cut-off percent (default 50)
  --refresh                       run the repository's own coverage script first, then read it
  --format=json                   machine-readable result
  --out=<file>                    write to a file instead of stdout

Check rules (only the ones named can fail the build):
  --fail-on-cycles
  --fail-on-layer-violations
  --fail-on-new-smells
  --fail-on-health-regression[=pct]
  --fail-on cycle,tier            comma-separated aliases for the same rules
  --fail-on route-drift           routes and OpenAPI operations that disagree
  --baseline=<file>               baseline to compare against
  --write-baseline                record the current findings as the baseline
  --format=json                   machine-readable result

Environment: STRABO_ROOT, STRABO_CONFIG, STRABO_SCAN_CEILING, STRABO_STATE_DIR,
STRABO_AUTO_REBUILD, STRABO_COVERAGE_REPORT, STRABO_ALLOW_COVERAGE_REFRESH,
STRABO_ALLOW_REMOTE_TERMINAL, PORT, STRABO_HOST
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
    case 'coverage':
      return runCoverageCommand(rest);
    case 'mcp':
      return runMcp(rest);
    case 'serve':
      return startServer(rest);
    case 'version':
    case '--version':
    case '-v':
      process.stdout.write(`${readVersion()}\n`);
      return 0;
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
  // Fail before binding: a mistyped subcommand (`strabo exprot`) or path would otherwise
  // start a server whose every request errors.
  if (!isDirectory(env.root)) {
    process.stderr.write(`[strabo] "${env.root}" is not a directory. Run \`strabo --help\` for commands.\n`);
    return 1;
  }
  if (!Number.isInteger(env.port) || env.port < 0 || env.port > 65535) {
    process.stderr.write('[strabo] --port (or PORT) must be a whole number from 0 to 65535.\n');
    return 1;
  }
  const config = configFromEnv(process.env, argv);
  const app = createStraboServer(config);
  // Express 5 calls this on a failed bind too; the `error` handler below reports that case.
  const httpServer = app.listen(env.port, env.host, (error?: Error) => {
    if (error) {
      return;
    }
    config.serverLog?.(`serving ${env.root} on http://${env.host}:${env.port}`);
    config.serverLog?.(`scan ceiling: ${env.scanCeiling}`);
    if (env.host === '0.0.0.0' || env.host === '::') {
      config.serverLog?.(
        'listening on every interface: anyone on the network can browse and read inside the scan ceiling',
      );
      config.serverLog?.(
        config.allowRemoteTerminal
          ? 'remote terminal is ON: anyone who can reach this port can run commands as you'
          : 'terminal and delegation stay local to this machine (--allow-remote-terminal to share them)',
      );
    }
  });
  httpServer.on('error', (error: NodeJS.ErrnoException) => {
    const reason =
      error.code === 'EADDRINUSE'
        ? `port ${env.port} is already in use; pass --port <n> (or PORT=<n>) to pick another.`
        : error.code === 'EACCES'
          ? `not permitted to listen on ${env.host}:${env.port}.`
          : error.message;
    process.stderr.write(`[strabo] ${reason}\n`);
    process.exit(1);
  });
  // The standalone server owns its process, so Settings can relaunch it. An embedded host
  // never sets this, and `POST /settings/restart` then answers 501.
  config.restart = createRestart(httpServer);
  attachTerminal(httpServer, config);
  return 0;
}

function readVersion(): string {
  const manifest = new URL('../package.json', import.meta.url);
  return (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version: string }).version;
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
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
