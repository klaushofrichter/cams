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
import { readFileSync, statSync } from 'fs';
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

interface FileShape { v: 1; confirmed: Record<string, TrustValues>; keptOld: Record<string, TrustValues>; log: { at: number; email: string; accountId: string; camsIds: string[]; action: 'confirm' | 'keep' | 'seed' }[] }

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
    return new TrustStore(file, { v: 1, confirmed: d.confirmed, keptOld: d.keptOld ?? {}, log: Array.isArray(d.log) ? d.log.slice(-200) : [] }, true);
  }

  exists(): boolean {
    return this.present;
  }

  private save(): void {
    this.data.log = this.data.log.slice(-200);
    writePrivate(this.file, JSON.stringify(this.data, null, 2));
    this.present = true;
  }

  // R4-11: today's cameras.json is the confirmed state (once, at the first
  // cams-admin start); the file account's cameras, under its id.
  seedFromFile(account: AccountRef, cams: FileCameraConfig[]): void {
    if (this.present) return;
    for (const c of cams) this.data.confirmed[`${account.id}/${c.id}`] = trustValuesOf(c);
    this.data.log.push({ at: Date.now(), email: '', accountId: account.id, camsIds: cams.map((c) => c.id), action: 'seed' });
    this.save();
    logger.info({ accountId: account.id, cameras: cams.length }, 'trust_seeded');
  }

  // Which values a camera connects with now, and the held change if any.
  decide(accountId: string, camsId: string, offered: TrustValues, hasCredentials: boolean): { use: TrustValues; held: HeldChange | null } {
    const key = `${accountId}/${camsId}`;
    this.offers.set(key, offered);
    const confirmed = this.data.confirmed[key];
    if (!confirmed) {
      // New: entering the password (or having it) is the confirmation.
      if (hasCredentials) {
        this.data.confirmed[key] = offered;
        this.save();
      }
      return { use: offered, held: null };
    }
    const fields = differs(confirmed, offered);
    if (!fields.length) {
      if (this.data.keptOld[key]) {
        delete this.data.keptOld[key];
        this.save();
      }
      return { use: confirmed, held: null };
    }
    const kept = this.data.keptOld[key];
    return { use: confirmed, held: { accountId, camsId, fields, confirmed, offered, keptOld: !!kept && !differs(kept, offered).length } };
  }

  // A snapshot no longer lists some cameras: their offers are forgotten
  // (their confirmed values stay: a re-created camera is a change).
  forgetOffers(): void {
    this.offers.clear();
  }

  private act(accountId: string, camsIds: string[], email: string, action: 'confirm' | 'keep'): string[] {
    const done: string[] = [];
    for (const id of camsIds) {
      const key = `${accountId}/${id}`;
      const offered = this.offers.get(key);
      if (!offered || !this.data.confirmed[key] || !differs(this.data.confirmed[key], offered).length) continue;
      if (action === 'confirm') {
        this.data.confirmed[key] = offered;
        delete this.data.keptOld[key];
      } else this.data.keptOld[key] = offered;
      done.push(id);
    }
    if (done.length) {
      this.data.log.push({ at: Date.now(), email, accountId, camsIds: done, action });
      this.save();
    }
    return done;
  }

  async confirm(accountId: string, camsIds: string[], byEmail: string): Promise<string[]> {
    return this.act(accountId, camsIds, byEmail, 'confirm');
  }

  async keepOld(accountId: string, camsIds: string[], byEmail: string): Promise<string[]> {
    return this.act(accountId, camsIds, byEmail, 'keep');
  }

  // The held changes of the last decisions (one account, or all).
  held(accountId?: string): HeldChange[] {
    const out: HeldChange[] = [];
    for (const [key, offered] of this.offers) {
      const [acc, camsId] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
      if (accountId !== undefined && acc !== accountId) continue;
      const confirmed = this.data.confirmed[key];
      if (!confirmed) continue;
      const fields = differs(confirmed, offered);
      if (!fields.length) continue;
      const kept = this.data.keptOld[key];
      out.push({ accountId: acc, camsId, fields, confirmed, offered, keptOld: !!kept && !differs(kept, offered).length });
    }
    return out;
  }
}
