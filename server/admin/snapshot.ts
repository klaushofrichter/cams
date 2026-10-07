// The cams-config snapshot (contract cams-v1, M §9.3): verified first (the
// signature against the pinned server keys, and this instance), then
// checked per account with cams's own camera rules (parseCameras and its
// group checks); an account that fails keeps its last good part (R4-16).
import { parseCameras, type FileCameraConfig } from '../cameraRegistry';
import { ACCOUNT_ID_RE, CAMS_ID_RE, type AccountRef, type FleetUser } from '../fleet';
import { verifySigned } from './sign';

export interface SnapToken { id: string; kind: 'client' | 'admin'; state: string; retireAt: number | null }
export interface SnapProxy { id: string; name: string; displayName: string; url: string | null; adminUiUrl: string | null; tlsServername: string | null; caFingerprints: string[]; tokens: SnapToken[] }
export interface SnapCamera {
  id: string; camsId: string; name: string; proxyId: string | null; proxyCameraId: string | null; host: string; protocol: string;
  tlsServername: string | null; cameraUser: string | null; webUiUrl: string | null; webUiNote: string | null;
}
export interface SnapAccount { id: string; name: string; displayName: string; revision: number; users: FleetUser[]; proxies: SnapProxy[]; cameras: SnapCamera[] }
export interface Snapshot { v: 1; type: 'cams-config'; instance: { id: string; name: string; rotateBefore: number | null }; revision: string; generatedAt: number; accounts: SnapAccount[]; sig: string }

const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function verifySnapshot(raw: unknown, serverKeys: string[], instanceId: string): { ok: true; snapshot: Snapshot } | { ok: false; reason: 'shape' | 'bad_signature' | 'wrong_instance' } {
  if (!obj(raw) || raw.v !== 1 || raw.type !== 'cams-config' || !obj(raw.instance) || typeof raw.instance.id !== 'string' || typeof raw.revision !== 'string'
    || typeof raw.generatedAt !== 'number' || !Array.isArray(raw.accounts) || !raw.accounts.every(obj) || typeof raw.sig !== 'string') {
    return { ok: false, reason: 'shape' };
  }
  if (!verifySigned(serverKeys, raw)) return { ok: false, reason: 'bad_signature' };
  if (raw.instance.id !== instanceId) return { ok: false, reason: 'wrong_instance' };
  return { ok: true, snapshot: raw as unknown as Snapshot };
}

export interface AccountPart { account: AccountRef; revision: number; users: FleetUser[]; proxies: SnapProxy[]; cameras: SnapCamera[] }

const str = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const strOrNull = (v: unknown, max = 2048) => v === null || (typeof v === 'string' && v.length <= max);
const fail = (detail: string): never => {
  throw new Error(detail.slice(0, 200));
};

// A placeholder secret per proxy: the snapshot carries none; parseCameras's
// group checks key on url + token, so each proxy gets its own.
const placeholder = (proxyId: string) => `placeholder-${proxyId}`.padEnd(40, 'x');

