import { promises as fs, createWriteStream } from 'fs';
import { IncomingMessage } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { getClient } from '../reolink/clients';
import { CameraError } from '../reolink/client';
import { clipIdOf, clipTimes, CLIP_ID, parseClipName, ParsedClip, Trigger } from './clipNames';
import { DiskCache } from './cache';
import { PriorityGate } from './priorityGate';
import { makeThumbnail } from './thumbnail';

export interface EventClip {
  id: string;
  start: string;
  end: string;
  durationSec: number;
  triggers: Trigger[];
  sizeSub: number | null;
  sizeMain: number | null;
}

export class RecordingError extends Error {
  constructor(readonly code: 'unknown_clip' | 'thumbnail_unavailable', message: string) {
    super(message);
    this.name = 'RecordingError';
  }
}

interface DayEntry {
  at: number;
  events: EventClip[];
  names: Map<string, { sub?: string; main?: string }>;
}

const TODAY_TTL = 30_000;
const PAST_TTL = 600_000;
const MONTH_TTL = 300_000;
// The camera's own web UI allows one download at a time (CheckDownload's
// downloadTask), and overlapping downloads left it refusing all of them
// until a power cycle.
const TRANSFERS_PER_CAMERA = 1;
const DOWNLOAD_RETRY_DELAY_MS = Number(process.env.DOWNLOAD_RETRY_DELAY_MS) || 1000;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

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
// Exported for a direct unit test of the fallback (the mock camera always
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

export class RecordingsService {
  private readonly days_ = new Map<string, { at: number; days: string[] }>();
  private readonly daysInflight = new Map<string, Promise<DayEntry>>();
  private readonly dayCache = new Map<string, DayEntry>();
  private readonly transfers = new Map<string, PriorityGate>();

  constructor(private readonly cache: DiskCache) {}

  private client(cameraId: string) {
    const c = getClient(cameraId);
    if (!c) throw new RecordingError('unknown_clip', 'unknown camera');
    return c;
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

  async days(cameraId: string, month: string): Promise<string[]> {
    const key = `${cameraId}|${month}`;
    const hit = this.days_.get(key);
    if (hit && Date.now() - hit.at < MONTH_TTL) return hit.days;
    const days = await this.client(cameraId).searchMonth(month);
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
      const [sub, main] = await Promise.all([client.searchDay(date, 'sub'), client.searchDay(date, 'main')]);
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
    try {
      return await this.client(cameraId).download(name, signal);
    } catch (err) {
      if (!(err instanceof CameraError) || err.code !== 'camera_offline' || signal?.aborted) throw err;
      await new Promise((r) => setTimeout(r, DOWNLOAD_RETRY_DELAY_MS));
      return this.client(cameraId).download(name, signal);
    }
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
      const path = await this.cache.fill(key, (tmp) =>
        this.gate(cameraId).run(
          async () => {
            const res = await this.downloadWithRetry(cameraId, sub);
            await pipeline(res, createWriteStream(tmp));
          },
          { high: priority === 'high', key },
        ),
      );
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
    return this.cache.fill(jpgKey, (tmp) =>
      this.withClip(cameraId, clipId, async (video) => {
        try {
          await makeThumbnail(video, tmp);
        } catch {
          throw new RecordingError('thumbnail_unavailable', 'thumbnail could not be made');
        }
        const stat = await fs.stat(tmp).catch(() => null);
        if (!stat || stat.size === 0) throw new RecordingError('thumbnail_unavailable', 'thumbnail could not be made');
      }, 'low'),
    );
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

  // Full-quality downloads stream straight through (not cached). The
  // transfer slot is released automatically once the returned stream closes
  // or errors, and is never left held if `signal` aborts before or while
  // waiting for a slot.
  async openDownload(
    cameraId: string,
    clipId: string,
    quality: 'sub' | 'main',
    signal?: AbortSignal,
  ): Promise<{ stream: IncomingMessage; filename: string; size: number | null }> {
    const names = await this.names(cameraId, clipId);
    const picked = pickStream(quality, names);
    if (!picked) throw new RecordingError('unknown_clip', 'clip has no file');
    const { name, served } = picked;
    const date = `${clipId.slice(0, 4)}-${clipId.slice(4, 6)}-${clipId.slice(6, 8)}`;
    const t = clipId.slice(9, 15);
    const filename = `${cameraId}-${date}_${t.slice(0, 2)}-${t.slice(2, 4)}-${t.slice(4, 6)}-${served}.mp4`;

    const { ready, release } = this.acquireTransfer(cameraId, signal);
    await ready;
    let stream: IncomingMessage;
    try {
      stream = await this.downloadWithRetry(cameraId, name, signal);
    } catch (err) {
      release();
      throw err;
    }
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      release();
    };
    stream.once('close', releaseOnce);
    stream.once('error', releaseOnce);
    if (signal?.aborted) {
      stream.destroy();
      throw abortError();
    }
    const cl = stream.headers['content-length'];
    const size = typeof cl === 'string' && /^\d+$/.test(cl) ? Number(cl) : null;
    return { stream, filename, size };
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
