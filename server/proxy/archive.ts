import { getProxyClient, proxyCameraId, type ProxyClient } from './client';
import { activeMembers, proxyGroups, type ProxyGroup } from './groups';
import { LABEL, QUALITIES } from '../archiveRules';
import { accountIdOf, camsIdOf, type CamKey } from '../fleet';

// The Archive (cam-proxy's archive contract, docs/archive.md there): one per
// cam-proxy. cams reaches a proxy through a camera that uses it (`via`, the
// first such camera by the configuration's order), so a proxy shared by two
// cameras is asked once and its ids stay unique per `via`. Every item is
// rebuilt here from checked fields: no proxy URL or unchecked value reaches
// the browser.

export interface ArchiveProxy {
  via: string; // the camsId (within the account) the proxy is reached through: what URLs carry
  viaKey: CamKey; // the same camera's key
  client: ProxyClient;
  cams: CamKey[]; // the cams cameras that use this proxy
  toCams: Map<string, string>; // the proxy's camera id → cams's camsId (same account)
  group: ProxyGroup; // the same object as the event stream's (spec 2026-10-05 §12.4)
}

// One account's proxies in use (a switched-off camera is left out, as
// everywhere). Never another account's: a proxy group belongs to one account.
export function archiveProxies(accountId: string): ArchiveProxy[] {
  const out: ArchiveProxy[] = [];
  for (const group of proxyGroups()) {
    if (group.accountId !== accountId) continue;
    const cams = activeMembers(group);
    const client = cams.length ? getProxyClient(cams[0]) : undefined;
    if (!client) continue;
    const toCams = new Map<string, string>();
    for (const id of cams) {
      const remote = group.remoteOf.get(id)!;
      if (!toCams.has(remote)) toCams.set(remote, camsIdOf(id));
    }
    out.push({ via: camsIdOf(cams[0]), viaKey: cams[0], client, cams, toCams, group });
  }
  return out;
}

// `via` is a camsId of the account (from a URL): resolved within it only.
export function archiveProxy(accountId: string, via: string): ArchiveProxy | undefined {
  return archiveProxies(accountId).find((p) => p.via === via);
}

// The proxy (and its id for the camera) of one cams camera.
export function proxyOfCamera(id: CamKey): { proxy: ArchiveProxy; remote: string } | undefined {
  const proxy = archiveProxies(accountIdOf(id)).find((p) => p.cams.includes(id));
  return proxy && { proxy, remote: proxyCameraId(id) };
}

export interface ArchiveItem {
  via: string;
  id: number;
  cam: string; // the proxy's camera id
  camera: string | null; // cams's camera id, when cams knows the camera
  cameraName: string;
  name: string;
  labels: string[];
  retentionDays: number | null;
  createdAt: number;
  expiresAt: number | null;
  recordedFrom: number;
  recordedTo: number;
  durationS: number;
  quality: string;
  original: boolean;
  bytes: number;
  source: Record<string, string | number | boolean | null | { start: number; end: number }>;
  eventKinds: string[];
  found: string[];
  thumbnail: { from: string; at: number | null };
  createdBy: string;
  urls: { video: string; download: string; thumbnail: string | null; metadata: string };
}

const int = (v: unknown): v is number => Number.isSafeInteger(v);
const intOrNull = (v: unknown): v is number | null => v === null || int(v);
const WORD = /^[a-z0-9_-]{1,32}$/;
const words = (v: unknown, re = WORD): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && re.test(x)).slice(0, 64) : []);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const SOURCE_TYPES = ['composition', 'clip', 'recording'];
// What an item's source may say, field by field (contract §1).
const SOURCE_FIELDS: Record<string, 'int' | 'num' | 'word' | 'bool' | 'text'> = {
  jobId: 'word', anchor: 'word', clipId: 'int', at: 'int', preS: 'num', postS: 'num', size: 'word', badge: 'bool', stream: 'word', recording: 'text',
};

function source(v: unknown): ArchiveItem['source'] {
  const s = (v ?? {}) as Record<string, unknown>;
  const out: ArchiveItem['source'] = { type: typeof s.type === 'string' && SOURCE_TYPES.includes(s.type) ? s.type : 'unknown' };
  for (const [k, kind] of Object.entries(SOURCE_FIELDS)) {
    const x = s[k];
    if (kind === 'int' && int(x)) out[k] = x;
    else if (kind === 'num' && typeof x === 'number' && Number.isFinite(x)) out[k] = x;
    else if (kind === 'word' && typeof x === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(x)) out[k] = x;
    else if (kind === 'bool' && typeof x === 'boolean') out[k] = x;
    else if (kind === 'text' && typeof x === 'string') out[k] = x.slice(0, 160);
  }
  const span = s.span as { start?: unknown; end?: unknown } | null | undefined;
  if (span && int(span.start) && int(span.end)) out.span = { start: span.start, end: span.end };
  return out;
}

