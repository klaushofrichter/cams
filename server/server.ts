import { createApp } from './app';
import { closeEventStreams } from './routes/events';
import { assertRequiredEnv } from './config';
import { logger } from './logger';
import { startConfig, stopConfig } from './configSource';
import { fleetEvents } from './fleet';
import { onFleetApplied } from './fleetApply';
import { startProxyStreams, stopProxyStreams } from './proxy/stream';
import { featureEvents, loadProxyFeatures } from './proxy/features';
import { reapplyConfig } from './configSource';
import { resetClients } from './reolink/clients';

async function main(): Promise<void> {
  assertRequiredEnv();
  // The fleet (CONFIG_SOURCE), the proxy switch and the TLS state, before listening.
  // Which proxies take camera calls (the per-proxy switch), before the fleet is built.
  loadProxyFeatures();
  await startConfig();
  // A proxy started or stopped announcing camera calls: the fleet again
  // (passwords, camera trust) and no direct client kept.
  featureEvents.on('through', () => {
    reapplyConfig();
    resetClients();
  });
  const port = Number(process.env.PORT) || 8080;
  const server = createApp().listen(port, () => {
    logger.info({ port }, 'cams listening');
  });
  // Cameras with a cam-proxy: subscribe to their event streams (Plan 6).
  startProxyStreams();
  // A new configuration from cams-admin: the cameras' clients and the
  // proxies' streams start again with it (new URLs, tokens, passwords).
  let stopping = false;
  fleetEvents.on('applied', () => {
    if (!stopping) onFleetApplied();
  });
  process.once('SIGTERM', () => {
    stopping = true;
    stopConfig();
    stopProxyStreams(true);
    closeEventStreams();
    server.close();
  });
}

main().catch((err: unknown) => {
  logger.fatal({ message: (err as Error).message }, 'start_failed');
  process.exit(1);
});