// One account's part, checked; throws with a short detail (no values).
function checkAccount(a: Record<string, unknown>): AccountPart {
  if (!str(a.id, 64) || !ACCOUNT_ID_RE.test(a.id) || !str(a.name, 64) || !str(a.displayName, 128) || typeof a.revision !== 'number') fail('account fields');
  if (!Array.isArray(a.users) || a.users.length > 500) fail('users');
  const users: FleetUser[] = (a.users as unknown[]).map((u, i) => {
    if (!obj(u) || !str(u.email, 320) || (u.role !== 'admin' && u.role !== 'viewer') || typeof u.disabled !== 'boolean') fail(`user ${i}`);
    const x = u as Record<string, unknown>;
    return { email: (x.email as string).toLowerCase(), role: x.role as 'admin' | 'viewer', disabled: x.disabled as boolean };
  });
  if (!Array.isArray(a.proxies) || a.proxies.length > 64) fail('proxies');
  const proxies = (a.proxies as unknown[]).map((p0, i) => {
    const p = (obj(p0) ? p0 : {}) as Record<string, unknown>;
    if (!obj(p0) || !str(p.id, 64) || !/^prx_/.test(p.id) || !strOrNull(p.url) || !strOrNull(p.tlsServername, 253) || !Array.isArray(p.caFingerprints) || !p.caFingerprints.every((f) => typeof f === 'string')) fail(`proxy ${i}`);
    const tokens = Array.isArray(p.tokens) ? (p.tokens as unknown[]).filter(obj).filter((t) => str(t.id, 64) && (t.kind === 'client' || t.kind === 'admin') && str(t.state, 16)) : [];
    return { id: p.id as string, name: String(p.name ?? ''), displayName: String(p.displayName ?? p.name ?? ''), url: (p.url as string | null) ?? null, adminUiUrl: typeof p.adminUiUrl === 'string' ? p.adminUiUrl : null,
      tlsServername: (p.tlsServername as string | null) ?? null, caFingerprints: p.caFingerprints as string[], tokens: tokens.map((t) => ({ id: t.id as string, kind: t.kind as 'client' | 'admin', state: t.state as string, retireAt: typeof t.retireAt === 'number' ? t.retireAt : null })) } as SnapProxy;
  });
  const byId = new Map(proxies.map((p) => [p.id, p]));
  if (!Array.isArray(a.cameras) || a.cameras.length > 256) fail('cameras');
  const cameras = (a.cameras as unknown[]).map((c0, i) => {
    const c = (obj(c0) ? c0 : {}) as Record<string, unknown>;
    if (!obj(c0) || !str(c.camsId, 32) || !CAMS_ID_RE.test(c.camsId) || !str(c.name, 128) || !str(c.host, 260) || typeof c.protocol !== 'string'
      || !strOrNull(c.proxyId, 64) || !strOrNull(c.proxyCameraId, 64) || !strOrNull(c.tlsServername, 253) || !strOrNull(c.cameraUser, 128) || !strOrNull(c.webUiUrl) || !strOrNull(c.webUiNote, 120)) fail(`camera ${i}`);
    if (c.proxyId !== null && !byId.has(c.proxyId as string)) fail(`camera ${i}: proxy`);
    return c as unknown as SnapCamera;
  });
  // cams's own rules (parseCameras: ids, protocol, host, TLS names, web
  // links, proxy URL and pins, groups), on the file shape with placeholders.
  const files: unknown[] = cameras.map((c) => {
    const p = c.proxyId ? byId.get(c.proxyId) : undefined;
    return {
      id: c.camsId, name: c.name, host: c.host, protocol: c.protocol, user: c.cameraUser || 'placeholder', password: 'placeholder',
      ...(c.tlsServername !== null && { tlsServername: c.tlsServername }),
      ...(c.webUiUrl !== null && { webUiUrl: c.webUiUrl }),
      ...(c.webUiNote !== null && { webUiNote: c.webUiNote }),
      ...(p && p.url !== null && {
        proxy: {
          url: p.url, token: placeholder(p.id),
          ...(c.proxyCameraId !== null && { camera: c.proxyCameraId }),
          ...(p.caFingerprints.length && { caFingerprint: p.caFingerprints }),
          ...(p.tlsServername !== null && { tlsServername: p.tlsServername }),
        },
      }),
    };
  });
  try {
    parseCameras(files, `account ${a.name as string}`);
  } catch (err) {
    fail((err as Error).message.replace(/^camera registry /, ''));
  }
  return { account: { id: a.id as string, name: a.name as string, displayName: a.displayName as string }, revision: a.revision as number, users, proxies, cameras };
}

export function accountParts(s: Snapshot): { ok: AccountPart[]; failed: { accountId: string; detail: string }[] } {
  const ok: AccountPart[] = [];
  const failed: { accountId: string; detail: string }[] = [];
  const seen = new Set<string>();
  for (const a of s.accounts as unknown as Record<string, unknown>[]) {
    const id = typeof a.id === 'string' ? a.id.slice(0, 64) : '?';
    try {
      if (seen.has(id)) fail('duplicate account');
      seen.add(id);
      ok.push(checkAccount(a));
    } catch (err) {
      failed.push({ accountId: id, detail: (err as Error).message.slice(0, 200) });
    }
  }
  return { ok, failed };
}

// The file shape of a checked snapshot camera (no secrets), for comparisons.
export type { FileCameraConfig };
