// The Archive (cam-proxy's archive contract; cams spec 2026-10-05-archive-design):
// the archive step of the Save dialog and the Archive page. The rules are the
// server's own module, so the dialog, cams's server and the proxy agree.
import { formatSeconds } from '../../../server/clipLimits';
import { nameProblem, normalizeLabels, retentionProblem, type SortKey, type SortOrder } from '../../../server/archiveRules';
import { apiFetch, getJson } from './api';
import { formatClock, localDate } from './recordings';

export { compareItems, DEFAULT_RETENTION_DAYS, labelProblem, labelSpelling, MAX_LABELS, nameProblem, normalizeLabels, PREDEFINED_LABELS, preselectLabels, RETENTION_MAX_DAYS, retentionProblem, sortItems } from '../../../server/archiveRules';
export type { SortKey, SortOrder } from '../../../server/archiveRules';

export interface ArchiveItem {
  via: string; // the camera cams reaches the item's cam-proxy through (ids are per proxy)
  id: number;
  cam: string; // the proxy's camera id
  camera: string | null; // cams's camera id; null for a camera cams doesn't know
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
  source: Record<string, unknown>;
  eventKinds: string[];
  found: string[];
  thumbnail: { from: string; at: number | null };
  createdBy: string;
  urls: { video: string; download: string; thumbnail: string | null; metadata: string };
}

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

export interface ProxyState { via: string; cams: string[]; ok: boolean; error?: 'too_old' | 'unreachable' | 'error' }
export interface ArchiveList { total: number; items: ArchiveItem[]; proxies: ProxyState[] }

export interface ArchiveMetadata {
  item: ArchiveItem;
  camera: { id: string; name: string; model: string | null };
  window: { from: number; to: number };
  events: { id: number | null; kind: string; source: string; start: number | null; end: number | null; recovered: boolean; analysis: { provider: string; status: string; stillTs: number | null; objects: { name: string; score: number }[]; summary: { category: string; score: number }[] } | null }[];
  stillChecks: { id: number | null; stillTs: number | null; provider: string; objects: { name: string; score: number }[]; summary: { category: string; score: number }[] }[];
  proxy: { version: string | null };
  archivedAt: number;
}

export const itemKey = (x: Pick<ArchiveItem, 'via' | 'id'>) => `${x.via}:${x.id}`;

// --- Words -------------------------------------------------------------------

// "4.1 MB": decimal units, one decimal from kB on.
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// The proxy's default name (contract §1), in the viewer's clock: the field
// starts with it, and the proxy makes the same in the camera's clock when it
// is left as it is (spec ruling 3).
export const defaultName = (recordedFrom: number, cameraName: string) => `${dateTime(recordedFrom)} ${cameraName}`;

