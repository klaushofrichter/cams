import { Router, Request, Response } from 'express';
import { noStore, requireAuthApi, type AuthState } from '../middleware/requireAuth';
import { membershipsOf } from '../membership';
import { configMode, configStatus, trustStore } from '../configSource';
import { accountsRouter } from './accounts';
import { accessMiddleware } from './access';
import { requireSameOrigin } from '../middleware/requireSameOrigin';
import { createApiRateLimit, createImageRateLimit, createMediaRateLimit } from '../middleware/rateLimit';
import { listCameras } from '../cameraRegistry';
import { appVersion, buildDate } from '../version';
import { camerasRouter } from './cameras';
import { recordingsRouter } from './recordings';
import { settingsRouter } from './settings';
import { preferencesRouter } from './preferences';
import { eventsRouter } from './events';
import { proxyRouter } from './proxy';
import { composeRouter } from './compose';
import { nameRouter } from './name';
import { stillChecksRouter } from './stillChecks';
import { archiveRouter } from './archive';
import { sessionAccount } from './common';

export const apiRouter = Router();

apiRouter.use('/api', createApiRateLimit(), createMediaRateLimit(), createImageRateLimit(), noStore, requireSameOrigin, requireAuthApi, accessMiddleware());

apiRouter.get('/api/me', (_req: Request, res: Response) => {
  const s = res.locals.auth as AuthState;
  const p = s.kind === 'ok' ? s.principal : null;
  const email = p ? p.email : s.kind === 'choose' ? s.email : '';
  res.json({
    email,
    version: appVersion(),
    buildDate: buildDate(),
    account: p ? { id: p.account.id, name: p.account.name, displayName: p.account.displayName } : null,
    role: p ? p.role : null,
    accounts: p?.via === 'token' ? 1 : membershipsOf(email).length,
    configSource: configMode(),
    // "configuration not refreshed since …": admins only.
    staleSince: p?.role === 'admin' ? configStatus().staleSince : null,
    // cams-admin refuses this instance (blocked, or its key revoked): admins re-enroll
    configProblem: p?.role === 'admin' ? configStatus().configProblem : null,
    // held trust changes waiting for this account's admins (not kept)
    held: p?.role === 'admin' ? (trustStore()?.held(p.account.id) ?? []).filter((h) => !h.keptOld).length : 0,
  });
});

apiRouter.use(accountsRouter);

apiRouter.get('/api/cameras', (req: Request, res: Response) => {
  res.json(listCameras(sessionAccount(req, res).id));
});

apiRouter.use(camerasRouter);
apiRouter.use(recordingsRouter);
apiRouter.use(settingsRouter);
apiRouter.use(preferencesRouter);
apiRouter.use(eventsRouter);
apiRouter.use(proxyRouter);
apiRouter.use(composeRouter);
apiRouter.use(nameRouter);
apiRouter.use(stillChecksRouter);
apiRouter.use(archiveRouter);

// Last on /api: an unknown API path is JSON, never the SPA's HTML.
apiRouter.use('/api', (_req: Request, res: Response) => {
  res.status(404).json({ error: 'not found' });
});
