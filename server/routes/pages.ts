import express, { Router, Request, Response } from 'express';
import { join, resolve } from 'path';
import { currentUser, noStore, requireAuthPage } from '../middleware/requireAuth';
import { createApiRateLimit } from '../middleware/rateLimit';

// dist/server/routes -> dist/web in the image; tests point WEB_DIST at fixtures.
export function webDir(): string {
  return process.env.WEB_DIST ?? resolve(__dirname, '../../web');
}

export function pagesRouter(dir: string): Router {
  const router = Router();
  // These handlers read files from disk; CodeQL (js/missing-rate-limiting)
  // requires a limiter in front of them, and it is sensible anyway.
  router.use(createApiRateLimit());

  router.get('/', (req: Request, res: Response) => {
    if (currentUser(req)) {
      res.redirect(302, '/app/live');
      return;
    }
    res.sendFile(join(dir, 'index.html'));
  });

  // Every /app path gets the SPA; its router picks the page (unknown -> Live).
  router.get(['/app', '/app/*splat'], noStore, requireAuthPage, (_req: Request, res: Response) => {
    res.sendFile(join(dir, 'app.html'));
  });

  // Hashed bundles are immutable; everything else (favicon, manifest) revalidates.
  router.use('/assets', express.static(join(dir, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));
  router.use((req, res, next) => {
    // The HTML entries are only reachable through the routes above, so the
    // auth decision can't be bypassed by requesting the file.
    if (req.path === '/index.html' || req.path === '/app.html') {
      res.status(404).send('Not found');
      return;
    }
    next();
  });
  router.use(express.static(dir, { index: false }));

  router.use((_req: Request, res: Response) => {
    res.status(404).type('text/plain').send('Not found');
  });
  return router;
}
