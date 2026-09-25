import { Router, Request, Response } from 'express';
import { appVersion } from '../version';

export const healthRouter = Router();

// Readiness probe, deploy smoke test and version-exporter all read this. It
// must never depend on a camera: an offline camera must not restart the pod.
healthRouter.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', version: appVersion() });
});