export const itemBase = (via: string, id: number) => `/api/archive/${encodeURIComponent(via)}/items/${id}`;

// An item from the proxy, or null when it isn't one.
export function parseItem(x: unknown, proxy: Pick<ArchiveProxy, 'via' | 'toCams'>): ArchiveItem | null {
  const r = (x ?? {}) as Record<string, unknown>;
  if (!int(r.id) || r.id < 1 || typeof r.cam !== 'string' || !r.cam || r.cam.length > 64) return null;
  if (!int(r.createdAt) || !intOrNull(r.expiresAt) || !int(r.recordedFrom) || !int(r.recordedTo) || !int(r.bytes) || r.bytes < 0) return null;
  if (typeof r.durationS !== 'number' || !Number.isFinite(r.durationS) || r.durationS < 0) return null;
  if (!intOrNull(r.retentionDays) || typeof r.name !== 'string') return null;
  const quality = typeof r.quality === 'string' && (QUALITIES as readonly string[]).includes(r.quality) ? r.quality : 'sd';
  const t = (r.thumbnail ?? {}) as { from?: unknown; at?: unknown };
  const thumbFrom = typeof t.from === 'string' && WORD.test(t.from) ? t.from : 'none';
  const base = itemBase(proxy.via, r.id);
  return {
    via: proxy.via,
    id: r.id,
    cam: r.cam,
    camera: proxy.toCams.get(r.cam) ?? null,
    cameraName: text(r.cameraName, 120) || r.cam,
    name: r.name.slice(0, 120),
    labels: words(r.labels, LABEL).slice(0, 16),
    retentionDays: r.retentionDays,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    recordedFrom: r.recordedFrom,
    recordedTo: r.recordedTo,
    durationS: Math.round(r.durationS * 10) / 10,
    quality,
    original: r.original === true,
    bytes: r.bytes,
    source: source(r.source),
    eventKinds: words(r.eventKinds),
    found: words(r.found),
    thumbnail: { from: thumbFrom, at: int(t.at) ? t.at : null },
    createdBy: r.createdBy === 'admin' ? 'admin' : 'client',
    urls: { video: `${base}/video`, download: `${base}/video?download=1`, thumbnail: thumbFrom === 'none' ? null : `${base}/thumbnail`, metadata: `${base}/metadata` },
  };
}

// An archive job (contract §2), its item rebuilt like any other.
export interface ArchiveJob {
  id: string;
  via: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  phase: string | null;
  progress: number;
  bytes: number | null;
  size: number | null;
  archiveId: number | null;
  item: ArchiveItem | null;
  error: string | null;
  detail: string | null;
}
export const JOB_ID = /^[A-Za-z0-9_-]{22}$/;
const STATES = ['queued', 'running', 'done', 'failed', 'cancelled'];
export function parseJob(x: unknown, proxy: Pick<ArchiveProxy, 'via' | 'toCams'>): ArchiveJob | null {
  const r = (x ?? {}) as Record<string, unknown>;
  if (typeof r.id !== 'string' || !JOB_ID.test(r.id) || typeof r.state !== 'string' || !STATES.includes(r.state)) return null;
  const p = typeof r.progress === 'number' && Number.isFinite(r.progress) ? Math.min(1, Math.max(0, r.progress)) : 0;
  return {
    id: r.id,
    via: proxy.via,
    state: r.state as ArchiveJob['state'],
    phase: typeof r.phase === 'string' && WORD.test(r.phase) ? r.phase : null,
    progress: p,
    bytes: int(r.bytes) ? r.bytes : null,
    size: int(r.size) ? r.size : null,
    archiveId: int(r.archiveId) ? r.archiveId : null,
    item: r.item ? parseItem(r.item, proxy) : null,
    error: typeof r.error === 'string' && WORD.test(r.error) ? r.error : null,
    detail: typeof r.detail === 'string' ? r.detail.slice(0, 200) : null,
  };
}

// A refusal from the proxy, with only the contract's fields, each checked.
export function refusal(body: unknown): Record<string, unknown> {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { error: typeof b.error === 'string' && WORD.test(b.error) ? b.error : 'proxy_error' };
  if (typeof b.detail === 'string') out.detail = b.detail.slice(0, 200);
  for (const k of ['needed', 'free', 'minFreeBytes', 'count']) if (int(b[k])) out[k] = b[k];
  if (typeof b.state === 'string' && STATES.includes(b.state)) out.state = b.state;
  if (Array.isArray(b.missing)) out.missing = b.missing.filter(int).slice(0, 200);
  return out;
}

