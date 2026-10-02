import { promises as fs, createWriteStream } from 'fs';
import { IncomingMessage } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { proxyActive } from '../cameraRegistry';
import { getClient } from '../reolink/clients';
import { logger } from '../logger';
import { CameraError } from '../reolink/client';
import { clipIdOf, clipTimes, CLIP_ID, parseClipName, ParsedClip, TimeInfo, Trigger } from './clipNames';
import { DiskCache } from './cache';
import { PriorityGate } from './priorityGate';
import { makeThumbnail } from './thumbnail';
import { Semaphore } from '../reolink/semaphore';
import { findProxyClip, findProxyStill, openProxyClip, openProxyStill } from './proxyClips';
import { RecordingError } from './errors';
import { fallsBack, headProxyRecording, listProxyDays, listProxyRecordings, logProxyFailure, openProxyRecording, type ProxyRecording } from './proxyRecordings';
import { ProxyError } from '../proxy/client';
export { RecordingError } from './errors';

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
}

const TODAY_TTL = 30_000;
const PAST_TTL = 600_000;
const MONTH_TTL = 300_000;
// The camera's own web UI allows one download at a time (CheckDownload's
// downloadTask), and overlapping downloads left it refusing all of them
// until a power cycle.
const TRANSFERS_PER_CAMERA = 1;
const BREAKER_FAILURES = 3;
const RECORDINGS_PROBE_MS = () => Number(process.env.RECORDINGS_PROBE_MS) || 60_000;
const DOWNLOAD_RETRY_DELAY_MS = Number(process.env.DOWNLOAD_RETRY_DELAY_MS) || 1000;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
// The camera Search cache behind cameraPath(): this many camera/day/stream
// entries, least recently used out first.
export const CAMERA_PATHS_MAX = 64;

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

// YYYYMMDD-HHMMSS-HHMMSS → YYYY-MM-DD.
function dateOf(clipId: string): string {
  return `${clipId.slice(0, 4)}-${clipId.slice(4, 6)}-${clipId.slice(6, 8)}`;
}

// A camera-local day's bounds in unix ms, for the proxy's list. TimeInfo
// doesn't say whether DST is in effect that day, so the window runs from
// midnight at the DST offset to the next midnight at standard time; the
// list is filtered by the names' date afterwards. At most 25 hours.
export function dayBounds(date: string, t: TimeInfo): { from: number; to: number } {
  const midnight = Date.parse(`${date}T00:00:00Z`);
  return {
    from: midnight - (t.stdOffsetMinutes + t.dstOffsetMinutes) * 60_000,
    to: midnight + 86_400_000 - t.stdOffsetMinutes * 60_000 - 1,
  };
}

// 'proxy-recordings': from the cam-proxy's recordings API (the SD card).
// 'proxy': the camera has a cam-proxy, but its last recordings request
// failed, so recordings come from its FTP copies. 'ok' and 'unavailable':
// cameras without a proxy (the camera's breaker).
export type DownloadsState = 'ok' | 'proxy-recordings' | 'proxy' | 'unavailable';

export class RecordingsService {
  private readonly days_ = new Map<string, { at: number; days: string[] }>();
  private readonly daysInflight = new Map<string, Promise<DayEntry>>();
  private readonly dayCache = new Map<string, DayEntry>();
  private readonly transfers = new Map<string, PriorityGate>();
  // Per camera with a cam-proxy: whether its last recordings request failed.
  private readonly proxyRecordingsFailed = new Map<string, boolean>();

  // Runs `ask` against the camera's cam-proxy (spec 2026-10-02). null: "use
  // the next route" (no proxy in use, or a failure that falls back, logged as
  // proxy_recordings_failed). A recording gone from the SD card
  // (unknown_clip) and an abort are thrown. `what` is the clip id, or the day
  // or month being listed, for the log. `record` false: a read-only question
  // that leaves the downloads state alone.
  private async viaProxy<T>(cameraId: string, what: string, ask: () => Promise<T>, signal?: AbortSignal, record = true): Promise<T | null> {
    if (!proxyActive(cameraId)) return null;
    try {
      const value = await ask();
      if (record) this.proxyRecordingsFailed.set(cameraId, false);
      return value;
    } catch (err) {
      if (record && err instanceof RecordingError) this.proxyRecordingsFailed.set(cameraId, false); // the proxy answered
      if (!fallsBack(err, signal)) throw err;
      if (record) this.proxyRecordingsFailed.set(cameraId, true);
      logProxyFailure(cameraId, what, err);
      return null;
    }
  }

