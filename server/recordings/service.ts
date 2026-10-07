import { promises as fs, createWriteStream } from 'fs';
import { IncomingMessage } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { setTimeout as sleep } from 'timers/promises';
import { proxyActive } from '../cameraRegistry';
import { getClient } from '../reolink/clients';
import { logger } from '../logger';
import { CameraError } from '../reolink/client';
import { clipDate, clipIdOf, clipTimes, CLIP_ID, parseClipName, ParsedClip, TimeInfo, Trigger } from './clipNames';
import { DiskCache } from './cache';
import { PriorityGate } from './priorityGate';
import { makeThumbnail } from './thumbnail';
import { Semaphore } from '../reolink/semaphore';
import { findProxyClip, findProxyStill, openProxyClip, openProxyStill } from './proxyClips';
import { cardEvents, proxyCardEvents, thumbPlan } from './detection';
import { RecordingError } from './errors';
import { fallsBack, headProxyRecording, listProxyDays, listProxyDay, logProxyFailure, openProxyRecording, type ProxyRecording } from './proxyRecordings';
import { ProxyError } from '../proxy/client';
import { camsIdOf, fileSafe, type CamKey } from '../fleet';

// A clip-cache name for one camera: flat (DiskCache refuses "/"), prefixed by
// the account and camera (ruling R4-15), so no two accounts share a name.
export const cacheName = (key: CamKey, rest: string): string => `${fileSafe(key)}_${rest}`;

export interface EventClip {
  id: string;
  start: string;
  end: string;
  durationSec: number;
  triggers: Trigger[];
  sizeSub: number | null;
  sizeMain: number | null;
}

interface DayEntry {
  at: number;
  events: EventClip[];
  // Per event: the camera's path of each stream's file (camera Search), or the
  // bare file name (the proxy's list).
  names: Map<string, { sub?: string; main?: string }>;
  // A day from the camera's own Search for a camera with a cam-proxy (a
  // fallback): it may have collided with the proxy's Search (an empty answer
  // without an error), and the proxy may be back soon, so it's kept for
  // TODAY_TTL only.
  doubtful?: boolean;
}

const TODAY_TTL = 30_000;
const PAST_TTL = 600_000;
const MONTH_TTL = 300_000;
// After a proxy list request failed to connect or time out, the next list
// requests (the day's other views, the month) go to the camera at once for
// this long, instead of each waiting out the proxy's 10 s.
const LIST_SPELL_MS = 15_000;
// The camera's own web UI allows one download at a time (CheckDownload's
// downloadTask), and overlapping downloads left it refusing all of them
// until a power cycle.
const TRANSFERS_PER_CAMERA = 1;
const BREAKER_FAILURES = 3;
const RECORDINGS_PROBE_MS = () => Number(process.env.RECORDINGS_PROBE_MS) || 60_000;
const DOWNLOAD_RETRY_DELAY_MS = Number(process.env.DOWNLOAD_RETRY_DELAY_MS) || 1000;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
// A detection's thumbnail: the still at its second or up to this much later.
const DETECTION_STILL_MS = 3000;
// A card whose detection thumbnail failed is tried again after this long.
const DETECTION_RETRY_MS = () => Number(process.env.DETECTION_RETRY_MS ?? 300_000);
type ThumbRule = 'detection' | 'start';
const hasDetection = (triggers: readonly Trigger[]) => triggers.some((t) => t === 'person' || t === 'vehicle' || t === 'pet');
// The camera Search cache behind cameraPath(): this many camera/day/stream
// entries, least recently used out first.
export const CAMERA_PATHS_MAX = 64;
// A camera download this recent says the camera serves downloads: with the
// proxy failing, 4K is offered only then (mainAvailable).
const CAMERA_DOWNLOAD_RECENT_MS = 10 * 60_000;

