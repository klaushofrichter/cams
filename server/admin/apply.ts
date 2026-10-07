// From checked account parts to the fleet cams uses (migration P4): each
// camera keyed by account, its proxy (this instance's URL, the proxy's id
// for it, the pins), cams's own proxy token, the trust values an admin
// confirmed (Task 10) and the password found locally (Task 9). Pure: the
// stores are passed in as functions.
import { camKey, type FleetAccount } from '../fleet';
import type { CameraConfig, ProxyConfig } from '../cameraRegistry';
import { normalizeFingerprint } from '../tls/fingerprint';
import type { AccountPart, SnapCamera, SnapProxy } from './snapshot';

export type CredentialResult = { ok: true; user: string; password: string } | { ok: false; problem: 'missing' | 'mismatch'; user: string | null };
export interface Problem { code: string; accountId?: string; detail?: string }

export type TrustField = 'proxyUrl' | 'caFingerprints' | 'proxyTlsServername' | 'host' | 'protocol' | 'tlsServername';
export interface TrustValues { proxyUrl: string | null; caFingerprints: string[]; proxyTlsServername: string | null; host: string | null; protocol: 'https' | 'http' | null; tlsServername: string | null }
export interface HeldChange { accountId: string; camsId: string; fields: TrustField[]; confirmed: TrustValues; offered: TrustValues; keptOld: boolean }

export interface ApplyContext {
  // The camera's password from the local credentials (account name, camsId, the snapshot's user name).
  credentials: (accountName: string, camsId: string, user: string | null) => CredentialResult;
  // cams's token for this proxy (client, and admin when it has one); undefined: none usable yet.
  proxyToken?: (accountId: string, proxy: SnapProxy, camsId: string) => { token: string; adminToken?: string } | undefined;
  // The values to connect with: the confirmed ones while a change is held.
  trust?: (accountId: string, camsId: string, offered: TrustValues, hasCredentials: boolean) => { use: TrustValues; held: HeldChange | null };
}

export function offeredValues(c: SnapCamera, p: SnapProxy | undefined): TrustValues {
  return {
    proxyUrl: p?.url ? p.url.replace(/\/+$/, '') : null,
    caFingerprints: (p?.caFingerprints ?? []).map((f) => normalizeFingerprint(f) ?? f).sort(),
    proxyTlsServername: p?.tlsServername ?? null,
    host: c.host,
    protocol: c.protocol === 'http' ? 'http' : 'https',
    tlsServername: c.tlsServername,
  };
}

export function buildFleet(parts: AccountPart[], ctx: ApplyContext): { accounts: FleetAccount[]; held: HeldChange[]; problems: Problem[] } {
  const held: HeldChange[] = [];
  const problems: Problem[] = [];
  const accounts = parts.map((part): FleetAccount => {
    const proxies = new Map(part.proxies.map((p) => [p.id, p]));
    const missingToken = new Set<string>();
    const cameras = part.cameras.map((c): CameraConfig => {
      const p = c.proxyId ? proxies.get(c.proxyId) : undefined;
      const cred = ctx.credentials(part.account.name, c.camsId, c.cameraUser);
      const offered = offeredValues(c, p);
      const t = ctx.trust ? ctx.trust(part.account.id, c.camsId, offered, cred.ok) : { use: offered, held: null };
      if (t.held) held.push(t.held);
      const v = t.use;
      let proxy: ProxyConfig | undefined;
      if (p && v.proxyUrl) {
        const tok = ctx.proxyToken?.(part.account.id, p, c.camsId);
        if (tok) {
          proxy = {
            url: v.proxyUrl,
            token: tok.token,
            ...(tok.adminToken && { adminToken: tok.adminToken }),
            camera: c.proxyCameraId ?? c.camsId,
            ...(v.caFingerprints.length && { caFingerprint: v.caFingerprints }),
            ...(v.proxyTlsServername && { tlsServername: v.proxyTlsServername }),
            proxyId: p.id,
          };
        } else missingToken.add(p.id);
      }
      return {
        id: camKey(part.account.id, c.camsId),
        camsId: c.camsId,
        accountId: part.account.id,
        name: c.name,
        host: v.host ?? c.host,
        protocol: v.protocol ?? 'https',
        ...(v.tlsServername && { tlsServername: v.tlsServername }),
        user: cred.ok ? cred.user : (c.cameraUser ?? ''),
        password: cred.ok ? cred.password : '',
        ...(c.webUiUrl !== null && { webUiUrl: c.webUiUrl }),
        ...(c.webUiNote !== null && { webUiNote: c.webUiNote }),
        ...(proxy && { proxy }),
        credentials: cred.ok ? 'ok' : cred.problem,
      };
    });
    for (const id of missingToken) problems.push({ code: 'proxy_token_missing', accountId: part.account.id, detail: `proxy ${id}` });
    return { ...part.account, users: part.users, cameras };
  });
  return { accounts, held, problems };
}
