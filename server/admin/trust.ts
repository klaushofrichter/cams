// Held trust changes (migration P4, M6, M §9.7, R4-7, R4-11): the values
// that decide where cams sends a camera's password and whom it trusts —
// proxy URL, CA pins, proxy TLS name, camera host, protocol, camera TLS name
// — change only when an account admin confirms. Per camera, keyed by
// (account id, camsId), all six together: while a change is held, cams
// connects with all the confirmed values (never a mix). A camera deleted and
// re-created with the same camsId is a change, never "new".
//
// <data>/admin/trust.json (600): integrity-critical, so a corrupt one stops
// a cams-admin-mode start instead of being reset.
import { createHash } from 'crypto';
import { readFileSync, statSync } from 'fs';
import { jcs } from './jcs';
import { join } from 'path';
import type { FileCameraConfig, ProxyConfig } from '../cameraRegistry';
import type { AccountRef } from '../fleet';
import { logger } from '../logger';
import { normalizeFingerprint } from '../tls/fingerprint';
import { proxyTrustOf, type HeldChange, type HeldProxy, type MoveContext, type ProxyTrust, type ProxyTrustField, type TrustField, type TrustValues } from './apply';
import type { SnapCamera, SnapProxy } from './snapshot';
import { adminDir, checkPrivate, dataDir, writePrivate } from './keyfile';

export type { HeldChange, HeldProxy, ProxyTrust, TrustField, TrustValues };
export const TRUST_FIELDS: readonly TrustField[] = ['proxyUrl', 'caFingerprints', 'proxyTlsServername', 'host', 'protocol', 'tlsServername'];
export const PROXY_TRUST_FIELDS: readonly ProxyTrustField[] = ['proxyUrl', 'caFingerprints', 'proxyTlsServername'];

export function trustValuesOf(c: { proxy?: Pick<ProxyConfig, 'url' | 'caFingerprint' | 'tlsServername'>; host: string; protocol: 'https' | 'http'; tlsServername?: string }): TrustValues {
  return {
    proxyUrl: c.proxy ? c.proxy.url.replace(/\/+$/, '') : null,
    caFingerprints: (c.proxy?.caFingerprint ?? []).map((f) => normalizeFingerprint(f) ?? f).sort(),
    proxyTlsServername: c.proxy?.tlsServername ?? null,
    host: c.host,
    protocol: c.protocol,
    tlsServername: c.tlsServername ?? null,
  };
}

const differs = (a: TrustValues, b: TrustValues): TrustField[] => TRUST_FIELDS.filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
// The same comparison over the three proxy fields (M1).
const proxyDiffers = (a: ProxyTrust, b: ProxyTrust): ProxyTrustField[] => PROXY_TRUST_FIELDS.filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
const proxyPart = (v: ProxyTrust): ProxyTrust => ({ proxyUrl: v.proxyUrl, caFingerprints: v.caFingerprints, proxyTlsServername: v.proxyTlsServername });
const isProxyTrust = (v: unknown): v is ProxyTrust => {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && !Array.isArray(o) && (o.proxyUrl === null || typeof o.proxyUrl === 'string')
    && Array.isArray(o.caFingerprints) && o.caFingerprints.every((f) => typeof f === 'string')
    && (o.proxyTlsServername === null || typeof o.proxyTlsServername === 'string');
};
const isValues = (v: unknown): v is TrustValues => {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && Array.isArray(o.caFingerprints) && TRUST_FIELDS.every((f) => f in o);
};

// A log entry carries ids, never values. `proxyIds`: bare proxy ids for
// confirm-proxy, `<accountId>/<proxyId>` keys for seed-proxies (it spans accounts).
type LogEntry = { at: number; email: string; accountId: string; camsIds: string[]; action: 'confirm' | 'keep' | 'seed' | 'seed-proxies' | 'confirm-proxy' | 'move'; moveId?: string; proxyIds?: string[] };
// `proxies` absent: written before trusted proxies (seeded once, M2).
interface FileShape { v: 1; confirmed: Record<string, TrustValues>; keptOld: Record<string, TrustValues>; proxies?: Record<string, ProxyTrust>; fileAccountId?: string; log: LogEntry[] }

export class TrustStore {
  private offers = new Map<string, TrustValues>(); // the last offered values per camera (this process)
  private proxyOffers = new Map<string, { name: string; offered: ProxyTrust; revision: string }>(); // per `<accountId>/<proxyId>` (this process)
  private constructor(
    private readonly file: string,
    private data: FileShape,
    private present: boolean,
  ) {}