function cameraToday(offsetMinutes: number, now: number): string {
  return new Date(now + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

// "Recent" (short TTL) covers today AND the trailing 24h window rather than
// an exact string match against today's date, so it also covers the
// DST-enabled-but-not-yet-active hour and the last minutes before local
// midnight, where a plain equality check would flip a "today" search to the
// long TTL right when the cache most needs to stay fresh. Exported for a
// direct unit test.
export function isRecentDay(date: string, offsetMinutes: number, now = Date.now()): boolean {
  const cutoff = cameraToday(offsetMinutes, now - RECENT_WINDOW_MS);
  return date >= cutoff;
}

// Drops the entries older than the longest TTL they can have (lists of days
// no one looks at any more).
function sweep(cache: Map<string, { at: number }>, maxTtl: number): void {
  const now = Date.now();
  for (const [k, e] of cache) if (now - e.at >= maxTtl) cache.delete(k);
}

// A lazily made value per camera.
function perCamera<T>(make: () => T): (cameraId: CamKey) => T {
  const values = new Map<string, T>();
  return (cameraId) => {
    let v = values.get(cameraId);
    if (v === undefined) values.set(cameraId, (v = make()));
    return v;
  };
}

function abortError(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

// Real-time order, not string order: on the fall-back night, a clip at
// 01:30 CDT (-05:00) is chronologically later than one at 01:10 CST
// (-06:00), even though "01:10" sorts before "01:30" as a plain string.
// Exported for a direct unit test of that night.
export function byStartTime(a: { start: string }, b: { start: string }): number {
  return Date.parse(a.start) - Date.parse(b.start);
}

// Picks which stream file to actually serve for a requested quality,
// falling back to the other stream when the requested one is missing.
// `served` names the stream actually picked, which may differ from
// `quality` - callers must label the result by `served`, not `quality`.
// Exported for a direct unit test of the fallback (the simulated camera always
// has both streams for every clip, so this can't be exercised end-to-end).
export function pickStream(
  quality: 'sub' | 'main',
  names: { sub?: string; main?: string },
): { name: string; served: 'sub' | 'main' } | null {
  const requested = quality === 'main' ? names.main : names.sub;
  const served: 'sub' | 'main' = requested ? quality : quality === 'main' ? 'sub' : 'main';
  const name = requested ?? (quality === 'main' ? names.sub : names.main);
  return name ? { name, served } : null;
}

// A clip still being written is listed with end time 000000. Only a clip
// that starts in the last minutes before midnight can really end at 000000.
export function isStillRecording(p: ParsedClip): boolean {
  return p.end === '000000' && p.start < '235500';
}

// End of a clip in seconds after its start day's midnight (past 86400 when
// it runs into the next day), for comparing copies of one event.
function clipSpanEnd(p: ParsedClip): number {
  const secs = (t: string) => Number(t.slice(0, 2)) * 3600 + Number(t.slice(2, 4)) * 60 + Number(t.slice(4, 6));
  const end = secs(p.end);
  return end < secs(p.start) ? end + 86400 : end;
}

// A file name without its folder: the proxy's id for a camera path. A day
// list holds either form (bare from the proxy, a path from the camera's Search).
function baseName(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

type DayFile = { name: string; size: number };

// One day's events from its sub and main stream files (camera paths or bare
// names), with each event's file names.
function mergeDay(sub: DayFile[], main: DayFile[], date: string, time: TimeInfo): Pick<DayEntry, 'events' | 'names'> {
  // Keyed by start time: the firmware can end an event's main-stream copy
  // a few seconds after its sub-stream copy (065221_065224 vs
  // 065221_065226), so both halves of one event share only the start.
  const byStart = new Map<string, { parsed: ParsedClip; sub?: DayFile; main?: DayFile }>();
  for (const [stream, files] of [['sub', sub], ['main', main]] as const) {
    for (const f of files) {
      const parsed = parseClipName(f.name);
      if (!parsed || parsed.date !== date || isStillRecording(parsed)) continue;
      const entry = byStart.get(parsed.start) ?? { parsed };
      entry[stream] = f;
      // The longer copy decides the event's end; the main stream's flags
      // are authoritative for triggers when both exist.
      const end = clipSpanEnd(entry.parsed) >= clipSpanEnd(parsed) ? entry.parsed.end : parsed.end;
      const triggers = stream === 'main' && parsed.triggers.length ? parsed.triggers : entry.parsed.triggers.length ? entry.parsed.triggers : parsed.triggers;
      entry.parsed = { ...entry.parsed, end, triggers };
      byStart.set(parsed.start, entry);
    }
  }
  const byId = new Map([...byStart.values()].map((e) => [clipIdOf(e.parsed), e] as const));
  const events: EventClip[] = [...byId.entries()]
    .map(([id, e]) => ({
      id,
      ...clipTimes(e.parsed, time),
      triggers: e.parsed.triggers,
      sizeSub: e.sub?.size ?? null,
      sizeMain: e.main?.size ?? null,
    }))
    .sort(byStartTime);
  const names = new Map([...byId.entries()].map(([id, e]) => [id, { sub: e.sub?.name, main: e.main?.name }]));
  return { events, names };
}

// 'proxy-recordings': from the cam-proxy's recordings API (the SD card).
// 'proxy': the camera has a cam-proxy, but its last recordings request
// failed, so recordings come from its FTP copies. 'ok' and 'unavailable':
// cameras without a proxy (the camera's breaker).
export type DownloadsState = 'ok' | 'proxy-recordings' | 'proxy' | 'unavailable';

interface DayList {
  work: Promise<DayEntry>;
  ctl: AbortController;
  waiters: number;
}

export class RecordingsService {
  private readonly days_ = new Map<string, { at: number; days: string[]; doubtful?: boolean }>();
  // Per camera: when a proxy list request last found the proxy unreachable.
  private readonly listUnreachableAt = new Map<string, number>();
  private readonly daysInflight = new Map<string, DayList>();
  private readonly dayCache = new Map<string, DayEntry>();
  // Per camera with a cam-proxy: whether its last recordings request failed.
  private readonly proxyRecordingsFailed = new Map<string, boolean>();

  // Runs `ask` against the camera's cam-proxy (spec 2026-10-02). null: "use
  // the next route" (no proxy in use, or a failure that falls back, logged as
  // proxy_recordings_failed). A recording gone from the SD card
  // (unknown_clip) and an abort are thrown. `what` is the clip id, or the day
  // or month being listed, for the log. `record` false: a read-only question
  // that leaves the downloads state alone.
  // `list`: a day or month list, which also notes an unreachable proxy for
  // listViaProxy.
  private async viaProxy<T>(cameraId: CamKey, what: string, ask: () => Promise<T>, signal?: AbortSignal, record = true, list = false): Promise<T | null> {
    if (!proxyActive(cameraId)) return null;
    try {
      const value = await ask();
      if (record) this.proxyRecordingsFailed.set(cameraId, false);
      return value;
    } catch (err) {
      if (record && err instanceof RecordingError) this.proxyRecordingsFailed.set(cameraId, false); // the proxy answered
      if (!fallsBack(err, signal)) throw err;
      if (record) this.proxyRecordingsFailed.set(cameraId, true);
      if (list && err instanceof ProxyError && err.code === 'proxy_unreachable') this.listUnreachableAt.set(cameraId, Date.now());
      logProxyFailure(cameraId, what, err);
      return null;
    }
  }

  // viaProxy for the day and month lists: while the proxy was found
  // unreachable (a hang or a refused connection) a moment ago, null at once.
  private async listViaProxy<T>(cameraId: CamKey, what: string, ask: () => Promise<T>, signal?: AbortSignal): Promise<T | null> {
    const at = this.listUnreachableAt.get(cameraId);
    if (at !== undefined && Date.now() - at < LIST_SPELL_MS) return null;
    this.listUnreachableAt.delete(cameraId);
    return this.viaProxy(cameraId, what, ask, signal, true, true);
  }

  constructor(private readonly cache: DiskCache) {}

  // A cam-proxy said this camera's recordings changed around `ts`: the next
  // day and month lists ask the camera again (the day before and after too,
  // for events near midnight).
  async invalidateAround(cameraId: CamKey, ts: number): Promise<void> {
    const time = await this.client(cameraId).timeInfo();
    const offset = time.stdOffsetMinutes + time.dstOffsetMinutes;
    for (const t of [ts - 86_400_000, ts, ts + 86_400_000]) {
      const date = cameraToday(offset, t);
      this.dayCache.delete(`${cameraId}|${date}`);
      this.days_.delete(`${cameraId}|${date.slice(0, 7)}`);
    }
  }

  private client(cameraId: CamKey) {
    const c = getClient(cameraId);
    if (!c) throw new RecordingError('unknown_clip', 'unknown camera');
    return c;
  }

  // Per camera: proxy still lookups and fetches for thumbnails, three at a time.
  private readonly stillGate = perCamera(() => new Semaphore(3));

  // Per camera: thumbnails' recording requests to the cam-proxy, one at a
  // time. The proxy fetches one file per camera, first come first served, so
  // at most one thumbnail's file sits there ahead of a playback. A playback of
  // a clip whose thumbnail waits here promotes it (same key).
  private readonly proxyThumbGate = perCamera(() => new PriorityGate(1));

  // Per camera: its transfer slot for the camera's own downloads.
  private readonly gate = perCamera(() => new PriorityGate(TRANSFERS_PER_CAMERA));

  // Test-only instrumentation (fix round 1, item 8): how many transfers for
  // this camera are queued behind the one active slot right now.
  transferQueueLength(cameraId: CamKey): number {
    return this.gate(cameraId).queued;
  }

  // A camera with a cam-proxy: the proxy's month list, so the camera is
  // searched by the proxy's one searcher only (an overlapping Search comes
  // back empty without an error); its own month Search when the proxy can't.
  async days(cameraId: CamKey, month: string): Promise<string[]> {
    const key = `${cameraId}|${month}`;
    const hit = this.days_.get(key);
    if (hit && Date.now() - hit.at < (hit.doubtful ? TODAY_TTL : MONTH_TTL)) return hit.days;
    const proxied = await this.listViaProxy(cameraId, month, () => listProxyDays(cameraId, month));
    const days = proxied ?? (await this.client(cameraId).searchMonth(month));
    sweep(this.days_, MONTH_TTL);
    this.days_.set(key, { at: Date.now(), days, doubtful: !proxied && proxyActive(cameraId) });
    return days;
  }

  // `signal`: the viewer. The day's list is shared by everyone asking for it, so
  // it is abandoned only when the last of them has left.
  private async day(cameraId: CamKey, date: string, signal?: AbortSignal): Promise<DayEntry> {
    const key = `${cameraId}|${date}`;
    const client = this.client(cameraId);
    const time = await client.timeInfo();
    const ttl = isRecentDay(date, time.stdOffsetMinutes + time.dstOffsetMinutes) ? TODAY_TTL : PAST_TTL;
    const hit = this.dayCache.get(key);
    if (hit && Date.now() - hit.at < (hit.doubtful ? TODAY_TTL : ttl)) return hit;
    const inflight = this.daysInflight.get(key);
    if (inflight) return this.waitFor(key, inflight, signal);
    const ctl = new AbortController();
    const work = (async () => {
      // A camera with a cam-proxy: the proxy's list, sub then main, from the
      // camera-local `date`; the camera's own Search when the proxy can't answer.
      const files = (list: ProxyRecording[]) => list.map((r) => ({ name: r.id, size: r.size }));
      const proxied = await this.listViaProxy(cameraId, date, async () => {
        const subList = files(await listProxyDay(cameraId, date, 'sub', ctl.signal));
        const mainList = files(await listProxyDay(cameraId, date, 'main', ctl.signal));
        return [subList, mainList] as const;
      }, ctl.signal);
      const [sub, main] = proxied ?? (await Promise.all([client.searchDay(date, 'sub'), client.searchDay(date, 'main')]));
      const entry: DayEntry = { at: Date.now(), ...mergeDay(sub, main, date, time), doubtful: !proxied && proxyActive(cameraId) };
      sweep(this.dayCache, PAST_TTL);
      this.dayCache.set(key, entry);
      return entry;
    })();
    const entry: DayList = { work, ctl, waiters: 0 };
    // Its failure reaches the viewers waiting on it; this keeps one that
    // nobody waits on any more from being an unhandled rejection.
    work.catch(() => undefined);
    void work.then(
      () => this.forget(key, entry),
      () => this.forget(key, entry),
    );
    this.daysInflight.set(key, entry);
    return this.waitFor(key, entry, signal);
  }

  // An old list never removes a fresh one under the same key.
  private forget(key: string, entry: DayList): void {
    if (this.daysInflight.get(key) === entry) this.daysInflight.delete(key);
  }

  // The last viewer left: abort the list and let no one join it any more.
  private abandon(key: string, entry: DayList, reason: unknown): void {
    entry.ctl.abort(reason);
    this.forget(key, entry);
  }

  // One more viewer on a day's shared list. When the viewer leaves it stops
  // waiting at once; the last one to leave aborts the list.
  private waitFor(key: string, entry: DayList, signal?: AbortSignal): Promise<DayEntry> {
    if (!signal) {
      entry.waiters++; // never leaves, so the list is never abandoned under it
      return entry.work;
    }
    if (signal.aborted) {
      if (entry.waiters === 0) this.abandon(key, entry, signal.reason);
      return Promise.reject(signal.reason);
    }
    entry.waiters++;
    return new Promise<DayEntry>((resolve, reject) => {
      const onAbort = () => {
        if (--entry.waiters === 0) this.abandon(key, entry, signal.reason);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.work.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  async events(cameraId: CamKey, date: string, signal?: AbortSignal): Promise<EventClip[]> {
    return (await this.day(cameraId, date, signal)).events;
  }

  // Review focus 1: ids are validated and resolved only through this
  // camera's own Search results; a camera path never comes from the client.
  private async names(cameraId: CamKey, clipId: string): Promise<{ sub?: string; main?: string }> {
    if (!CLIP_ID.test(clipId)) throw new RecordingError('unknown_clip', 'malformed clip id');
    const date = clipDate(clipId);
    const names = (await this.day(cameraId, date)).names.get(clipId);
    if (!names) throw new RecordingError('unknown_clip', 'no such clip');
    return names;
  }

  private key(cameraId: CamKey, clipId: string, ext: string): string {
    return cacheName(cameraId, `${clipId}.${ext}`);
  }

  // Pins the clip's cached sub-stream file for as long as `use` needs it:
  // pinned BEFORE fill() starts and unpinned only once `use` is done, so a
  // concurrent evict() from another key filling at the same time can never
  // remove this file out from under a reader.
  // The camera occasionally resets a Download before sending anything, and
  // the same request succeeds moments later: retry that case once.
  private async downloadWithRetry(cameraId: CamKey, name: string, signal?: AbortSignal): Promise<IncomingMessage> {
    const probe = this.guard(cameraId);
    try {
      let res: IncomingMessage;
      try {
        res = await this.client(cameraId).download(name, signal);
      } catch (err) {
        // A probe is a single try: it only asks whether downloads work again.
        if (probe || !(err instanceof CameraError) || err.code !== 'camera_offline' || signal?.aborted) throw err;
        await sleep(DOWNLOAD_RETRY_DELAY_MS);
        res = await this.client(cameraId).download(name, signal);
      }
      this.cameraDownloadOkAt.set(cameraId, performance.now());
      if (this.health.has(cameraId)) {
        if (this.breakerOpen(cameraId)) logger.info({ cameraId }, 'recordings_breaker_closed');
        this.health.delete(cameraId);
      }
      return res;
    } catch (err) {
      if (err instanceof CameraError && err.code === 'camera_offline' && !signal?.aborted) this.noteRefused(cameraId);
      throw err;
    }
  }

  // Download health: a camera can refuse every recording download while its
  // API, live view and search keep working (RLC-1224A, 2026-09-26). After
  // BREAKER_FAILURES refusals in a row, clip transfers answer
  // recordings_unavailable at once instead of queueing more refused
  // transfers; one probe per RECORDINGS_PROBE_MS is let through, and a
  // success closes the breaker.
  private readonly health = new Map<string, { failures: number; lastProbeAt: number }>();
  // When the camera last served a download (performance.now()).
  private readonly cameraDownloadOkAt = new Map<string, number>();

  private noteRefused(cameraId: CamKey): void {
    const h = this.health.get(cameraId) ?? { failures: 0, lastProbeAt: 0 };
    h.failures++;
    h.lastProbeAt = performance.now();
    this.health.set(cameraId, h);
    if (h.failures === BREAKER_FAILURES) logger.warn({ cameraId }, 'recordings_breaker_opened');
  }

  // BREAKER_FAILURES refusals in a row.
  private breakerOpen(cameraId: CamKey): boolean {
    return (this.health.get(cameraId)?.failures ?? 0) >= BREAKER_FAILURES;
  }

  // The breaker is open and no probe is due: a camera download would be
  // refused by guard(). A peek; it changes nothing.
  private refusing(cameraId: CamKey): boolean {
    return this.breakerOpen(cameraId) && performance.now() - this.health.get(cameraId)!.lastProbeAt < RECORDINGS_PROBE_MS();
  }

  // Runs inside the transfer slot, right before a camera download, so
  // requests queued before the breaker opened are refused too.
  // Returns true when this call is the probe.
  private guard(cameraId: CamKey): boolean {
    if (!this.breakerOpen(cameraId)) return false;
    if (this.refusing(cameraId)) throw new RecordingError('recordings_unavailable', 'the camera is refusing recording downloads');
    this.health.get(cameraId)!.lastProbeAt = performance.now(); // this request is the probe
    logger.info({ cameraId }, 'recordings_breaker_probe');
    return true;
  }

  // An open page stops asking for thumbnails once they fail, so the list
  // refresh drives recovery: when a probe is due, fetch the newest clip in
  // the background (through the same gate and guard: still one probe per
  // interval) so the next events response can report 'ok' again.
  probeIfDue(cameraId: CamKey, clipId: string | undefined): void {
    if (!clipId || !this.breakerOpen(cameraId) || this.refusing(cameraId)) return;
    void this.withClip(cameraId, clipId, async () => undefined, 'low').catch(() => undefined);
  }

  downloadsState(cameraId: CamKey): DownloadsState {
    if (proxyActive(cameraId)) return this.proxyRecordingsFailed.get(cameraId) ? 'proxy' : 'proxy-recordings';
    return this.breakerOpen(cameraId) ? 'unavailable' : 'ok';
  }

  // The event's start, end and triggers, from the day's list.
  private async eventSpan(cameraId: CamKey, clipId: string): Promise<{ start: number; end: number; triggers: Trigger[] } | null> {
    const date = clipDate(clipId);
    const ev = (await this.day(cameraId, date)).events.find((e) => e.id === clipId);
    return ev ? { start: Date.parse(ev.start), end: Date.parse(ev.end), triggers: ev.triggers } : null;
  }

  // The proxy's clip for an event (composed clips, cam-proxy spec 2026-09-28),
  // with the event's own span (unix ms): the proxy's FTP copy can start
  // earlier or run longer, and a composition's rolls apply to the event
  // (2026-10-04). null when it has none; a failed lookup throws (issue #76).
  async proxyClipOf(cameraId: CamKey, clipId: string): Promise<{ id: number; event: { start: number; end: number } } | null> {
    if (!proxyActive(cameraId)) return null;
    const span = await this.eventSpan(cameraId, clipId);
    if (!span) return null;
    const clip = await findProxyClip(cameraId, span.start, span.end);
    if (clip) logger.info({ cameraId, clipId, proxyClip: clip.id }, 'recording_from_proxy');
    return clip && { id: clip.id, event: { start: span.start, end: span.end } };
  }

  // The proxy's clip for the event, for a camera with a cam-proxy (Plan 7:
  // asked first; Plan 6: when the camera refuses). A failed lookup: none.
  private async proxyClip(cameraId: CamKey, clipId: string): Promise<{ id: number } | null> {
    try {
      return await this.proxyClipOf(cameraId, clipId);
    } catch (e) {
      logger.warn({ cameraId, clipId, message: (e as Error).message }, 'proxy_clip_lookup_failed');
      return null;
    }
  }

  // Per camera, day and stream: the camera's Search, bare name → path, so a
  // run of fallbacks costs one Search per day (in flight ones are shared).
  // At most CAMERA_PATHS_MAX entries; Map order is the recency order.
  private readonly cameraPaths = new Map<string, Promise<Map<string, string>>>();

  // The camera's path of a file from the day's list. A list from the proxy
  // holds bare file names, and the camera's Download needs the folder, so the
  // camera's own Search finds it. Called outside the transfer slot (the
  // client's search gate orders Searches) and after the breaker check.
  // An empty Search isn't final: the camera answers a Search that overlaps
  // another (the proxy's) with an empty list, and the proxy did list the file.
  private async cameraPath(cameraId: CamKey, clipId: string, name: string, stream: 'sub' | 'main'): Promise<string> {
    if (name.includes('/')) return name;
    const key = `${cameraId}|${clipDate(clipId)}|${stream}`;
    const hit = this.cameraPaths.get(key);
    if (hit) {
      this.cameraPaths.delete(key); // now the most recently used
      this.cameraPaths.set(key, hit);
    }
    const known = await hit?.catch(() => undefined);
    const cached = known?.get(name);
    if (cached) return cached;
    // Not searched yet, or a file newer than the last Search: ask again.
    const search = (async () => {
      const files = await this.client(cameraId).searchDay(clipDate(clipId), stream);
      if (!files.length) throw new RecordingError('recordings_unavailable', 'the camera’s Search found no recordings for the day');
      return new Map(files.map((f) => [baseName(f.name), f.name] as const));
    })();
    this.cameraPaths.delete(key);
    this.cameraPaths.set(key, search);
    for (const old of this.cameraPaths.keys()) {
      if (this.cameraPaths.size <= CAMERA_PATHS_MAX) break;
      this.cameraPaths.delete(old);
    }
    search.catch(() => {
      if (this.cameraPaths.get(key) === search) this.cameraPaths.delete(key);
    });
    const path = (await search).get(name);
    if (!path) throw new RecordingError('unknown_clip', 'no such clip on the camera');
    return path;
  }

  // `priority` 'high' is for someone waiting to watch the clip; thumbnails
  // pass 'low'. If a low-priority fetch of this clip is already queued, a
  // high-priority caller promotes it rather than waiting behind other clips.
  async withClip<T>(
    cameraId: CamKey,
    clipId: string,
    use: (path: string) => Promise<T>,
    priority: 'high' | 'low' = 'high',
  ): Promise<T> {
    const { sub } = await this.names(cameraId, clipId);
    if (!sub) throw new RecordingError('unknown_clip', 'clip has no sub stream');
    const key = this.key(cameraId, clipId, 'mp4');
    this.cache.pin(key);
    try {
      if (priority === 'high') {
        this.gate(cameraId).promote(key);
        this.proxyThumbGate(cameraId).promote(key);
      }
      const path = await this.cache.fill(key, async (tmp) => {
        // 1. The proxy's recordings API: the SD file, fetched over Baichuan
        //    (spec 2026-10-02), outside the camera's transfer slot (the proxy
        //    queues its own transfers). A gone recording ends here. No outer
        //    timeout: the proxy may hold the headers up to 120 s while a
        //    queued download finishes (openProxyRecording's own limit).
        //    Thumbnails go one at a time (proxyThumbGate).
        const fromProxy = () =>
          this.viaProxy(cameraId, clipId, async () => {
            const { stream, size } = await openProxyRecording(cameraId, baseName(sub));
            const out = createWriteStream(tmp);
            await pipeline(stream, out);
            // A body that ends cleanly but short is a failed transfer too.
            if (size !== null && out.bytesWritten !== size) throw new ProxyError('proxy_error', 'short recording');
            return true;
          });
        const fromSd = priority === 'low' && proxyActive(cameraId) ? await this.proxyThumbGate(cameraId).run(fromProxy, { key }) : await fromProxy();
        if (fromSd) return;
        // 2. Its FTP copy (Plan 7), also outside the slot.
        const first = await this.proxyClip(cameraId, clipId);
        if (first) {
          try {
            await pipeline((await openProxyClip(cameraId, first.id)).stream, createWriteStream(tmp));
            return;
          } catch (e) {
            logger.warn({ cameraId, clipId, message: (e as Error).message }, 'proxy_clip_fetch_failed');
          }
        }
        // 3. The camera's own download, in its one transfer slot, behind the
        //    breaker. The proxy was asked above, so a camera refusal is final
        //    here (issue #38: no second lookup); a retry asks the proxy again.
        //    With the breaker open there's no Search either; the file's path
        //    is found before the slot is taken.
        if (this.refusing(cameraId)) throw new RecordingError('recordings_unavailable', 'the camera is refusing recording downloads');
        const name = await this.cameraPath(cameraId, clipId, sub, 'sub');
        await this.gate(cameraId).run(
          async () => {
            const res = await this.downloadWithRetry(cameraId, name);
            await pipeline(res, createWriteStream(tmp));
          },
          { high: priority === 'high', key },
        );
      });
      return await use(path);
    } finally {
      this.cache.unpin(key);
    }
  }

  // The proxy's still for a card into `tmp`, and which rule found it:
  // 'detection', the moment its person, vehicle or pet was detected (issue
  // #157); 'start', 2 s into the event (Plan 7); null when there is none, or
  // it isn't a JPEG. At most three at a time per camera, lookups included: a
  // day's list asks for all its thumbnails at once (issues #38, #76).
  private async proxyStill(cameraId: CamKey, clipId: string, tmp: string, rule: ThumbRule): Promise<ThumbRule | null> {
    const used = await this.stillGate(cameraId).run(async () => {
      const span = await this.eventSpan(cameraId, clipId);
      if (!span) return null;
      let ts: number | null = null;
      if (rule === 'detection') {
        // One event lookup; a failed one (an older or unreachable proxy) finds nothing.
        const events = await proxyCardEvents(cameraId, span.start, span.end).catch((e: Error) => {
          logger.warn({ cameraId, clipId, message: e.message }, 'proxy_detection_lookup_failed');
          return [];
        });
        // The card's own events, as the day's list gives them to cards (its counts, its version).
        const day = (await this.day(cameraId, clipDate(clipId))).events;
        const mine = cardEvents(day.map((e) => ({ start: Date.parse(e.start), end: Date.parse(e.end) })), events)[day.findIndex((e) => e.id === clipId)] ?? [];
        const moments = thumbPlan(mine)?.moments ?? [];
        // A still at the second, or within 3 s after it (a gap).
        for (const m of moments) if ((ts = await findProxyStill(cameraId, m, m + DETECTION_STILL_MS))) break;
      } else {
        ts = await findProxyStill(cameraId, span.start + 2000, span.start + 12_000);
      }
      if (!ts) return null;
      await pipeline(await openProxyStill(cameraId, ts), createWriteStream(tmp));
      return rule;
    });
    if (!used) return null;
    // Only a JPEG becomes a (cached) thumbnail.
    const head = await fs.readFile(tmp).then((b) => b.subarray(0, 3)).catch(() => Buffer.alloc(0));
    if (head.length === 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return used;
    logger.warn({ cameraId, clipId }, 'proxy_still_not_a_jpeg');
    return null;
  }

  // Per card: when its detection thumbnail was last tried without success.
  // Until DETECTION_RETRY_MS later the card gets its ordinary thumbnail
  // without asking the proxy again (no retry storm while it fails).
  private readonly detectionMisses = new Map<string, number>();

  // A card the camera's AI flagged (person, vehicle or pet), on a camera with
  // a cam-proxy: its detection thumbnail (issue #157), cached under its own
  // key (<id>.det.jpg) and only when the detection rule found the still; a
  // thumbnail cached before is never served for it. null: none (yet), the
  // ordinary thumbnail is served, and the detection is tried again later.
  private async detectionThumbnail(cameraId: CamKey, clipId: string, key: string, version: string): Promise<string | null> {
    const miss = `${cameraId}|${clipId}|${version}`;
    const at = this.detectionMisses.get(miss);
    if (at !== undefined && Date.now() - at < DETECTION_RETRY_MS() && !(await this.cache.has(key))) return null;
    try {
      const path = await this.cache.fill(key, async (tmp) => {
        if ((await this.proxyStill(cameraId, clipId, tmp, 'detection')) !== 'detection') throw new Error('no detection still');
      });
      this.detectionMisses.delete(miss);
      return path;
    } catch (e) {
      logger.debug({ cameraId, clipId, message: (e as Error).message }, 'detection_thumbnail_unavailable');
      const now = Date.now();
      for (const [k, t] of this.detectionMisses) if (now - t >= DETECTION_RETRY_MS()) this.detectionMisses.delete(k);
      this.detectionMisses.set(miss, now);
      return null;
    }
  }

  // The version the day's list gives a card's thumbnail: the planned one
  // (thumbPlan), and while its detection thumbnail is missing (a lookup
  // failed, or no still yet) a suffix that changes once per retry pause, so
  // a page that showed the fallback asks again; it ends once one is found.
  thumbVersion(cameraId: CamKey, clipId: string, planned: string): string {
    if (!this.detectionMisses.has(`${cameraId}|${clipId}|${planned}`)) return planned;
    return `${planned}-r${Math.floor(Date.now() / Math.max(1, DETECTION_RETRY_MS()))}`;
  }

  // The mp4 is fetched (via withClip) only when the jpg isn't already
  // cached: DiskCache.fill() checks that internally before ever invoking
  // this producer, so a cached thumbnail is served without touching the
  // camera at all.
  async thumbnail(cameraId: CamKey, clipId: string): Promise<string> {
    const jpgKey = this.key(cameraId, clipId, 'jpg');
    return this.cache.fill(jpgKey, async (tmp) => {
      // A camera with a cam-proxy: its still 2 s into the event (Plan 7),
      // no clip transfer and no ffmpeg.
      if (proxyActive(cameraId)) {
        try {
          if (await this.proxyStill(cameraId, clipId, tmp, 'start')) return;
        } catch (e) {
          logger.warn({ cameraId, clipId, message: (e as Error).message }, 'proxy_still_failed');
        }
      }
      await this.clipThumbnail(cameraId, clipId, tmp);
    });
  }

  private clipThumbnail(cameraId: CamKey, clipId: string, tmp: string): Promise<void> {
    return this.withClip(cameraId, clipId, async (video) => {
        try {
          await makeThumbnail(video, tmp);
        } catch {
          throw new RecordingError('thumbnail_unavailable', 'thumbnail could not be made');
        }
        const stat = await fs.stat(tmp).catch(() => null);
        if (!stat || stat.size === 0) throw new RecordingError('thumbnail_unavailable', 'thumbnail could not be made');
      }, 'low');
  }

  // Same pin-before-fill pattern as withClip, but for the jpg: pinned
  // before thumbnail()'s fill() starts and unpinned only once `use` is
  // done, so a concurrent evict() can never remove the file while it's
  // being sent to a client.
  //
  // `version`: the card's thumbnail as the day's list named it (thumbPlan,
  // Klaus 2026-10-04): its detection thumbnail is cached under it
  // (<id>.det-<version>.jpg), so a Vision confirmation arriving later is a
  // new thumbnail. A retry suffix (-r…, thumbVersion) asks again, under the
  // same key. Without one (a list from before, or the proxy's events
  // unknown): <id>.det.jpg, as before.
  async withThumbnail<T>(cameraId: CamKey, clipId: string, use: (path: string) => Promise<T>, version?: string): Promise<T> {
    const span = proxyActive(cameraId) ? await this.eventSpan(cameraId, clipId).catch(() => null) : null;
    if (span && hasDetection(span.triggers)) {
      const planned = version?.replace(/-r\d+$/, '');
      const detKey = this.key(cameraId, clipId, planned ? `det-${planned}.jpg` : 'det.jpg');
      this.cache.pin(detKey);
      try {
        const path = await this.detectionThumbnail(cameraId, clipId, detKey, planned ?? '');
        if (path) return await use(path);
      } finally {
        this.cache.unpin(detKey);
      }
    }
    const jpgKey = this.key(cameraId, clipId, 'jpg');
    this.cache.pin(jpgKey);
    try {
      const path = await this.thumbnail(cameraId, clipId);
      return await use(path);
    } finally {
      this.cache.unpin(jpgKey);
    }
  }


  // The clip download, streamed through (not cached), in the spec 2026-10-02
  // order. Sub: the proxy's recordings API (the camera's own file, so it
  // keeps its -sub name), its FTP copy (-proxy.mp4), then the camera. Main
  // (4K): the proxy's recordings, then the camera; never the FTP copy, which
  // is the sub stream (Klaus, 2026-10-02: no silent quality downgrade), so
  // when both fail it answers full_quality_unavailable and the dialog offers
  // the standard quality. The camera's transfer slot is released once the
  // returned stream closes or fails, and is never left held if `signal`
  // aborts. A viewer who left is never retried on another route; a failure
  // after bytes were sent ends the response short.
  async openDownload(
    cameraId: CamKey,
    clipId: string,
    quality: 'sub' | 'main',
    signal?: AbortSignal,
  ): Promise<{ stream: Readable; filename: string; size: number | null }> {
    const names = await this.names(cameraId, clipId);
    const picked = pickStream(quality, names);
    if (!picked) throw new RecordingError('unknown_clip', 'clip has no file');
    if (signal?.aborted) throw abortError();
    const { name, served } = picked;
    // No main file listed (it may still be being written): a 4K request never
    // gets the sub file for a proxied camera (no silent downgrade). Without a
    // cam-proxy, the other stream is served, labelled by it, as before.
    if (quality === 'main' && served === 'sub' && proxyActive(cameraId)) {
      throw new RecordingError('full_quality_unavailable', 'the full-resolution file is not listed yet');
    }
    const t = clipId.slice(9, 15);
    const filename = `${camsIdOf(cameraId)}-${clipDate(clipId)}_${t.slice(0, 2)}-${t.slice(2, 4)}-${t.slice(4, 6)}-${served}.mp4`;

    // 1. The proxy's recordings API (the SD file), outside the camera's slot.
    const fromSd = await this.viaProxy(cameraId, clipId, () => openProxyRecording(cameraId, baseName(name), signal), signal);
    if (fromSd) return this.handOver(fromSd, filename, () => undefined, signal, { cameraId, clipId });
    if (signal?.aborted) throw abortError();

    // 2. Its FTP copy, for the sub stream only.
    if (served === 'sub') {
      const ftp = await this.proxyClip(cameraId, clipId);
      if (ftp) {
        try {
          const got = await openProxyClip(cameraId, ftp.id, signal);
          return this.handOver(got, filename.replace(/-sub\.mp4$/, '-proxy.mp4'), () => undefined, signal, { cameraId, clipId });
        } catch (err) {
          if (signal?.aborted) throw err;
          logger.warn({ cameraId, clipId, message: (err as Error).message }, 'proxy_clip_fetch_failed');
        }
      }
    }

    // 3. The camera's own download, behind the breaker (no Search while it's
    //    open), the file's path found before its one transfer slot is taken.
    try {
      if (this.refusing(cameraId)) throw new RecordingError('recordings_unavailable', 'the camera is refusing recording downloads');
      const path = await this.cameraPath(cameraId, clipId, name, served);
      // A download someone clicked goes ahead of queued thumbnail fetches. A
      // viewer who leaves frees the slot at once.
      const release = await this.gate(cameraId).acquire({ high: true, signal });
      signal?.addEventListener('abort', release, { once: true });
      const done = () => {
        signal?.removeEventListener('abort', release);
        release();
      };
      try {
        const res = await this.downloadWithRetry(cameraId, path, signal);
        const cl = res.headers['content-length'];
        return this.handOver({ stream: res, size: typeof cl === 'string' && /^\d+$/.test(cl) ? Number(cl) : null }, filename, done, signal);
      } catch (err) {
        done();
        throw err;
      }
    } catch (err) {
      // Only a camera with a cam-proxy in use; without one, the camera's own
      // answer, as before.
      const final = signal?.aborted || (err instanceof RecordingError && err.code === 'unknown_clip');
      if (served === 'main' && !final && proxyActive(cameraId)) throw new RecordingError('full_quality_unavailable', 'the full-resolution file is not available right now');
      throw err;
    }
  }

  // Calls `release` once the stream closes or fails; an abort that came while
  // the stream was opening destroys it.
  private handOver(
    got: { stream: Readable; size: number | null },
    filename: string,
    release: () => void,
    signal?: AbortSignal,
    // A stream from a cam-proxy: an error after the headers (a cut) is logged.
    proxied?: { cameraId: CamKey; clipId: string },
  ): { stream: Readable; filename: string; size: number | null } {
    let released = false;
    const once = () => {
      if (released) return;
      released = true;
      release();
    };
    got.stream.once('close', once);
    got.stream.once('error', once);
    if (proxied) {
      got.stream.once('error', (err: Error) => {
        if (signal?.aborted) return;
        logger.warn({ ...proxied, message: err.message }, 'proxy_recording_cut');
      });
    }
    if (signal?.aborted) {
      got.stream.destroy();
      throw abortError();
    }
    return { stream: got.stream, filename, size: got.size };
  }

  // What the Archive button stores for a plain save (SD or 4K as recorded,
  // cam-proxy's archive contract §2): the SD card's file the download would
  // serve, by its bare name; or, for SD while the proxy's recordings API is
  // failing, its FTP copy, as the download would fall back to. A file only
  // from this camera's own lists, never from the request. null: neither
  // (4K not listed, or no copy).
  async archiveSource(cameraId: CamKey, clipId: string, quality: 'sub' | 'main'): Promise<{ type: 'recording'; id: string } | { type: 'clip'; clipId: number } | null> {
    const names = await this.names(cameraId, clipId);
    const picked = pickStream(quality, names);
    if (!picked || picked.served !== quality) return null; // no silent downgrade
    if (quality === 'sub' && this.proxyRecordingsFailed.get(cameraId)) {
      const ftp = await this.proxyClipOf(cameraId, clipId);
      if (ftp) return { type: 'clip', clipId: ftp.id };
    }
    return { type: 'recording', id: baseName(picked.name) };
  }

  // Whether a 4K (main) download can be served now, without a transfer: the
  // proxy knows the main file (a plain 404 HEAD stays optimistic: an older
  // proxy, or a gone file the download then reports), or the proxy fails and
  // the camera served a download recently with its breaker closed (proxied
  // cameras only). The Save dialog asks before offering 4K's Save (Klaus, 2026-10-02).
  // A camera without a proxy (or with it switched off) is always available:
  // the dialog offers 4K as it always did and the download answers as ever.
  async mainAvailable(cameraId: CamKey, clipId: string): Promise<boolean> {
    if (!proxyActive(cameraId)) return true;
    const { main } = await this.names(cameraId, clipId);
    if (!main) return false;
    const known = await this.viaProxy(cameraId, clipId, async () => {
      try {
        await headProxyRecording(cameraId, baseName(main));
      } catch (err) {
        if (!(err instanceof ProxyError && err.status === 404)) throw err;
      }
      return true;
    }, undefined, false);
    if (known) return true;
    if (this.breakerOpen(cameraId)) return false;
    const okAt = this.cameraDownloadOkAt.get(cameraId);
    return okAt !== undefined && performance.now() - okAt < CAMERA_DOWNLOAD_RECENT_MS;
  }
}

let service: RecordingsService | null = null;

export function getRecordings(): RecordingsService {
  service ??= new RecordingsService(
    new DiskCache(process.env.CACHE_DIR || join(tmpdir(), 'cams-cache'), Number(process.env.CACHE_MAX_BYTES) || 1.5 * 1024 ** 3),
  );
  return service;
}

export function resetRecordings(): void {
  service = null;
}
