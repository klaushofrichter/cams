import { getCamera } from '../cameraRegistry';
import type { CamKey } from '../fleet';
import type { StreamInfo } from '../reolink/client';
import { timeInfoFromProxy, type TimeInfo } from '../recordings/clipNames';
import { groupTrustOptions, ProxyClient, ProxyError, proxyPath, requireProxyClient } from './client';

// A camera's calls through its cam-proxy (cam-proxy spec
// 2026-10-30-camera-onboarding-design §4.8, §6.1): reads with the client
// token, camera-changing calls with the proxy-admin token cams holds per
// proxy. The proxy's answers are checked field by field here.

export interface ProxyCameraStatus {
  online: boolean;
  error: string | null;
  model: string | null;
  firmware: string | null;
  hardware: string | null;
  name: string | null;
  simulator: string | null;
  streams: { main: StreamInfo | null; sub: StreamInfo | null };
  sd: { mounted: boolean; capacityMB: number | null; freeMB: number | null } | null;
  time: TimeInfo | null;
  certificate: { subject: string; issuer: string; validTo: string } | null;
  credentials: { source: 'env' | 'store' | 'none'; authOk: boolean | null };
  tls: { mode: string; served: string | null; problem: 'untrusted' | 'changed' | null };
}

// cam-proxy's fingerprint form (SHA256: and 64 upper-case hex digits).
export const PROXY_FINGERPRINT = /^SHA256:[0-9A-F]{64}$/;

const text = (v: unknown, max = 128): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max && !/\p{C}/u.test(v) ? v : null);
const code = (v: unknown): string | null => (typeof v === 'string' && /^[a-z0-9_]{1,64}$/.test(v) ? v : null);
const size = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e9 ? v : null);

function stream(v: unknown): StreamInfo | null {
  const s = v as Partial<StreamInfo> | null;
  if (!s || typeof s !== 'object') return null;
  if (s.codec !== 'h264' && s.codec !== 'h265') return null;
  const dim = (x: unknown) => Number.isInteger(x) && (x as number) > 0 && (x as number) <= 16384;
  if (!dim(s.width) || !dim(s.height) || typeof s.fps !== 'number' || !(s.fps > 0 && s.fps <= 240)) return null;
  return { codec: s.codec, width: s.width!, height: s.height!, fps: s.fps };
}

function sd(v: unknown): ProxyCameraStatus['sd'] {
  const s = v as { mounted?: unknown; capacityMB?: unknown; freeMB?: unknown } | null;
  if (!s || typeof s !== 'object' || typeof s.mounted !== 'boolean') return null;
  return { mounted: s.mounted, capacityMB: size(s.capacityMB), freeMB: size(s.freeMB) };
}

function certificate(v: unknown): ProxyCameraStatus['certificate'] {
  const c = v as { subject?: unknown; issuer?: unknown; validTo?: unknown } | null;
  const subject = text(c?.subject, 512), issuer = text(c?.issuer, 512), validTo = text(c?.validTo, 64);
  return subject && issuer && validTo && Number.isFinite(Date.parse(validTo)) ? { subject, issuer, validTo } : null;
}

function credentials(v: unknown): ProxyCameraStatus['credentials'] {
  const c = v as { source?: unknown; authOk?: unknown } | null;
  const source = c?.source === 'env' || c?.source === 'store' || c?.source === 'none' ? c.source : 'none';
  return { source, authOk: typeof c?.authOk === 'boolean' ? c.authOk : null };
}

function tls(v: unknown): ProxyCameraStatus['tls'] {
  const t = v as { mode?: unknown; served?: unknown; problem?: unknown } | null;
  return {
    mode: code(t?.mode) ?? 'unknown',
    served: typeof t?.served === 'string' && PROXY_FINGERPRINT.test(t.served) ? t.served : null,
    problem: t?.problem === 'untrusted' || t?.problem === 'changed' ? t.problem : null,
  };
}

// The proxy's GET /api/cameras/:cam/status; null when `online` is not a boolean.
export function parseProxyStatus(v: unknown): ProxyCameraStatus | null {
  const s = v as Record<string, unknown> | null;
  if (!s || typeof s !== 'object' || typeof s.online !== 'boolean') return null;
  const st = (s.streams ?? {}) as { main?: unknown; sub?: unknown };
  return {
    online: s.online,
    error: code(s.error),
    model: text(s.model, 64),
    firmware: text(s.firmware, 64),
    hardware: text(s.hardware, 64),
    name: text(s.name, 64),
    simulator: text(s.simulator, 64),
    streams: { main: stream(st?.main), sub: stream(st?.sub) },
    sd: sd(s.sd),
    time: timeInfoFromProxy(s.time),
    certificate: certificate(s.certificate),
    credentials: credentials(s.credentials),
    tls: tls(s.tls),
  };
}

export async function readProxyStatus(id: CamKey, o: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ProxyCameraStatus> {
  const raw = await requireProxyClient(id).json<unknown>(proxyPath(id, '/status'), undefined, { ...(o.timeoutMs !== undefined && { timeoutMs: o.timeoutMs }), ...(o.signal && { signal: o.signal }) });
  const s = parseProxyStatus(raw);
  if (!s) throw new ProxyError('proxy_error', 'cam-proxy sent a status cams cannot read');
  // Another zone or DST rule than the cached one: the new one at once.
  const hit = times.get(id);
  if (s.time && hit && JSON.stringify(hit.value) !== JSON.stringify(s.time)) times.set(id, { at: Date.now(), value: s.time });
  return s;
}

// The camera-changing calls' client: the proxy-admin token with the same trust as the client token's.
export function proxyAdminClient(id: CamKey): ProxyClient {
  const proxy = getCamera(id)?.proxy;
  if (!proxy?.adminToken) throw new ProxyError('proxy_admin_missing', 'cams has no admin token for this cam-proxy', 403);
  return new ProxyClient({ url: proxy.url, token: proxy.adminToken }, { timeoutMs: 20_000, ...groupTrustOptions(id) });
}

// The camera's time and zone from its proxy, cached 10 minutes (and replaced
// whenever a status read shows another); callers at once share one read.
const TIME_MS = 600_000;
const times = new Map<CamKey, { at: number; value: TimeInfo }>();
const pending = new Map<CamKey, Promise<TimeInfo>>();
export function proxyTimeInfo(id: CamKey): Promise<TimeInfo> {
  const hit = times.get(id);
  if (hit && Date.now() - hit.at < TIME_MS) return Promise.resolve(hit.value);
  let p = pending.get(id);
  if (!p) {
    p = readProxyStatus(id)
      .then((s) => {
        if (!s.time) throw new ProxyError('proxy_error', 'cam-proxy has no time for the camera yet');
        times.set(id, { at: Date.now(), value: s.time });
        return s.time;
      })
      .finally(() => pending.delete(id));
    pending.set(id, p);
  }
  return p;
}

export function resetProxyCameraCalls(): void {
  times.clear();
  pending.clear();
}