  static load(dir: string = dataDir()): TrustStore {
    const file = join(adminDir(dir), 'trust.json');
    try {
      statSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new TrustStore(file, { v: 1, confirmed: {}, keptOld: {}, log: [] }, false);
      throw err;
    }
    try {
      checkPrivate(file, 'EPERM_TRUST');
    } catch {
      throw new Error('admin/trust.json must be mode 600 in a 700 folder owned by this user (it decides where cams connects); fix it, do not delete it');
    }
    let d: Partial<FileShape>;
    try {
      d = JSON.parse(readFileSync(file, 'utf8')) as Partial<FileShape>;
    } catch {
      throw new Error('admin/trust.json is corrupt: restore it from a backup (cams will not start in cams-admin mode without it)');
    }
    if (d.v !== 1 || typeof d.confirmed !== 'object' || !d.confirmed || !Object.values(d.confirmed).every(isValues) || (d.keptOld && !Object.values(d.keptOld).every(isValues))
      || (d.proxies !== undefined && (typeof d.proxies !== 'object' || !d.proxies || Array.isArray(d.proxies) || !Object.values(d.proxies).every(isProxyTrust)))) {
      throw new Error('admin/trust.json is corrupt: restore it from a backup (cams will not start in cams-admin mode without it)');
    }
    return new TrustStore(file, { v: 1, confirmed: d.confirmed, keptOld: d.keptOld ?? {}, ...(d.proxies && { proxies: d.proxies }), ...(typeof d.fileAccountId === 'string' && { fileAccountId: d.fileAccountId }), log: Array.isArray(d.log) ? d.log.slice(-200) : [] }, true);
  }

  exists(): boolean {
    return this.present;
  }

  private save(): void {
    this.data.log = this.data.log.slice(-200);
    writePrivate(this.file, JSON.stringify(this.data, null, 2));
    this.present = true;
  }

  // The account id the file account (CAMS_FILE_ACCOUNT) had when the store
  // was seeded: a later snapshot naming another id for that name is not the
  // same account (security review I2).
  fileAccountId(): string | null {
    return this.data.fileAccountId ?? null;
  }

  // Records the file account's id once (the store may exist before that
  // account appeared, security re-review N2); a recorded id never moves.
  recordFileAccount(id: string): void {
    if (this.data.fileAccountId) return;
    this.data.fileAccountId = id;
    this.save();
    logger.info({ accountId: id }, 'file_account_recorded');
  }

  // R4-11: today's cameras.json is the confirmed state (once, at the first
  // cams-admin start); the file account's cameras, under its id.
  seedFromFile(account: AccountRef, cams: FileCameraConfig[]): void {
    if (this.present) return;
    for (const c of cams) this.data.confirmed[`${account.id}/${c.id}`] = trustValuesOf(c);
    this.data.fileAccountId = account.id;
    this.data.log.push({ at: Date.now(), email: '', accountId: account.id, camsIds: cams.map((c) => c.id), action: 'seed' });
    this.save();
    logger.info({ accountId: account.id, cameras: cams.length }, 'trust_seeded');
  }

  // Which values a camera connects with now, whether they are confirmed, and
  // the held change if any. Nothing is confirmed here: a camera without
  // confirmed values (new, re-created, another account id) is held as new
  // and gets no secrets until an admin confirms it (security review C1, I2).
  //
  // The one exception is the move rule (camera move, S §9.2, M3): a changed
  // offer of a confirmed camera that the snapshot marks as moving is
  // confirmed on the spot when it lands on a trusted proxy with exactly its
  // trusted values, whose own offer is not held, with host and protocol
  // unchanged and the camera's TLS name `<proxyCameraId>.<site>.internal`.
  decide(accountId: string, camsId: string, offered: TrustValues, move?: MoveContext): { use: TrustValues; confirmed: boolean; held: HeldChange | null } {
    const key = `${accountId}/${camsId}`;
    this.offers.set(key, offered);
    const confirmed = this.data.confirmed[key];
    if (!confirmed) return { use: offered, confirmed: false, held: this.heldOf(key, offered) };
    const fields = differs(confirmed, offered);
    if (fields.length && move && this.moveAllowed(accountId, confirmed, offered, move)) {
      this.data.confirmed[key] = offered;
      delete this.data.keptOld[key];
      this.data.log.push({ at: Date.now(), email: '', accountId, camsIds: [camsId], action: 'move', moveId: move.moveId });
      this.save();
      logger.info({ accountId, camsId, proxyId: move.proxyId, moveId: move.moveId }, 'camera_moved_trusted');
      return { use: offered, confirmed: true, held: null };
    }
    if (!fields.length) {
      if (this.data.keptOld[key]) {
        delete this.data.keptOld[key];
        this.save();
      }
      return { use: confirmed, confirmed: true, held: null };
    }
    return { use: confirmed, confirmed: true, held: this.heldOf(key, offered) };
  }

