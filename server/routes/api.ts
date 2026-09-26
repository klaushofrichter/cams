import { Router, Request, Response } from 'express';
import { currentUser, noStore, requireAuthApi } from '../middleware/requireAuth';
import { requireSameOrigin } from '../middleware/requireSameOrigin';
import { createApiRateLimit, createMediaRateLimit } from '../middleware/rateLimit';
import { listCameras } from '../cameraRegistry';
import { appVersion } from '../version';
import { camerasRouter } from './cameras';
import { recordingsRouter } from './recordings';
import { settingsRouter } from './settings';

export const apiRouter = Router();

apiRouter.use('/api', createApiRateLimit(), createMediaRateLimit(), noStore, requireSameOrigin, requireAuthApi);

apiRouter.get('/api/me', (req: Request, res: Response) => {
  res.json({ email: currentUser(req)!.email, version: appVersion() });
});

apiRouter.get('/api/cameras', (_req: Request, res: Response) => {
  res.json(listCameras());
});

apiRouter.use(camerasRouter);
apiRouter.use(recordingsRouter);
apiRouter.use(settingsRouter);

// Last on /api: an unknown API path is JSON, never the SPA's HTML.
apiRouter.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'not found' });
});
