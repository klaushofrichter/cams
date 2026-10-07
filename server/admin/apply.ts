// From checked account parts to the fleet cams uses (migration P4): each
// camera keyed by account, its proxy (this instance's URL, the proxy's id
// for it, the pins), cams's own proxy token, the trust values an admin
// confirmed (Task 10) and the password found locally (Task 9). Pure: the
// stores are passed in as functions.
import { camKey, type FleetAccount } from '../fleet';
import type { CameraConfig, ProxyConfig } from '../cameraRegistry';
import { normalizeFingerprint } from '../tls/fingerprint';
import type { AccountPart, SnapCamera, SnapProxy } from './snapshot';
import { cameraEndpoint, proxyEndpoint } from '../secretGuard';

export type CredentialResult = { ok: true; user: string; password: string } | { ok: false; problem: 'missing' | 'mismatch'; user: string | null };
export interface Problem { code: string; accountId?: string; detail?: string }

export type TrustField = 'proxyUrl' | 'caFingerprints' | 'proxyTlsServername' | 'host' | 'protocol' | 'tlsServername';
export interface TrustValues { proxyUrl: string | null; caFingerprints: string[]; proxyTlsServername: string | null; host: string | null; protocol: 'https' | 'http' | null; tlsServername: string | null }
export interface HeldChange { accountId: string; camsId: string; fields: TrustField[]; confirmed: TrustValues | null /* null: new, nothing confirmed yet */; offered: TrustValues; keptOld: boolean; isNew?: boolean }

export interface ApplyContext {
  // The camera's password from the local credentials (account name, camsId, the snapshot's user name).
  // Keyed by the account's id, never its name (security review I2).
  credentials: (accountId: string, camsId: string, user: string | null) => CredentialResult;
  // cams's token for this proxy (client, and admin when it has one); undefined: none usable yet.
  proxyToken?: (accountId: string, proxy: SnapProxy, camsId: string) => { token: string; adminToken?: string } | undefined;
  // The values to connect with: the confirmed ones while a change is held.
  // `confirmed` false: nothing confirmed yet (held as new) — no secrets at all.
  trust?: (accountId: string, camsId: string, offered: TrustValues) => { use: TrustValues; confirmed: boolean; held: HeldChange | null };
  // Binds a secret to the confirmed endpoint it may go to (server/secretGuard.ts).
  bind?: (secret: string, endpoint: string) => void;
}

// A camera's web link from cams-admin only on its own (confirmed) host or TLS
// name: any other link is dropped for the default (security review M5).
function webUiUrlOk(url: string, v: TrustValues): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    const host = (v.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
    return h === host || (!!v.tlsServername && h === v.tlsServername.toLowerCase());
  } catch {
    return false;
  }
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
      const offered = offeredValues(c, p);
      const t = ctx.trust ? ctx.trust(part.account.id, c.camsId, offered) : { use: offered, confirmed: true, held: null };
      if (t.held) held.push(t.held);
      const v = t.use;
      // Unconfirmed connection data: no token, no password (C1).
      const cred: CredentialResult = t.confirmed ? ctx.credentials(part.account.id, c.camsId, c.cameraUser) : { ok: false, problem: 'missing', user: c.cameraUser };
      let proxy: ProxyConfig | undefined;
      if (t.confirmed && p && v.proxyUrl) {
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
          const ep = proxyEndpoint({ url: v.proxyUrl, pins: v.caFingerprints.length ? v.caFingerprints : null, tlsServername: v.proxyTlsServername });
          ctx.bind?.(tok.token, ep);
          if (tok.adminToken) ctx.bind?.(tok.adminToken, ep);
        } else missingToken.add(p.id);
      }
      if (cred.ok && v.host && v.protocol) {
        ctx.bind?.(cred.password, cameraEndpoint({ protocol: v.protocol, host: v.host, tlsServername: v.tlsServername, pins: proxy?.caFingerprint ?? null }));
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
        ...(c.webUiUrl !== null && webUiUrlOk(c.webUiUrl, v) && { webUiUrl: c.webUiUrl }),
        ...(c.webUiNote !== null && { webUiNote: c.webUiNote }),
        ...(proxy && { proxy }),
        credentials: !t.confirmed ? 'unconfirmed' : cred.ok ? 'ok' : cred.problem,
      };
    });
    for (const id of missingToken) problems.push({ code: 'proxy_token_missing', accountId: part.account.id, detail: `proxy ${id}` });
    return { ...part.account, users: part.users, cameras };
  });
  return { accounts, held, problems };
}
