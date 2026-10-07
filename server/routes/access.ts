// The role table (migration P4, M §9.5, R4-9): one line for every /api
// route. Viewers read; admins change a camera, a proxy or the archive, or
// reach a proxy's admin side. A registered route without a line is refused
// (fail closed). File mode: everyone signed in is admin, so nothing changes.
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { logger } from '../logger';
import type { Principal } from '../middleware/requireAuth';

export type Need = 'signed-in' | 'viewer' | 'admin';

// Viewer writes (R4-9): their own preferences, the account picker, and the
// "save around" download (it reads recordings and writes only a temporary
// file on the proxy). Klaus may move compositions to admin: one line each.
export const VIEWER_WRITES: readonly string[] = [
  'PUT /api/preferences',
  'POST /api/session/account',
  'POST /api/cameras/:id/compositions',
  'DELETE /api/cameras/:id/compositions/:job',
];

export const ACCESS: Readonly<Record<string, Need>> = {
  // signed in, whatever the role (and while choosing an account)
  'GET /api/me': 'signed-in',
  'GET /api/accounts': 'signed-in',
  'POST /api/session/account': 'signed-in',
  // read
  'GET /api/cameras': 'viewer',
  'GET /api/events/stream': 'viewer',
  'GET /api/preferences': 'viewer',
  'GET /api/cameras/:id/status': 'viewer',
  'GET /api/cameras/:id/snapshot.jpg': 'viewer',
  'GET /api/cameras/:id/live': 'viewer',
  'GET /api/cameras/:id/days': 'viewer',
  'GET /api/cameras/:id/extent': 'viewer',
  'GET /api/cameras/:id/events': 'viewer',
  'GET /api/cameras/:id/clips/:clipId/video': 'viewer',
  'GET /api/cameras/:id/clips/:clipId/thumb.jpg': 'viewer',
  'GET /api/cameras/:id/clips/:clipId/download': 'viewer',
  'GET /api/cameras/:id/clips/:clipId/full-quality': 'viewer',
  'GET /api/cameras/:id/still-checks': 'viewer',
  'GET /api/cameras/:id/still-checks/:file': 'viewer',
  'GET /api/cameras/:id/analytics': 'viewer',
  'GET /api/cameras/:id/previews': 'viewer',
  'GET /api/cameras/:id/stills': 'viewer',
  'GET /api/cameras/:id/analyses/:eventId': 'viewer',
  'GET /api/cameras/:id/previews/:file': 'viewer',
  'GET /api/cameras/:id/stills/:file': 'viewer',
  'GET /api/cameras/:id/still/latest.jpg': 'viewer',
  'GET /api/cameras/:id/compositions/available': 'viewer',
  'GET /api/cameras/:id/compositions/:job': 'viewer',
  'GET /api/cameras/:id/compositions/:job/video': 'viewer',
  'GET /api/cameras/:id/settings': 'viewer',
  'GET /api/cameras/:id/device': 'viewer',
  'GET /api/cameras/:id/light': 'viewer',
  'GET /api/cameras/:id/proxy/info': 'viewer',
  'GET /api/archive': 'viewer',
  'GET /api/archive/status': 'viewer',
  'GET /api/archive/:via/items/:id': 'viewer',
  'GET /api/archive/:via/items/:id/video': 'viewer',
  'GET /api/archive/:via/items/:id/thumbnail': 'viewer',
  'GET /api/archive/:via/items/:id/metadata': 'viewer',
  'GET /api/archive/:via/zip': 'viewer',
  'GET /api/archive/:via/jobs/:job': 'viewer',
  // viewer writes
  'PUT /api/preferences': 'viewer',
  'POST /api/cameras/:id/compositions': 'viewer',
  'DELETE /api/cameras/:id/compositions/:job': 'viewer',
  // change
  'PUT /api/cameras/:id/name': 'admin',
  'PUT /api/cameras/:id/settings/:section': 'admin',
  'PUT /api/cameras/:id/light': 'admin',
  'POST /api/cameras/:id/reboot': 'admin',
  'PUT /api/cameras/:id/proxy': 'admin',
  'POST /api/cameras/:id/proxy/login-link': 'admin',
  'POST /api/cameras/:id/still-checks': 'admin',
  'POST /api/cameras/:id/archive': 'admin',
  'DELETE /api/archive/:via/jobs/:job': 'admin',
  'PATCH /api/archive/:via/items/:id': 'admin',
  'DELETE /api/archive/:via/items/:id': 'admin',
  'POST /api/archive/:via/delete': 'admin',
};

interface Layer { route?: { path: unknown; methods: Record<string, boolean> }; handle?: { stack?: Layer[] } }

// Every route the app registers under /api, as "METHOD /path" pieces.
export function registeredApiRoutes(app: Express): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  const walk = (stack: Layer[]) => {
    for (const l of stack) {
      if (l.route) {
        const paths = Array.isArray(l.route.path) ? l.route.path : [l.route.path];
        for (const p of paths) {
          if (typeof p !== 'string' || !p.startsWith('/api/') && p !== '/api') continue;
          for (const [m, on] of Object.entries(l.route.methods)) if (on && m !== '_all') out.push({ method: m.toUpperCase(), path: p });
        }
      } else if (l.handle?.stack) walk(l.handle.stack);
    }
  };
  const root = (app as unknown as { router?: { stack: Layer[] } }).router;
  if (root) walk(root.stack);
  const seen = new Set<string>();
  return out.filter((r) => (seen.has(`${r.method} ${r.path}`) ? false : (seen.add(`${r.method} ${r.path}`), true)));
}

const RANK: Record<Need, number> = { 'signed-in': 0, viewer: 1, admin: 2 };
// As Express matches (not strict, not case-sensitive): an optional trailing
// slash and any letter case reach the same route, so they meet the same rule.
const compile = (path: string) => new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z]+/g, '[^/]+')}/?$`, 'i');
const TABLE = Object.entries(ACCESS).map(([k, need]) => {
  const [method, path] = k.split(' ');
  return { method, re: compile(path), need };
});

// Mounted on /api right after requireAuthApi. The registered routes are
// read from the app on the first request (all routers are mounted by then).
export function accessMiddleware(): RequestHandler {
  let registered: { method: string; re: RegExp }[] | null = null;
  return (req: Request, res: Response, next: NextFunction) => {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const path = `${req.baseUrl}${req.path}`;
    const line = TABLE.find((t) => t.method === method && t.re.test(path));
    if (!line) {
      registered ??= registeredApiRoutes(req.app as Express).map((r) => ({ method: r.method, re: compile(r.path) }));
      if (registered.some((r) => r.method === method && r.re.test(path))) {
        logger.error({ method, path }, 'no_access_rule');
        res.status(403).json({ error: 'no_access_rule' });
        return;
      }
      return next(); // not a route: the JSON 404
    }
    if (line.need === 'signed-in') return next();
    const p = res.locals.principal as Principal | undefined;
    if (!p) return void res.status(401).json({ error: 'unauthorized' });
    if (RANK[p.role === 'admin' ? 'admin' : 'viewer'] < RANK[line.need]) {
      res.status(403).json({ error: 'forbidden_role' });
      return;
    }
    next();
  };
}
