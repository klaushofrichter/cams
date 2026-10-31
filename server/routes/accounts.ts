import { Router, type Request, type Response } from 'express';
import { cookieOptions } from '../loginConfig';
import { logger } from '../logger';
import { REMEMBER_COOKIE, membershipsOf } from '../membership';
import { currentUser, type AuthState } from '../middleware/requireAuth';
import { SESSION_COOKIE, SESSION_MAX_AGE_MS, signSession } from '../session';
import { getCamera } from '../cameraRegistry';
import { configMode, configStatus, reapplyConfig, reportSoon, trustStore } from '../configSource';
import type { HeldProxy, ProxyTrust, TrustField, TrustValues } from '../admin/trust';
import { sessionAccount } from './common';
import { credentialsFileSet, credentialsWritable, setCameraPassword } from '../credentials';
import { resetClients } from '../reolink/clients';
import type { CamKey } from '../fleet';
import { knownCamera, readJson, viaProxyFailed } from './common';
import { throughProxy } from '../proxy/features';
import { proxyAdminClient } from '../proxy/cameraCalls';
import { proxyCameraId } from '../proxy/client';

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
const validPassword = (p: unknown): p is string => typeof p === 'string' && p.length >= 1 && p.length <= 128 && !CONTROL.test(p);

// A camera reached through its proxy only (spec §6.2, §10.1): the password
// goes straight to the proxy (PUT /control/cameras/:cam/password, the
// proxy-admin token), which saves it only once the camera accepts it. cams
// stores, logs and echoes nothing of it.
const RELAYED: Record<number, string[]> = { 422: ['camera_refused'], 503: ['camera_offline'], 409: ['env_password', 'not_trusted', 'fingerprint_mismatch'], 429: ['too_many_attempts'] };
async function relayPassword(key: CamKey, password: string, req: Request, res: Response): Promise<void> {
  const by = currentUser(req)?.email;
  const done = (outcome: string) => logger.info({ cameraId: key, outcome, by }, 'camera_password_relayed');
  try {
    const up = await proxyAdminClient(key).open(`/control/cameras/${encodeURIComponent(proxyCameraId(key))}/password`, undefined, { method: 'PUT', body: JSON.stringify({ password }), timeoutMs: 20_000 });
    const body = (await readJson(up)) as { error?: unknown } | null;
    const error = typeof body?.error === 'string' ? body.error : '';
    if (up.ok) {
      done('saved');
      return void res.status(204).end();
    }
    if (RELAYED[up.status]?.includes(error)) {
      done(error);
      if (up.status === 429) {
        const ra = up.headers.get('retry-after');
        const s = ra && /^\d{1,6}$/.test(ra) ? Number(ra) : null;
        if (s !== null) res.setHeader('Retry-After', String(s));
        return void res.status(429).json({ error, ...(s !== null && { retryAfterS: s }) });
      }
      // The camera serves another certificate than the pinned one: trust it again first.
      return void res.status(up.status).json({ error: error === 'fingerprint_mismatch' ? 'fingerprint_changed' : error });
    }
    done('proxy_error');
    logger.warn({ cameraId: key, status: up.status }, 'camera_password_relay_failed');
    res.status(502).json({ error: 'proxy_unavailable' });
  } catch (err) {
    done('proxy_unavailable');
    viaProxyFailed(err, key, res, (e) => {
      throw e;
    });
  }
}

accountsRouter.put('/api/cameras/:id/credentials', async (req: Request, res: Response) => {
  const key = knownCamera(req, res);
  if (!key) return;
  const password = (req.body as { password?: unknown } | undefined)?.password;
  if (throughProxy(key)) {
    if (!validPassword(password)) return void res.status(400).json({ error: 'invalid', detail: 'a password of 1 to 128 characters' });
    return relayPassword(key, password, req, res);
  }
  if (configMode() !== 'cams-admin') return void res.status(409).json({ error: 'file_mode' });
  if (!validPassword(password)) return void res.status(400).json({ error: 'invalid', detail: 'a password of 1 to 128 characters' });
  const cam = getCamera(key)!;
  const user = cam.user;
  if (!credentialsWritable()) return void res.status(409).json({ error: 'credentials_read_only', reason: credentialsFileSet() ? 'read_only' : 'unset', secretKey: `${cam.accountId}/${cam.camsId}`, user });
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
// A held proxy as the banner shows it (camera move, M5): only the changed
// proxy fields, picked one by one (a loaded trust entry may carry more
// keys); `from` null: a new proxy. Its digest binds the offer and the
// revision it was offered in (the one proxyOffer recorded).
const pickProxy = (v: ProxyTrust, fields: HeldProxy['fields']): Partial<ProxyTrust> => Object.fromEntries(fields.map((f) => [f, v[f]]));
const proxyView = (h: HeldProxy) => ({ proxyId: h.proxyId, name: h.name, fields: h.fields, from: h.trusted ? pickProxy(h.trusted, h.fields) : null, to: pickProxy(h.offered, h.fields), digest: h.digest });
accountsRouter.get('/api/admin/held', (req: Request, res: Response) => {
  const account = sessionAccount(req, res).id;
  const store = trustStore();
  const items = (store?.held(account) ?? []).map((h) => ({
    camsId: h.camsId, fields: h.fields, from: pick(h.confirmed, h.fields), to: pick(h.offered, h.fields), keptOld: h.keptOld, isNew: !!h.isNew,
    digest: store!.offerDigest(account, h.camsId, revision()),
  }));
  res.json({ items, proxies: (store?.heldProxies(account) ?? []).map(proxyView) });
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

// Confirm a proxy once (camera move, S §9.2, M5): the session's account
// only, exactly the offers shown (digest), all or nothing. Cameras then
// move to it by the move rule; the rebuild applies a move waiting on it.
const PROXY_ID = /^prx_[0-9A-HJKMNP-TV-Z]{20}$/;
accountsRouter.post('/api/admin/held/proxies/confirm', (req: Request, res: Response) => {
  const items = (req.body as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items) || !items.length || items.length > 64
    || !items.every((i) => i && typeof i === 'object' && typeof i.proxyId === 'string' && PROXY_ID.test(i.proxyId) && typeof i.digest === 'string' && /^[0-9a-f]{64}$/.test(i.digest))) {
    return void res.status(400).json({ error: 'invalid', detail: 'items is a list of 1 to 64 {proxyId, digest}' });
  }
  const account = sessionAccount(req, res).id;
  const store = trustStore();
  const list = (items as { proxyId: string; digest: string }[]).map((i) => ({ proxyId: i.proxyId, digest: i.digest }));
  if (!store) return void res.status(409).json({ error: 'offer_changed', changed: list.map((i) => i.proxyId) });
  const r = store.confirmProxies(currentUser(req)!.email, account, list);
  if (!r.confirmed.length) return void res.status(409).json({ error: 'offer_changed', changed: r.changed });
  reapplyConfig();
  resetClients();
  logger.info({ accountId: account, proxyIds: r.confirmed }, 'held_proxy_confirmed');
  reportSoon(true);
  res.json({ confirmed: r.confirmed });
});
