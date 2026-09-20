import { configFromEnv, readEnv } from './config.ts';
import { createStraboServer } from './server.ts';

/** Start the standalone Strabo server from its path argument and environment. */
export function start(): void {
  const argv = process.argv.slice(2);
  const env = readEnv(process.env, argv);
  const config = configFromEnv(process.env, argv);
  const app = createStraboServer(config);

  app.listen(env.port, () => {
    config.serverLog?.(`serving ${env.root} on http://localhost:${env.port}`);
    config.serverLog?.(`scan ceiling: ${env.scanCeiling}`);
  });
}

start();