  constructor(private readonly cache: DiskCache) {}

  // A cam-proxy said this camera's recordings changed around `ts`: the next
  // day and month lists ask the camera again (the day before and after too,
  // for events near midnight).
  async invalidateAround(cameraId: string, ts: number): Promise<void> {
    const time = await this.client(cameraId).timeInfo();
    const offset = time.stdOffsetMinutes + time.dstOffsetMinutes;
    for (const t of [ts - 86_400_000, ts, ts + 86_400_000]) {
      const date = cameraToday(offset, t);
      this.dayCache.delete(`${cameraId}|${date}`);
      this.days_.delete(`${cameraId}|${date.slice(0, 7)}`);
    }
  }

  private client(cameraId: string) {
    const c = getClient(cameraId);
    if (!c) throw new RecordingError('unknown_clip', 'unknown camera');
    return c;
  }

  private stillGates = new Map<string, Semaphore>();
  private stillGate(cameraId: string): Semaphore {
    let g = this.stillGates.get(cameraId);
    if (!g) this.stillGates.set(cameraId, (g = new Semaphore(3)));
    return g;
  }

  private gate(cameraId: string): PriorityGate {
    let g = this.transfers.get(cameraId);
    if (!g) this.transfers.set(cameraId, (g = new PriorityGate(TRANSFERS_PER_CAMERA)));
    return g;
  }

  // Test-only instrumentation (fix round 1, item 8): how many transfers for
  // this camera are queued behind the one active slot right now.
  transferQueueLength(cameraId: string): number {
    return this.gate(cameraId).queued;
  }