const DAY = 86_400_000;
// "in 120 days", "in 1 day", "today" (within a day), "forever", "expired".
export function expiresText(expiresAt: number | null, now: number): string {
  if (expiresAt === null) return 'forever';
  const left = expiresAt - now;
  if (left <= 0) return 'expired';
  const days = Math.floor(left / DAY);
  if (days < 1) return 'today';
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

export const durationText = (s: number) => formatSeconds(Math.max(0, Math.round(s)));
export const QUALITY_LABELS: Record<string, string> = { '360p': '360p', sd: 'SD', '720p': '720p', '1080p': '1080p', '4k': '4K' };
export const qualityText = (q: string) => QUALITY_LABELS[q] ?? q;
// "2026-10-05 14:03:22", the viewer's clock.
export const dateTime = (t: number) => `${localDate(new Date(t))} ${formatClock(t)}`;

// A refusal in the dialog's words (contract §0), sizes included.
export function errorText(code: string | null | undefined, body: { detail?: unknown; needed?: unknown; free?: unknown; minFreeBytes?: unknown; state?: unknown } = {}): string {
  const n = (v: unknown) => (typeof v === 'number' ? formatBytes(v) : '?');
  switch (code) {
    case 'insufficient_space':
      return typeof body.needed === 'number' && typeof body.free === 'number' && typeof body.minFreeBytes === 'number'
        ? `Not enough space on the cam-proxy: the clip needs ${n(body.needed)}, ${n(body.free)} is free, and ${n(body.minFreeBytes)} must stay free.`
        : `Not enough space on the cam-proxy for this clip${typeof body.detail === 'string' && body.detail ? ` (${body.detail})` : ''}.`;
    case 'archive_off': return 'The Archive is switched off on the cam-proxy.';
    case 'camera_offline': return 'The camera is offline, and the recording isn’t cached on the cam-proxy.';
    case 'busy': return 'The cam-proxy is archiving four clips already; try again in a minute.';
    case 'rate_limited': return 'Too many clips this minute; try again shortly.';
    case 'not_ready': return 'The composed clip isn’t finished yet.';
    case 'not_found': return 'The clip is gone (a composed clip is kept 15 minutes); generate it again.';
    case 'unknown_recording': return 'The recording is gone from the SD card.';
    case 'full_quality_unavailable': return 'The full-resolution file isn’t listed; archive the standard quality instead.';
    case 'no_recording': return 'There is no file of this recording to archive.';
    case 'fetch_failed': return 'The cam-proxy couldn’t fetch the recording from the camera.';
    case 'source_gone': return 'The clip went away while it was being archived.';
    case 'store_failed': return 'The cam-proxy couldn’t store the clip.';
    case 'cancelled': return 'Archiving was cancelled.';
    case 'no_proxy': return 'This camera has no cam-proxy, so it has no Archive.';
    case 'proxy_unavailable': return 'The cam-proxy didn’t answer.';
    case 'invalid': return typeof body.detail === 'string' && body.detail ? body.detail : 'The request was refused.';
    default: return 'The clip could not be archived.';
  }
}

// A clip form's first problem (the archive step, Edit clip): name, then
// retention, then labels; or null.
export const formProblem = (name: string, days: number | null, labels: string[]): string | null =>
  nameProblem(name) ?? retentionProblem(days) ?? (normalizeLabels(labels).ok ? null : 'Check the labels.');

// --- API ---------------------------------------------------------------------

const enc = encodeURIComponent;
export class ArchiveError extends Error {
  constructor(readonly code: string | null, readonly status: number, message: string) {
    super(message);
  }
}
async function send<T>(url: string, method: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await apiFetch(url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) {
    const b = (j ?? {}) as { error?: unknown };
    const code = typeof b.error === 'string' ? b.error : null;
    throw new ArchiveError(code, r.status, errorText(code, b as Record<string, unknown>));
  }
  return { status: r.status, body: j as T };
}

export type ArchiveSource = { type: 'composition'; id: string } | { type: 'event'; eventId: string; quality: 'sub' | 'main' };
export interface CreateBody { source: ArchiveSource; name?: string; labels: string[]; retentionDays: number | null; thumbnailAt?: number }

export async function createArchive(cam: string, body: CreateBody): Promise<ArchiveJob> {
  return (await send<ArchiveJob>(`/api/cameras/${enc(cam)}/archive`, 'POST', body)).body;
}
// null: the job is gone (404). Other failures throw, so the caller can retry.
export async function pollArchiveJob(via: string, id: string): Promise<ArchiveJob | null> {
  try {
    return (await send<ArchiveJob>(`/api/archive/${enc(via)}/jobs/${enc(id)}`, 'GET')).body;
  } catch (e) {
    if (e instanceof ArchiveError && e.status === 404) return null;
    throw e;
  }
}
export function cancelArchiveJob(via: string, id: string): void {
  void apiFetch(`/api/archive/${enc(via)}/jobs/${enc(id)}`, { method: 'DELETE', keepalive: true }).catch(() => {});
}

export interface ListQuery { sort: SortKey; order: SortOrder }
export const listArchive = (q: ListQuery = { sort: 'created', order: 'desc' }) => getJson<ArchiveList>(`/api/archive?sort=${q.sort}&order=${q.order}`);
export const getMetadata = (item: ArchiveItem) => getJson<ArchiveMetadata>(item.urls.metadata);

export type Patch = { name?: string; labels?: string[]; retentionDays?: number | null };
export async function patchItem(item: Pick<ArchiveItem, 'via' | 'id'>, patch: Patch): Promise<ArchiveItem> {
  return (await send<ArchiveItem>(`/api/archive/${enc(item.via)}/items/${item.id}`, 'PATCH', patch)).body;
}

// The items per proxy, in the given order.
export function byProxy<T extends Pick<ArchiveItem, 'via'>>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of items) m.set(x.via, [...(m.get(x.via) ?? []), x]);
  return m;
}
const chunks = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// Bulk delete: one request per proxy and 500 ids. The keys deleted (or
// already gone), and the failures' words.
// The proxies are asked in parallel; the results keep the proxies' order.
export async function deleteItems(items: ArchiveItem[]): Promise<{ removed: string[]; errors: string[] }> {
  const perProxy = await Promise.all(
    [...byProxy(items)].map(async ([via, list]) => {
      const removed: string[] = [], errors: string[] = [];
      for (const part of chunks(list, 500)) {
        try {
          const r = await send<{ deleted: number[]; notFound: number[] }>(`/api/archive/${enc(via)}/delete`, 'POST', { ids: part.map((x) => x.id) });
          for (const id of [...r.body.deleted, ...r.body.notFound]) removed.push(`${via}:${id}`);
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      return { removed, errors };
    }),
  );
  return { removed: perProxy.flatMap((r) => r.removed), errors: perProxy.flatMap((r) => r.errors) };
}

// The ZIP downloads for a selection (spec ruling 4): one per proxy and 200 clips.
export function zipUrls(items: ArchiveItem[]): string[] {
  const out: string[] = [];
  for (const [via, list] of byProxy(items)) for (const part of chunks(list, 200)) out.push(`/api/archive/${enc(via)}/zip?ids=${part.map((x) => x.id).join(',')}`);
  return out;
}

// The cam-proxy (and cams) take 4 ZIPs a minute per person: how long each of
// `n` new downloads waits so that no 60 s window holds more than 4 starts,
// given the starts before (unix ms). A second's margin. A refused ZIP would
// be saved as a file holding the refusal, so they are spaced, never refused.
export const ZIPS_PER_MIN = 4;
export function zipDelays(started: number[], n: number, now: number): number[] {
  const times = [...started].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = times.length >= ZIPS_PER_MIN ? Math.max(now, times[times.length - ZIPS_PER_MIN] + 61_000) : now;
    out.push(t - now);
    times.push(t);
  }
  return out;
}

// Runs `fn` over the items, `limit` at a time (bulk edits: the contract has
// one PATCH per item). The failures' words.
export async function eachLimited<T>(xs: T[], limit: number, fn: (x: T) => Promise<void>): Promise<string[]> {
  const errors: string[] = [];
  let i = 0;
  const worker = async () => {
    while (i < xs.length) {
      const x = xs[i++];
      try {
        await fn(x);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, xs.length) }, worker));
  return errors;
}

