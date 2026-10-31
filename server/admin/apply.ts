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
// A trusted proxy (camera move, M1): the three proxy fields of TrustValues,
// per account (`<accountId>/<proxyId>`), confirmed once by an account admin.
export type ProxyTrustField = 'proxyUrl' | 'caFingerprints' | 'proxyTlsServername';
export type ProxyTrust = { proxyUrl: string | null; caFingerprints: string[]; proxyTlsServername: string | null };
export type HeldProxy = { accountId: string; proxyId: string; name: string; fields: ProxyTrustField[]; trusted: ProxyTrust | null /* null: new */; offered: ProxyTrust; digest: string };
export interface HeldChange { accountId: string; camsId: string; fields: TrustField[]; confirmed: TrustValues | null /* null: new, nothing confirmed yet */; offered: TrustValues; keptOld: boolean; isNew?: boolean }

// A camera's move as the snapshot marks it (camera move, M3): the move id,
// the proxy it is offered on, its id there and that proxy's site.
// `attested`: cams-admin's attestation of this very move (its id is the
// camera's moveId, its target the offered proxy), for the attested rules (#269).
export interface MoveAttestation { sourceProxyId: string; targetProxyId: string; expiresAt: number }
export interface MoveContext { moveId: string; proxyId: string; proxyCameraId: string; site: string | null; attested?: MoveAttestation }

