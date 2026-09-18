import { configFromEnv, readEnv } from './config.ts';
import { createStraboServer } from './server.ts';

/** Start the standalone Strabo server from environment configuration. */
export function start(): void {
  const env = readEnv();
  const config = configFromEnv();
  const app = createStraboServer(config);

  app.listen(env.port, () => {
    config.serverLog?.(`serving ${env.root} on http://localhost:${env.port}`);
    config.serverLog?.(`scan ceiling: ${env.scanCeiling}`);
  });
}

start();