  // Acquires a transfer slot for this camera, honoring an optional abort
  // signal. Signalling abort before a slot is granted rejects `ready`
  // immediately and never touches the gate (if the signal is already
  // aborted) or frees the slot the instant the queued acquisition is
  // eventually handed one (the gate has no dequeue, so the queued callback
  // still runs when its turn comes, but returns at once because its wait
  // promise is already resolved, so the next waiter gets it right away).
  // The caller must call release() when done with the slot; calling it more
  // than once, or after an abort already did, is harmless.
  private acquireTransfer(cameraId: string, signal?: AbortSignal): { ready: Promise<void>; release: () => void } {
    let settled = false;
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    let resolveReady!: () => void;
    let rejectReady!: (err: unknown) => void;
    const ready = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    const onAbort = () => {
      if (settled) {
        releaseHeld();
        return;
      }
      settled = true;
      rejectReady(abortError());
      releaseHeld();
    };
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
      // A download someone clicked goes ahead of queued thumbnail fetches.
      void this.gate(cameraId).run(
        async () => {
          if (settled) return; // aborted while queued; bail at once, freeing the slot
          settled = true;
          resolveReady();
          await held;
        },
        { high: true },
      );
    }
    return {
      ready,
      release: () => {
        signal?.removeEventListener('abort', onAbort);
        releaseHeld();
      },
    };
  }

  // A camera with a cam-proxy: the proxy's month list, so the camera is
  // searched by the proxy's one searcher only (an overlapping Search comes
  // back empty without an error); its own month Search when the proxy can't.
  async days(cameraId: string, month: string): Promise<string[]> {
    const key = `${cameraId}|${month}`;
    const hit = this.days_.get(key);
    if (hit && Date.now() - hit.at < MONTH_TTL) return hit.days;
    const days = (await this.viaProxy(cameraId, month, () => listProxyDays(cameraId, month))) ?? (await this.client(cameraId).searchMonth(month));
    this.days_.set(key, { at: Date.now(), days });
    return days;
  }

  private async day(cameraId: string, date: string): Promise<DayEntry> {
    const key = `${cameraId}|${date}`;
    const client = this.client(cameraId);
    const time = await client.timeInfo();
    const ttl = isRecentDay(date, time.stdOffsetMinutes + time.dstOffsetMinutes) ? TODAY_TTL : PAST_TTL;
    const hit = this.dayCache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit;
    const inflight = this.daysInflight.get(key);
    if (inflight) return inflight;
    const work = (async () => {
      // A camera with a cam-proxy: the proxy's list, sub then main, from the
      // camera-local day's bounds; its own Search when the proxy can't answer.
      const { from, to } = dayBounds(date, time);
      const files = (list: ProxyRecording[]) => list.map((r) => ({ name: r.id, size: r.size }));
      const proxied = await this.viaProxy(cameraId, date, async () => {
        const subList = files(await listProxyRecordings(cameraId, from, to, 'sub'));
        const mainList = files(await listProxyRecordings(cameraId, from, to, 'main'));
        return [subList, mainList] as const;
      });
      const [sub, main] = proxied ?? (await Promise.all([client.searchDay(date, 'sub'), client.searchDay(date, 'main')]));
      // Keyed by start time: the firmware can end an event's main-stream copy
      // a few seconds after its sub-stream copy (065221_065224 vs
      // 065221_065226), so both halves of one event share only the start.
      const byStart = new Map<string, { parsed: ParsedClip; sub?: { name: string; size: number }; main?: { name: string; size: number } }>();
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
      const entry = { at: Date.now(), events, names };
      this.dayCache.set(key, entry);
      return entry;
    })().finally(() => this.daysInflight.delete(key));
    this.daysInflight.set(key, work);
    return work;
  }

  async events(cameraId: string, date: string): Promise<EventClip[]> {
    return (await this.day(cameraId, date)).events;
  }

  // Review focus 1: ids are validated and resolved only through this
  // camera's own Search results; a camera path never comes from the client.
  private async names(cameraId: string, clipId: string): Promise<{ sub?: string; main?: string }> {
    if (!CLIP_ID.test(clipId)) throw new RecordingError('unknown_clip', 'malformed clip id');
    const date = `${clipId.slice(0, 4)}-${clipId.slice(4, 6)}-${clipId.slice(6, 8)}`;
    const names = (await this.day(cameraId, date)).names.get(clipId);
    if (!names) throw new RecordingError('unknown_clip', 'no such clip');
    return names;
  }

  private key(cameraId: string, clipId: string, ext: string): string {
    return `${cameraId}_${clipId}.${ext}`;
  }

  // Pins the clip's cached sub-stream file for as long as `use` needs it:
  // pinned BEFORE fill() starts and unpinned only once `use` is done, so a
  // concurrent evict() from another key filling at the same time can never
  // remove this file out from under a reader.
  // The camera occasionally resets a Download before sending anything, and
  // the same request succeeds moments later: retry that case once.
  private async downloadWithRetry(cameraId: string, name: string, signal?: AbortSignal): Promise<IncomingMessage> {
    const probe = this.guard(cameraId);
    try {
      let res: IncomingMessage;
      try {
        res = await this.client(cameraId).download(name, signal);
      } catch (err) {
        // A probe is a single try: it only asks whether downloads work again.
        if (probe || !(err instanceof CameraError) || err.code !== 'camera_offline' || signal?.aborted) throw err;
        await new Promise((r) => setTimeout(r, DOWNLOAD_RETRY_DELAY_MS));
        res = await this.client(cameraId).download(name, signal);
      }
      if (this.health.has(cameraId)) {
        if ((this.health.get(cameraId)?.failures ?? 0) >= BREAKER_FAILURES) logger.info({ cameraId }, 'recordings_breaker_closed');
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

  private noteRefused(cameraId: string): void {
    const h = this.health.get(cameraId) ?? { failures: 0, lastProbeAt: 0 };
    h.failures++;
    h.lastProbeAt = performance.now();
    this.health.set(cameraId, h);
    if (h.failures === BREAKER_FAILURES) logger.warn({ cameraId }, 'recordings_breaker_opened');
  }

  // The breaker is open and no probe is due: a camera download would be
  // refused by guard(). A peek; it changes nothing.
  private refusing(cameraId: string): boolean {
    const h = this.health.get(cameraId);
    return !!h && h.failures >= BREAKER_FAILURES && performance.now() - h.lastProbeAt < RECORDINGS_PROBE_MS();
  }

  // Runs inside the transfer slot, right before a camera download, so
  // requests queued before the breaker opened are refused too.
  // Returns true when this call is the probe.
  private guard(cameraId: string): boolean {
    const h = this.health.get(cameraId);
    if (!h || h.failures < BREAKER_FAILURES) return false;
    if (performance.now() - h.lastProbeAt < RECORDINGS_PROBE_MS()) {
      throw new RecordingError('recordings_unavailable', 'the camera is refusing recording downloads');
    }
    h.lastProbeAt = performance.now(); // this request is the probe
    logger.info({ cameraId }, 'recordings_breaker_probe');
    return true;
  }

  // An open page stops asking for thumbnails once they fail, so the list
  // refresh drives recovery: when a probe is due, fetch the newest clip in
  // the background (through the same gate and guard: still one probe per
  // interval) so the next events response can report 'ok' again.
  probeIfDue(cameraId: string, clipId: string | undefined): void {
    const h = this.health.get(cameraId);
    if (!clipId || !h || h.failures < BREAKER_FAILURES || performance.now() - h.lastProbeAt < RECORDINGS_PROBE_MS()) return;
    void this.withClip(cameraId, clipId, async () => undefined, 'low').catch(() => undefined);
  }

  downloadsState(cameraId: string): DownloadsState {
    if (proxyActive(cameraId)) return this.proxyRecordingsFailed.get(cameraId) ? 'proxy' : 'proxy-recordings';
    return (this.health.get(cameraId)?.failures ?? 0) >= BREAKER_FAILURES ? 'unavailable' : 'ok';
  }

  // The event's start and end, from the day's list.
  private async eventSpan(cameraId: string, clipId: string): Promise<{ start: number; end: number } | null> {
    const date = `${clipId.slice(0, 4)}-${clipId.slice(4, 6)}-${clipId.slice(6, 8)}`;
    const ev = (await this.day(cameraId, date)).events.find((e) => e.id === clipId);
    return ev ? { start: Date.parse(ev.start), end: Date.parse(ev.end) } : null;
  }

  // The proxy's clip for an event (composed clips, cam-proxy spec 2026-09-28):
  // null when it has none; a failed lookup throws (issue #76).
  async proxyClipOf(cameraId: string, clipId: string): Promise<{ id: number } | null> {
    if (!proxyActive(cameraId)) return null;
    const span = await this.eventSpan(cameraId, clipId);
    if (!span) return null;
    const clip = await findProxyClip(cameraId, span.start, span.end);
    if (clip) logger.info({ cameraId, clipId, proxyClip: clip.id }, 'recording_from_proxy');
    return clip;
  }

  // The proxy's clip for the event, for a camera with a cam-proxy (Plan 7:
  // asked first; Plan 6: when the camera refuses). A failed lookup: none.
  private async proxyClip(cameraId: string, clipId: string): Promise<{ id: number } | null> {
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
  private async cameraPath(cameraId: string, clipId: string, name: string, stream: 'sub' | 'main'): Promise<string> {
    if (name.includes('/')) return name;
    const key = `${cameraId}|${dateOf(clipId)}|${stream}`;
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
      const files = await this.client(cameraId).searchDay(dateOf(clipId), stream);
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
    cameraId: string,
    clipId: string,
    use: (path: string) => Promise<T>,
    priority: 'high' | 'low' = 'high',
  ): Promise<T> {
    const { sub } = await this.names(cameraId, clipId);
    if (!sub) throw new RecordingError('unknown_clip', 'clip has no sub stream');
    const key = this.key(cameraId, clipId, 'mp4');
    this.cache.pin(key);
    try {
      if (priority === 'high') this.gate(cameraId).promote(key);
      const path = await this.cache.fill(key, async (tmp) => {
        // 1. The proxy's recordings API: the SD file, fetched over Baichuan
        //    (spec 2026-10-02), outside the camera's transfer slot (the proxy
        //    queues its own transfers). A gone recording ends here. No outer
        //    timeout: the proxy may hold the headers up to 120 s while a
        //    queued download finishes (openProxyRecording's own limit).
        const fromSd = await this.viaProxy(cameraId, clipId, async () => {
          const { stream, size } = await openProxyRecording(cameraId, baseName(sub));
          const out = createWriteStream(tmp);
          await pipeline(stream, out);
          // A body that ends cleanly but short is a failed transfer too.
          if (size !== null && out.bytesWritten !== size) throw new ProxyError('proxy_error', 'short recording');
          return true;
        });
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

  // The mp4 is fetched (via withClip) only when the jpg isn't already
  // cached: DiskCache.fill() checks that internally before ever invoking
  // this producer, so a cached thumbnail is served without touching the
  // camera at all.
  async thumbnail(cameraId: string, clipId: string): Promise<string> {
    const jpgKey = this.key(cameraId, clipId, 'jpg');
    return this.cache.fill(jpgKey, async (tmp) => {
      // A camera with a cam-proxy: its still 2 s into the event (Plan 7),
      // no clip transfer and no ffmpeg.
      if (proxyActive(cameraId)) {
        try {
          // At most three at a time per camera, lookups included: a day's
          // list asked for all its thumbnails at once (issues #38, #76).
          const got = await this.stillGate(cameraId).run(async () => {
            const span = await this.eventSpan(cameraId, clipId);
            const ts = span && (await findProxyStill(cameraId, span.start + 2000, span.start + 12_000));
            if (!ts) return false;
            await pipeline(await openProxyStill(cameraId, ts), createWriteStream(tmp));
            return true;
          });
          if (got) {
            // Only a JPEG becomes the (cached) thumbnail.
            const head = await fs.readFile(tmp).then((b) => b.subarray(0, 3)).catch(() => Buffer.alloc(0));
            if (head.length === 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return;
            logger.warn({ cameraId, clipId }, 'proxy_still_not_a_jpeg');
          }
        } catch (e) {
          logger.warn({ cameraId, clipId, message: (e as Error).message }, 'proxy_still_failed');
        }
      }
      await this.clipThumbnail(cameraId, clipId, tmp);
    });
  }

  private clipThumbnail(cameraId: string, clipId: string, tmp: string): Promise<void> {
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
  async withThumbnail<T>(cameraId: string, clipId: string, use: (path: string) => Promise<T>): Promise<T> {
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
    cameraId: string,
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
    const filename = `${cameraId}-${dateOf(clipId)}_${t.slice(0, 2)}-${t.slice(2, 4)}-${t.slice(4, 6)}-${served}.mp4`;

    // 1. The proxy's recordings API (the SD file), outside the camera's slot.
    const fromSd = await this.viaProxy(cameraId, clipId, () => openProxyRecording(cameraId, baseName(name), signal), signal);
    if (fromSd) return this.handOver(fromSd, filename, () => undefined, signal);
    if (signal?.aborted) throw abortError();

    // 2. Its FTP copy, for the sub stream only.
    if (served === 'sub') {
      const ftp = await this.proxyClip(cameraId, clipId);
      if (ftp) {
        try {
          const got = await openProxyClip(cameraId, ftp.id, signal);
          return this.handOver(got, filename.replace(/-sub\.mp4$/, '-proxy.mp4'), () => undefined, signal);
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
      const slot = this.acquireTransfer(cameraId, signal);
      await slot.ready;
      try {
        const res = await this.downloadWithRetry(cameraId, path, signal);
        const cl = res.headers['content-length'];
        return this.handOver({ stream: res, size: typeof cl === 'string' && /^\d+$/.test(cl) ? Number(cl) : null }, filename, slot.release, signal);
      } catch (err) {
        slot.release();
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
  ): { stream: Readable; filename: string; size: number | null } {
    let released = false;
    const once = () => {
      if (released) return;
      released = true;
      release();
    };
    got.stream.once('close', once);
    got.stream.once('error', once);
    if (signal?.aborted) {
      got.stream.destroy();
      throw abortError();
    }
    return { stream: got.stream, filename, size: got.size };
  }

  // Whether a 4K (main) download can be served now, without a transfer: the
  // proxy knows the main file, or the camera's download breaker is closed.
  // The Save dialog asks before offering 4K's Save (Klaus, 2026-10-02).
  async mainAvailable(cameraId: string, clipId: string): Promise<boolean> {
    const { main } = await this.names(cameraId, clipId);
    if (!main) return false;
    const known = await this.viaProxy(cameraId, clipId, async () => {
      await headProxyRecording(cameraId, baseName(main));
      return true;
    }, undefined, false);
    return known ?? (this.health.get(cameraId)?.failures ?? 0) < BREAKER_FAILURES;
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