  // M3, every condition required: the offered proxy is the move's proxy, it
  // is offered in this snapshot and not held (Review Focus 1), trusted with
  // exactly the offered values; host and protocol are the confirmed ones;
  // the TLS name is the camera's name under the proxy's (non-null) site. A
  // moveId left set after the move excuses nothing else (Review Focus 2).
  private moveAllowed(accountId: string, confirmed: TrustValues, offered: TrustValues, move: MoveContext): boolean {
    const proxyKey = `${accountId}/${move.proxyId}`;
    const proxyOffer = this.proxyOffers.get(proxyKey);
    return !!move.moveId && !!move.proxyCameraId && !!move.site
      && offered.proxyUrl !== null
      && !!proxyOffer && !proxyDiffers(proxyOffer.offered, proxyPart(offered)).length && !this.heldProxyOf(proxyKey)
      && this.isTrusted(accountId, move.proxyId, offered)
      && offered.host !== null && offered.host === confirmed.host && offered.protocol !== null && offered.protocol === confirmed.protocol
      && offered.tlsServername === `${move.proxyCameraId}.${move.site}.internal`;
  }

  private heldOf(key: string, offered: TrustValues): HeldChange | null {
    const accountId = key.slice(0, key.indexOf('/')), camsId = key.slice(key.indexOf('/') + 1);
    const confirmed = this.data.confirmed[key] ?? null;
    const fields = confirmed ? differs(confirmed, offered) : [...TRUST_FIELDS];
    if (!fields.length) return null;
    const kept = this.data.keptOld[key];
    return { accountId, camsId, fields, confirmed, offered, keptOld: !!kept && !differs(kept, offered).length, isNew: !confirmed };
  }

  // A snapshot no longer lists some cameras: their offers are forgotten
  // (their confirmed values stay: a re-created camera is a change).
  forgetOffers(): void {
    this.offers.clear();
    this.proxyOffers.clear();
  }

  // The digest of the offer an admin is shown (and confirms): the camera, the
  // offered values and the snapshot revision (security review I1).
  offerDigest(accountId: string, camsId: string, revision: string): string | null {
    const offered = this.offers.get(`${accountId}/${camsId}`);
    return offered ? createHash('sha256').update(jcs({ camsId, offered, revision })).digest('hex') : null;
  }

  // Only the exact offer the admin saw, in the revision they saw it in, still
  // held: anything else is `changed` (the banner reads again). One-shot.
  private act(accountId: string, items: { camsId: string; digest: string }[], revision: string, email: string, action: 'confirm' | 'keep'): { done: string[]; changed: string[] } {
    const done: string[] = [], changed: string[] = [];
    for (const { camsId, digest } of items) {
      const key = `${accountId}/${camsId}`;
      const offered = this.offers.get(key);
      const h = offered ? this.heldOf(key, offered) : null;
      if (!offered || !h || (action === 'keep' && h.isNew) || this.offerDigest(accountId, camsId, revision) !== digest) {
        changed.push(camsId);
        continue;
      }
      if (action === 'confirm') {
        this.data.confirmed[key] = offered;
        delete this.data.keptOld[key];
      } else this.data.keptOld[key] = offered;
      done.push(camsId);
    }
    if (done.length) {
      this.data.log.push({ at: Date.now(), email, accountId, camsIds: done, action });
      this.save();
    }
    return { done, changed };
  }

  async confirm(accountId: string, items: { camsId: string; digest: string }[], revision: string, byEmail: string): Promise<{ done: string[]; changed: string[] }> {
    return this.act(accountId, items, revision, byEmail, 'confirm');
  }

  async keepOld(accountId: string, items: { camsId: string; digest: string }[], revision: string, byEmail: string): Promise<{ done: string[]; changed: string[] }> {
    return this.act(accountId, items, revision, byEmail, 'keep');
  }

  // The held changes of the last decisions (one account, or all).
  held(accountId?: string): HeldChange[] {
    const out: HeldChange[] = [];
    for (const [key, offered] of this.offers) {
      if (accountId !== undefined && key.slice(0, key.indexOf('/')) !== accountId) continue;
      const h = this.heldOf(key, offered);
      if (h) out.push(h);
    }
    return out;
  }

