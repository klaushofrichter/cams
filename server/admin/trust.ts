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
import type { HeldChange, TrustField, TrustValues } from './apply';
import { adminDir, checkPrivate, dataDir, writePrivate } from './keyfile';

export type { HeldChange, TrustField, TrustValues };
export const TRUST_FIELDS: readonly TrustField[] = ['proxyUrl', 'caFingerprints', 'proxyTlsServername', 'host', 'protocol', 'tlsServername'];

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
const isValues = (v: unknown): v is TrustValues => {
  const o = v as Record<string, unknown> | null;
  return !!o && typeof o === 'object' && Array.isArray(o.caFingerprints) && TRUST_FIELDS.every((f) => f in o);
};

interface FileShape { v: 1; confirmed: Record<string, TrustValues>; keptOld: Record<string, TrustValues>; fileAccountId?: string; log: { at: number; email: string; accountId: string; camsIds: string[]; action: 'confirm' | 'keep' | 'seed' }[] }

export class TrustStore {
  private offers = new Map<string, TrustValues>(); // the last offered values per camera (this process)
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
    if (d.v !== 1 || typeof d.confirmed !== 'object' || !d.confirmed || !Object.values(d.confirmed).every(isValues) || (d.keptOld && !Object.values(d.keptOld).every(isValues))) {
      throw new Error('admin/trust.json is corrupt: restore it from a backup (cams will not start in cams-admin mode without it)');
    }
    return new TrustStore(file, { v: 1, confirmed: d.confirmed, keptOld: d.keptOld ?? {}, ...(typeof d.fileAccountId === 'string' && { fileAccountId: d.fileAccountId }), log: Array.isArray(d.log) ? d.log.slice(-200) : [] }, true);
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
  decide(accountId: string, camsId: string, offered: TrustValues): { use: TrustValues; confirmed: boolean; held: HeldChange | null } {
    const key = `${accountId}/${camsId}`;
    this.offers.set(key, offered);
    const confirmed = this.data.confirmed[key];
    if (!confirmed) return { use: offered, confirmed: false, held: this.heldOf(key, offered) };
    const fields = differs(confirmed, offered);
    if (!fields.length) {
      if (this.data.keptOld[key]) {
        delete this.data.keptOld[key];
        this.save();
      }
      return { use: confirmed, confirmed: true, held: null };
    }
    return { use: confirmed, confirmed: true, held: this.heldOf(key, offered) };
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
}
