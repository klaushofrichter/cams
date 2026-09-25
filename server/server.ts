import { createApp } from './app';
import { assertRequiredEnv } from './config';
import { loadCameras, setCameras } from './cameraRegistry';
import { logger } from './logger';

assertRequiredEnv();
setCameras(loadCameras());
const port = Number(process.env.PORT) || 8080;
createApp().listen(port, () => {
  logger.info({ port }, 'cams listening');
});
