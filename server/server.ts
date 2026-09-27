import { createApp } from './app';
import { assertRequiredEnv } from './config';
import { loadCameras, setCameras } from './cameraRegistry';
import { loadProxyState } from './proxyState';
import { logger } from './logger';
import { startProxyStreams, stopProxyStreams } from './proxy/stream';

assertRequiredEnv();
setCameras(loadCameras());
loadProxyState();
const port = Number(process.env.PORT) || 8080;
const server = createApp().listen(port, () => {
  logger.info({ port }, 'cams listening');
});
// Cameras with a cam-proxy: subscribe to their event streams (Plan 6).
startProxyStreams();
process.once('SIGTERM', () => {
  stopProxyStreams();
  server.close();
});
