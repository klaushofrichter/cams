import { Router, type Request, type Response } from 'express';
import { cookieOptions } from '../loginConfig';
import { logger } from '../logger';
import { REMEMBER_COOKIE, membershipsOf } from '../membership';
import { currentUser, type AuthState } from '../middleware/requireAuth';
import { SESSION_COOKIE, SESSION_MAX_AGE_MS, signSession } from '../session';
import { getCamera } from '../cameraRegistry';
import { configMode, configStatus, reapplyConfig, reportSoon, trustStore } from '../configSource';
import type { TrustField, TrustValues } from '../admin/trust';
import { sessionAccount } from './common';
import { credentialsWritable, setCameraPassword } from '../credentials';
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
// the password. Keyed by the account's id (security review I2). It confirms
// nothing: a new camera's connection data is confirmed on the held list.
const CONTROL = /[\u0000-\u001f\u007f]/;
accountsRouter.put('/api/cameras/:id/credentials', async (req: Request, res: Response) => {
  const key = knownCamera(req, res);
  if (!key) return;
  if (configMode() !== 'cams-admin') return void res.status(409).json({ error: 'file_mode' });
  const password = (req.body as { password?: unknown } | undefined)?.password;
  if (typeof password !== 'string' || password.length < 1 || password.length > 128 || CONTROL.test(password)) return void res.status(400).json({ error: 'invalid', detail: 'a password of 1 to 128 characters' });
  const cam = getCamera(key)!;
  const user = cam.user;
  if (!credentialsWritable()) return void res.status(409).json({ error: 'credentials_read_only', secretKey: `${cam.accountId}/${cam.camsId}`, user });
  await setCameraPassword(cam.accountId, cam.camsId, user, password);
  resetClients();
  reapplyConfig();
  logger.info({ cameraId: key, by: currentUser(req)?.email }, 'camera_password_saved');
  res.status(204).end();
});

// Held trust changes (M §9.7): the session's account only. Each item carries
// the digest of the offer shown; Confirm / Keep old act only on that exact
// offer in that revision (security review I1).
const pick = (v: TrustValues | null, fields: TrustField[]): Partial<TrustValues> => (v ? Object.fromEntries(fields.map((f) => [f, v[f]])) : {});
const revision = () => configStatus().appliedRevision ?? '';
accountsRouter.get('/api/admin/held', (req: Request, res: Response) => {
  const account = sessionAccount(req, res).id;
  const store = trustStore();
  const items = (store?.held(account) ?? []).map((h) => ({
    camsId: h.camsId, fields: h.fields, from: pick(h.confirmed, h.fields), to: pick(h.offered, h.fields), keptOld: h.keptOld, isNew: !!h.isNew,
    digest: store!.offerDigest(account, h.camsId, revision()),
  }));
  res.json({ items });
});

function heldAction(action: 'confirm' | 'keep') {
  return async (req: Request, res: Response) => {
    const items = (req.body as { items?: unknown } | undefined)?.items;
    if (!Array.isArray(items) || !items.length || items.length > 256
      || !items.every((i) => i && typeof i === 'object' && typeof i.camsId === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(i.camsId) && typeof i.digest === 'string' && /^[0-9a-f]{64}$/.test(i.digest))) {
      return void res.status(400).json({ error: 'invalid', detail: 'items is a list of {camsId, digest}' });
    }
    const account = sessionAccount(req, res).id;
    const store = trustStore();
    const list = items as { camsId: string; digest: string }[];
    // All or nothing: one offer that changed since it was shown and nothing is done.
    const stale = list.filter((i) => !store || store.offerDigest(account, i.camsId, revision()) !== i.digest).map((i) => i.camsId);
    if (stale.length) return void res.status(409).json({ error: 'offer_changed', changed: stale });
    const before = new Map((store!.held(account)).map((h) => [h.camsId, h.fields]));
    const r = await (action === 'confirm' ? store!.confirm(account, list, revision(), currentUser(req)!.email) : store!.keepOld(account, list, revision(), currentUser(req)!.email));
    if (r.changed.length && !r.done.length) return void res.status(409).json({ error: 'offer_changed', changed: r.changed });
    const done = r.done;
    if (done.length) {
      reapplyConfig();
      resetClients();
      const fields = [...new Set(done.flatMap((id) => before.get(id) ?? []))];
      logger.info({ accountId: account, camsIds: done, fields, email: currentUser(req)!.email }, action === 'confirm' ? 'held_change_confirmed' : 'held_change_kept');
      reportSoon(true);
    }
    res.json(action === 'confirm' ? { confirmed: done } : { kept: done });
  };
}
accountsRouter.post('/api/admin/held/confirm', heldAction('confirm'));
accountsRouter.post('/api/admin/held/keep', heldAction('keep'));
