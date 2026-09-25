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

  // Public files at the web root, by exact name. An allow-list rather than
  // express.static on the root, so the HTML entries can't be fetched past the
  // auth decision through encoded or differently-cased names (/%61pp.html, /APP.html).
  const PUBLIC_ROOT_FILES = new Set(['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png', 'icon-512.png', 'site.webmanifest']);

  router.get('/:file', (req: Request, res: Response, next) => {
    const file = req.params.file;
    if (typeof file === 'string' && PUBLIC_ROOT_FILES.has(file)) {
      res.sendFile(join(dir, file));
      return;
    }
    next();
  });

  router.use((_req: Request, res: Response) => {
    res.status(404).type('text/plain').send('Not found');
  });
  return router;
}
