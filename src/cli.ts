import { configFromEnv, readEnv } from './config.ts';
import { createStraboServer } from './server.ts';

/** Start the standalone Strabo server from its path argument and environment. */
export function start(): void {
  const argv = process.argv.slice(2);
  const env = readEnv(process.env, argv);
  const config = configFromEnv(process.env, argv);
  const app = createStraboServer(config);

  app.listen(env.port, env.host, () => {
    config.serverLog?.(`serving ${env.root} on http://${env.host}:${env.port}`);
    config.serverLog?.(`scan ceiling: ${env.scanCeiling}`);
    if (env.host === '0.0.0.0' || env.host === '::') {
      config.serverLog?.(
        'listening on every interface: anyone on the network can browse and read inside the scan ceiling',
      );
    }
  });
}

start();