// --- The list: filters and selection -------------------------------------------

export interface Filters { labels: string[]; camera: string; text: string }
export const NO_FILTERS: Filters = { labels: [], camera: '', text: '' };
// Items with all chosen labels (case-insensitive), of the camera (cams's id,
// or the proxy's name for one cams doesn't know), and the text in the name,
// the camera's name or a label.
export function filterItems<T extends ArchiveItem>(items: T[], f: Filters): T[] {
  const want = f.labels.map((l) => l.toLowerCase());
  const text = f.text.trim().toLowerCase();
  return items.filter((x) => {
    if (want.length && !want.every((l) => x.labels.some((y) => y.toLowerCase() === l))) return false;
    if (f.camera && (x.camera ?? `?${x.cameraName}`) !== f.camera) return false;
    if (text && !x.name.toLowerCase().includes(text) && !x.cameraName.toLowerCase().includes(text) && !x.labels.some((l) => l.toLowerCase().includes(text))) return false;
    return true;
  });
}
// The labels to filter by: the predefined ones, then the others by use.
export function labelChoices(items: ArchiveItem[], predefined: readonly string[]): string[] {
  const count = new Map<string, number>();
  for (const x of items) for (const l of x.labels) if (!predefined.some((p) => p.toLowerCase() === l.toLowerCase())) count.set(l, (count.get(l) ?? 0) + 1);
  return [...predefined, ...[...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l]) => l)];
}

