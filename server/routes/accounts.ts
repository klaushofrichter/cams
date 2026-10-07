import { Router, type Request, type Response } from 'express';
import { cookieOptions } from '../loginConfig';
import { logger } from '../logger';
import { REMEMBER_COOKIE, membershipsOf } from '../membership';
import { currentUser, type AuthState } from '../middleware/requireAuth';
import { SESSION_COOKIE, SESSION_MAX_AGE_MS, signSession } from '../session';
import { getCamera } from '../cameraRegistry';
import { configMode, reapplyConfig } from '../configSource';
import { credentialsWritable, setCameraPassword } from '../credentials';
import { fleetAccount } from '../fleet';
import { resetClients } from '../reolink/clients';
import { knownCamera } from './common';

// The account picker (migration P4, M §9.5, R4-13): a person in several
// accounts chooses one after sign-in, and can switch later. The choice is
// the session cookie's `acc`; the role is looked up on every request.
export const accountsRouter = Router();
const REMEMBER_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

const stateOf = (res: Response): AuthState => res.locals.auth as AuthState;
const emailOf = (s: AuthState): string | null => (s.kind === 'ok' ? s.principal.email : s.kind === 'choose' ? s.email : null);

accountsRouter.get('/api/accounts', (req: Request, res: Response) => {
  const s = stateOf(res);
  const email = emailOf(s);
  if (!email) return void res.status(401).json({ error: 'unauthorized' });
  const current = s.kind === 'ok' ? s.principal.account.id : null;
  const remembered = typeof req.cookies?.[REMEMBER_COOKIE] === 'string' ? req.cookies[REMEMBER_COOKIE] : null;
  const list = s.kind === 'ok' && s.principal.via === 'token' ? [{ account: s.principal.account, role: s.principal.role }] : membershipsOf(email);
  res.json({
    items: list.map((m) => ({ id: m.account.id, name: m.account.name, displayName: m.account.displayName, role: m.role, current: m.account.id === current, remembered: m.account.id === remembered })),
  });
});

accountsRouter.post('/api/session/account', (req: Request, res: Response) => {
  const s = stateOf(res);
  if (s.kind === 'ok' && s.principal.via === 'token') return void res.status(409).json({ error: 'token_session' });
  const email = emailOf(s);
  if (!email) return void res.status(401).json({ error: 'unauthorized' });
  const accountId = (req.body as { accountId?: unknown } | undefined)?.accountId;
  const m = typeof accountId === 'string' ? membershipsOf(email).find((x) => x.account.id === accountId) : undefined;
  if (!m) return void res.status(404).json({ error: 'not_a_member' });
  res.cookie(SESSION_COOKIE, signSession(email, m.account.id), { ...cookieOptions(), maxAge: SESSION_MAX_AGE_MS });
  res.cookie(REMEMBER_COOKIE, m.account.id, { ...cookieOptions(), maxAge: REMEMBER_MAX_AGE_MS });
  logger.info({ kind: 'auth', accountId: m.account.id }, 'account_chosen');
  res.json({ redirect: '/app/video' });
});

// The camera login (M §9.8): an account admin enters a camera's password,
// saved to the local credentials file when it is writable (the Pi); else
// (a mounted Secret) the answer names the Secret's key and the user, never
// the password. Entering it is also the confirmation of a new camera's
// connection data (M §9.7).
const CONTROL = /[\u0000-\u001f\u007f]/;
accountsRouter.put('/api/cameras/:id/credentials', async (req: Request, res: Response) => {
  const key = knownCamera(req, res);
  if (!key) return;
  if (configMode() !== 'cams-admin') return void res.status(409).json({ error: 'file_mode' });
  const password = (req.body as { password?: unknown } | undefined)?.password;
  if (typeof password !== 'string' || password.length < 1 || password.length > 128 || CONTROL.test(password)) return void res.status(400).json({ error: 'invalid', detail: 'a password of 1 to 128 characters' });
  const cam = getCamera(key)!;
  const account = fleetAccount(cam.accountId)!;
  const user = cam.user;
  if (!credentialsWritable()) return void res.status(409).json({ error: 'credentials_read_only', secretKey: `${account.name}/${cam.camsId}`, user });
  await setCameraPassword(account.name, cam.camsId, user, password);
  resetClients();
  reapplyConfig();
  logger.info({ cameraId: key, by: currentUser(req)?.email }, 'camera_password_saved');
  res.status(204).end();
});