  // M2: once (the file has no `proxies` key yet), trust each proxy a
  // confirmed camera already uses with exactly the values it was confirmed
  // with. Only once trust.json exists: the camera seed (seedFromFile) comes
  // first, and a fresh store has nothing confirmed to seed from.
  seedProxiesOnce(accounts: { id: string; proxies: SnapProxy[]; cameras: SnapCamera[] }[]): void {
    if (!this.present || this.data.proxies) return;
    const proxies: Record<string, ProxyTrust> = {};
    for (const a of accounts) {
      const byId = new Map(a.proxies.map((p) => [p.id, p]));
      for (const c of a.cameras) {
        const p = c.proxyId ? byId.get(c.proxyId) : undefined;
        const confirmed = this.data.confirmed[`${a.id}/${c.camsId}`];
        if (!p || p.url === null || !confirmed) continue;
        const offered = proxyTrustOf(p);
        if (!proxyDiffers(proxyPart(confirmed), offered).length) proxies[`${a.id}/${p.id}`] = offered;
      }
    }
    this.data.proxies = proxies;
    this.data.log.push({ at: Date.now(), email: '', accountId: '', camsIds: [], proxyIds: Object.keys(proxies), action: 'seed-proxies' });
    this.save();
    logger.info({ proxies: Object.keys(proxies).length }, 'trust_proxies_seeded');
  }

  // The snapshot's offer for a proxy (like `offers` for cameras): what a held
  // proxy item shows and what its Confirm digest binds to.
  proxyOffer(accountId: string, proxy: SnapProxy, revision: string): void {
    this.proxyOffers.set(`${accountId}/${proxy.id}`, { name: proxy.displayName || proxy.name, offered: proxyTrustOf(proxy), revision });
  }

  // A camera may move to this proxy only with exactly its trusted values.
  isTrusted(accountId: string, proxyId: string, offered: ProxyTrust): boolean {
    const trusted = this.data.proxies?.[`${accountId}/${proxyId}`];
    return !!trusted && !proxyDiffers(trusted, proxyPart(offered)).length;
  }

  private proxyDigest(proxyId: string, offered: ProxyTrust, revision: string): string {
    return createHash('sha256').update(jcs({ proxyId, offered, revision })).digest('hex');
  }

  private heldProxyOf(key: string): HeldProxy | null {
    const o = this.proxyOffers.get(key);
    if (!o || o.offered.proxyUrl === null) return null; // a proxy without a URL carries no camera
    const accountId = key.slice(0, key.indexOf('/')), proxyId = key.slice(key.indexOf('/') + 1);
    const trusted = this.data.proxies?.[key] ?? null;
    const fields = trusted ? proxyDiffers(trusted, o.offered) : [...PROXY_TRUST_FIELDS];
    if (!fields.length) return null;
    return { accountId, proxyId, name: o.name, fields, trusted, offered: o.offered, digest: this.proxyDigest(proxyId, o.offered, o.revision) };
  }

  // Proxies offered with values no admin trusted (new, or a changed URL, pin
  // or TLS name): one account, or all.
  heldProxies(accountId?: string): HeldProxy[] {
    const out: HeldProxy[] = [];
    for (const key of this.proxyOffers.keys()) {
      if (accountId !== undefined && key.slice(0, key.indexOf('/')) !== accountId) continue;
      const h = this.heldProxyOf(key);
      if (h) out.push(h);
    }
    return out;
  }

  // Confirm (M5): only the exact offers the admin saw, still held, in the
  // revision they were offered in; one stale item and nothing is confirmed.
  confirmProxies(email: string, accountId: string, items: { proxyId: string; digest: string }[]): { confirmed: string[]; changed: string[] } {
    const ok: HeldProxy[] = [], changed: string[] = [];
    for (const { proxyId, digest } of items) {
      const h = this.heldProxyOf(`${accountId}/${proxyId}`);
      if (h && h.digest === digest) ok.push(h);
      else changed.push(proxyId);
    }
    if (changed.length || !ok.length) return { confirmed: [], changed };
    this.data.proxies ??= {};
    for (const h of ok) this.data.proxies[`${accountId}/${h.proxyId}`] = h.offered;
    const confirmed = ok.map((h) => h.proxyId);
    this.data.log.push({ at: Date.now(), email, accountId, camsIds: [], proxyIds: confirmed, action: 'confirm-proxy' });
    this.save();
    logger.info({ accountId, proxyIds: confirmed }, 'trust_proxies_confirmed');
    return { confirmed, changed: [] };
  }
}