// A click on a row's box: one on or off; with shift, every row from the last
// clicked one to this one takes this one's new state (in the order shown).
export function clickSelect(selected: Set<string>, order: string[], key: string, shift: boolean, anchor: string | null): Set<string> {
  const next = new Set(selected);
  const on = !selected.has(key);
  const a = anchor === null ? -1 : order.indexOf(anchor);
  const b = order.indexOf(key);
  if (shift && a >= 0 && b >= 0) {
    for (const k of order.slice(Math.min(a, b), Math.max(a, b) + 1)) {
      if (on) next.add(k);
      else next.delete(k);
    }
    return next;
  }
  if (on) next.add(key);
  else next.delete(key);
  return next;
}
// The header box: all shown rows on, none, or some.
export function headerState(selected: Set<string>, shown: string[]): 'all' | 'none' | 'some' {
  const n = shown.filter((k) => selected.has(k)).length;
  return n === 0 ? 'none' : n === shown.length ? 'all' : 'some';
}
// The header box's click: all shown rows on, or (when all were) off. Rows
// not shown stay as they are.
export function toggleAll(selected: Set<string>, shown: string[]): Set<string> {
  const next = new Set(selected);
  const all = headerState(selected, shown) === 'all';
  for (const k of shown) {
    if (all) next.delete(k);
    else next.add(k);
  }
  return next;
}

// --- Bulk labels -----------------------------------------------------------------

// Per label over the selection: on for all, for some, or none (the chips of
// "Set labels"). A chip left at "some" keeps each clip's own.
export type Tri = 'all' | 'some' | 'none';
export function labelStates(items: Pick<ArchiveItem, 'labels'>[], extra: readonly string[] = []): Map<string, Tri> {
  const m = new Map<string, Tri>();
  const seen = new Map<string, { spelling: string; n: number }>();
  for (const x of items) for (const l of x.labels) {
    const k = l.toLowerCase();
    const s = seen.get(k) ?? { spelling: l, n: 0 };
    s.n++;
    seen.set(k, s);
  }
  for (const l of extra) if (!seen.has(l.toLowerCase())) seen.set(l.toLowerCase(), { spelling: l, n: 0 });
  for (const { spelling, n } of seen.values()) m.set(spelling, n === 0 ? 'none' : n === items.length ? 'all' : 'some');
  return m;
}
// One clip's labels after "Set labels": its own order first, then the added ones.
export function applyLabelStates(labels: string[], states: Map<string, Tri>): string[] {
  const state = (l: string) => [...states].find(([k]) => k.toLowerCase() === l.toLowerCase())?.[1];
  const kept = labels.filter((l) => state(l) !== 'none');
  for (const [l, s] of states) if (s === 'all' && !kept.some((k) => k.toLowerCase() === l.toLowerCase())) kept.push(l);
  return kept;
}
// What the edit dialog edits: one clip, or the labels or retention of many.
export type EditMode = { kind: 'one'; item: ArchiveItem } | { kind: 'labels'; items: ArchiveItem[] } | { kind: 'retention'; items: ArchiveItem[] };
export const sameLabels = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

// --- Links ---------------------------------------------------------------------

// The Video page at the recording's start, paused there (its own URL form).
export function videoHref(item: Pick<ArchiveItem, 'camera' | 'recordedFrom'>): string | null {
  if (!item.camera) return null;
  return `/app/video?cam=${enc(item.camera)}&date=${localDate(new Date(item.recordedFrom))}&at=${item.recordedFrom}`;
}
// Whether the camera still holds the recording (its oldest content, /extent).
export const stillRecorded = (item: Pick<ArchiveItem, 'recordedFrom'>, oldest: number | null | undefined) => typeof oldest === 'number' && item.recordedFrom >= oldest;