export interface ApplyContext {
  // The camera's password from the local credentials (account name, camsId, the snapshot's user name).
  // Keyed by the account's id, never its name (security review I2).
  credentials: (accountId: string, camsId: string, user: string | null) => CredentialResult;
  // cams's token for the proxy URL the camera connects to (`url`: the
  // confirmed one while a change is held; client, and admin when it has
  // one). `proxy`: the snapshot entry of the proxy that owns that URL
  // (tokenOwner), if any: only its own tokens may go there; a legacy token
  // only when its entry names `url`. undefined: none usable yet.
  proxyToken?: (accountId: string, proxy: SnapProxy | undefined, camsId: string, url: string) => { token: string; adminToken?: string } | undefined;
  // The values to connect with: the confirmed ones while a change is held.
  // `confirmed` false: nothing confirmed yet (held as new) — no secrets at all.
  // `move`: the camera's move context when the snapshot marks it as moving
  // (S §9.2, M3); decide() applies it without a hold only by the move rule.
  // `via`: the camera is reached through its proxy only (spec 2026-10-30 §6.1): only the proxy's values count.
  trust?: (accountId: string, camsId: string, offered: TrustValues, move?: MoveContext, via?: { viaProxy: string }) => { use: TrustValues; confirmed: boolean; held: HeldChange | null };
  // The proxy ids of the account trusted at exactly this URL (tokenOwner).
  trustedProxiesAt?: (accountId: string, url: string) => string[];
  // Every proxy of the account, before its cameras are decided: a proxy's
  // offer (held proxy items, and the move rule refuses a held proxy).
  proxyOffer?: (accountId: string, proxy: SnapProxy) => void;
  // Whether the proxy at this URL takes camera calls (server/proxy/features.ts):
  // its cameras get no password here and no camera trust (spec 2026-10-30 §6.1).
  throughProxy?: (accountId: string, proxyUrl: string) => boolean;
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

// A snapshot proxy's three trust values, normalised as a camera's offer has them.
export function proxyTrustOf(p: SnapProxy | undefined): ProxyTrust {
  return {
    proxyUrl: p?.url ? p.url.replace(/\/+$/, '') : null,
    caFingerprints: (p?.caFingerprints ?? []).map((f) => normalizeFingerprint(f) ?? f).sort(),
    proxyTlsServername: p?.tlsServername ?? null,
  };
}

function offeredValues(c: SnapCamera, p: SnapProxy | undefined): TrustValues {
  return {
    ...proxyTrustOf(p),
    host: c.host,
    protocol: c.protocol === 'http' ? 'http' : 'https',
    tlsServername: c.tlsServername,
  };
}

// Which proxy id owns the URL a camera connects to (tokens are a proxy's):
// (1) the proxy trusted at that URL; else (2) the snapshot proxy at that
// URL; else (3) the offered proxy, when the URL is the camera's confirmed one
// (no other proxy claims it). Two claimants at one step: no owner.
function tokenOwner(ctx: ApplyContext, accountId: string, proxies: SnapProxy[], offered: SnapProxy, url: string, confirmed: boolean): string | undefined {
  const trusted = ctx.trustedProxiesAt?.(accountId, url) ?? [];
  if (trusted.length) return trusted.length === 1 ? trusted[0] : undefined;
  const at = proxies.filter((x) => x.url !== null && proxyTrustOf(x).proxyUrl === url);
  if (at.length) return at.length === 1 ? at[0].id : undefined;
  return confirmed ? offered.id : undefined;
}

export function buildFleet(parts: AccountPart[], ctx: ApplyContext): { accounts: FleetAccount[]; held: HeldChange[]; problems: Problem[] } {
  const held: HeldChange[] = [];
  const problems: Problem[] = [];
  const accounts = parts.map((part): FleetAccount => {
    const proxies = new Map(part.proxies.map((p) => [p.id, p]));
    const missingToken = new Set<string>();
    for (const p of part.proxies) ctx.proxyOffer?.(part.account.id, p);
    const cameras = part.cameras.map((c): CameraConfig => {
      const p = c.proxyId ? proxies.get(c.proxyId) : undefined;
      const offered = offeredValues(c, p);
      // A move context only with all its parts; anything less is no move (held as before).
      // The attestation only for this move onto this proxy; any other is ignored.
      const attested = c.move && c.move.id === c.moveId && p && c.move.targetProxyId === p.id
        ? { attested: { sourceProxyId: c.move.sourceProxyId, targetProxyId: c.move.targetProxyId, expiresAt: c.move.expiresAt } } : {};
      const move: MoveContext | undefined = c.moveId && p && c.proxyCameraId ? { moveId: c.moveId, proxyId: p.id, proxyCameraId: c.proxyCameraId, site: p.site, ...attested } : undefined;
      // A camera on a proxy that takes camera calls: reached through it only.
      const through = !!(p && offered.proxyUrl && ctx.throughProxy?.(part.account.id, offered.proxyUrl));
      const t = ctx.trust ? ctx.trust(part.account.id, c.camsId, offered, move, through && p ? { viaProxy: p.id } : undefined) : { use: offered, confirmed: true, held: null };
      if (t.held) held.push(t.held);
      const v = t.use;
      // Unconfirmed connection data: no token, no password (C1). Through the
      // proxy: no password at all (the proxy has it), so none is asked for.
      const cred: CredentialResult = !t.confirmed ? { ok: false, problem: 'missing', user: c.cameraUser } : through ? { ok: true, user: c.cameraUser ?? '', password: '' } : ctx.credentials(part.account.id, c.camsId, c.cameraUser);
      let proxy: ProxyConfig | undefined;
      if (t.confirmed && p && v.proxyUrl) {
        // The token of the proxy that owns the URL in use, never the offered proxy's when they differ (a held change).
        const ownerId = tokenOwner(ctx, part.account.id, part.proxies, p, v.proxyUrl, t.confirmed);
        const tok = ctx.proxyToken?.(part.account.id, ownerId ? proxies.get(ownerId) : undefined, c.camsId, v.proxyUrl);
        if (tok) {
          proxy = {
            url: v.proxyUrl,
            token: tok.token,
            ...(tok.adminToken && { adminToken: tok.adminToken }),
            camera: c.proxyCameraId ?? c.camsId,
            ...(v.caFingerprints.length && { caFingerprint: v.caFingerprints }),
            ...(v.proxyTlsServername && { tlsServername: v.proxyTlsServername }),
            ...(ownerId && { proxyId: ownerId }),
          };
          const ep = proxyEndpoint({ url: v.proxyUrl, pins: v.caFingerprints.length ? v.caFingerprints : null, tlsServername: v.proxyTlsServername });
          ctx.bind?.(tok.token, ep);
          if (tok.adminToken) ctx.bind?.(tok.adminToken, ep);
        } else missingToken.add(p.id);
      }
      if (cred.ok && cred.password && v.host && v.protocol) {
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