// The status (contract §6), rebuilt.
export function parseStatus(x: unknown): Record<string, unknown> | null {
  const r = (x ?? {}) as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean' || !int(r.count) || !int(r.bytes)) return null;
  const disk = (r.disk ?? {}) as { free?: unknown; size?: unknown };
  const last = (r.lastCleanup ?? null) as { at?: unknown; removed?: unknown; bytes?: unknown } | null;
  return {
    enabled: r.enabled,
    count: r.count,
    bytes: r.bytes,
    forever: int(r.forever) ? r.forever : 0,
    oldestCreatedAt: int(r.oldestCreatedAt) ? r.oldestCreatedAt : null,
    newestCreatedAt: int(r.newestCreatedAt) ? r.newestCreatedAt : null,
    disk: { free: int(disk.free) ? disk.free : null, size: int(disk.size) ? disk.size : null },
    percentOfDisk: typeof r.percentOfDisk === 'number' && Number.isFinite(r.percentOfDisk) ? r.percentOfDisk : null,
    warnPercent: int(r.warnPercent) ? r.warnPercent : null,
    warning: r.warning === true,
    minFreeBytes: int(r.minFreeBytes) ? r.minFreeBytes : null,
    nextCleanupAt: int(r.nextCleanupAt) ? r.nextCleanupAt : null,
    expiringAtNextCleanup: int(r.expiringAtNextCleanup) ? r.expiringAtNextCleanup : 0,
    lastCleanup: last && int(last.at) ? { at: last.at, removed: int(last.removed) ? last.removed : 0, bytes: int(last.bytes) ? last.bytes : 0 } : null,
    labels: Array.isArray(r.labels)
      ? r.labels
          .map((l) => l as { label?: unknown; count?: unknown })
          .filter((l) => typeof l.label === 'string' && LABEL.test(l.label) && int(l.count))
          .map((l) => ({ label: l.label as string, count: l.count as number }))
          .slice(0, 200)
      : [],
  };
}

// The metadata (contract §4), rebuilt: what the player shows.
export function parseMetadata(x: unknown, proxy: Pick<ArchiveProxy, 'via' | 'toCams'>, id: number): Record<string, unknown> | null {
  const r = (x ?? {}) as Record<string, unknown>;
  const item = parseItem({ ...(r.item as object), id: (r.item as { id?: unknown } | undefined)?.id ?? id }, proxy);
  if (!item) return null;
  const cam = (r.camera ?? {}) as { id?: unknown; name?: unknown; model?: unknown };
  const box = (b: unknown) => {
    const o = (b ?? {}) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return { x0: n(o.x0), y0: n(o.y0), x1: n(o.x1), y1: n(o.y1) };
  };
  const objects = (v: unknown) =>
    (Array.isArray(v) ? v : []).slice(0, 100).map((o) => {
      const x = (o ?? {}) as Record<string, unknown>;
      return { name: text(x.name, 80), score: typeof x.score === 'number' ? x.score : 0, box: box(x.box) };
    });
  const summary = (v: unknown) =>
    (Array.isArray(v) ? v : []).slice(0, 50).map((o) => {
      const x = (o ?? {}) as Record<string, unknown>;
      return { category: text(x.category, 32), score: typeof x.score === 'number' ? x.score : 0 };
    });
  const analysis = (a: unknown) => {
    if (!a || typeof a !== 'object') return null;
    const x = a as Record<string, unknown>;
    return { provider: text(x.provider, 40), status: text(x.status, 32), stillTs: int(x.stillTs) ? x.stillTs : null, objects: objects(x.objects), summary: summary(x.summary) };
  };
  return {
    item,
    camera: { id: text(cam.id, 64), name: text(cam.name, 120), model: typeof cam.model === 'string' ? cam.model.slice(0, 64) : null },
    window: { from: item.recordedFrom, to: item.recordedTo },
    events: (Array.isArray(r.events) ? r.events : []).slice(0, 500).map((e) => {
      const x = (e ?? {}) as Record<string, unknown>;
      return { id: int(x.id) ? x.id : null, kind: text(x.kind, 32), source: text(x.source, 32), start: int(x.start) ? x.start : null, end: int(x.end) ? x.end : null, recovered: x.recovered === true, analysis: analysis(x.analysis) };
    }),
    stillChecks: (Array.isArray(r.stillChecks) ? r.stillChecks : []).slice(0, 500).map((c) => {
      const x = (c ?? {}) as Record<string, unknown>;
      return { id: int(x.id) ? x.id : null, stillTs: int(x.stillTs) ? x.stillTs : null, provider: text(x.provider, 40), objects: objects(x.objects), summary: summary(x.summary) };
    }),
    proxy: { version: text((r.proxy as { version?: unknown } | undefined)?.version, 40) || null },
    archivedAt: int(r.archivedAt) ? r.archivedAt : item.createdAt,
  };
}

// X-On-Behalf-Of (contract §0): the signed-in person, 1 to 254 printable
// ASCII characters without spaces; anything else is left out.
export function onBehalfOf(email: string | undefined): Record<string, string> {
  return email && /^[\x21-\x7e]{1,254}$/.test(email) ? { 'X-On-Behalf-Of': email } : {};
}
