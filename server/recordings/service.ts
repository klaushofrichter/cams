import { createWriteStream } from 'fs';
import { IncomingMessage } from 'http';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { getClient } from '../reolink/clients';
import { Semaphore } from '../reolink/semaphore';
import { clipIdOf, clipTimes, CLIP_ID, parseClipName, ParsedClip, Trigger } from './clipNames';
import { DiskCache } from './cache';
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
const TRANSFERS_PER_CAMERA = 2;

function cameraToday(offsetMinutes: number): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export class RecordingsService {
  private readonly days_ = new Map<string, { at: number; days: string[] }>();
  private readonly daysInflight = new Map<string, Promise<DayEntry>>();
  private readonly dayCache = new Map<string, DayEntry>();
  private readonly transfers = new Map<string, Semaphore>();

  constructor(private readonly cache: DiskCache) {}

  private client(cameraId: string) {
    const c = getClient(cameraId);
    if (!c) throw new RecordingError('unknown_clip', 'unknown camera');
    return c;
  }

  private gate(cameraId: string): Semaphore {
    let g = this.transfers.get(cameraId);
    if (!g) this.transfers.set(cameraId, (g = new Semaphore(TRANSFERS_PER_CAMERA)));
    return g;
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
    const ttl = date === cameraToday(time.stdOffsetMinutes + time.dstOffsetMinutes) ? TODAY_TTL : PAST_TTL;
    const hit = this.dayCache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit;
    const inflight = this.daysInflight.get(key);
    if (inflight) return inflight;
    const work = (async () => {
      const [sub, main] = await Promise.all([client.searchDay(date, 'sub'), client.searchDay(date, 'main')]);
      const byId = new Map<string, { parsed: ParsedClip; sub?: { name: string; size: number }; main?: { name: string; size: number } }>();
      for (const [stream, files] of [['sub', sub], ['main', main]] as const) {
        for (const f of files) {
          const parsed = parseClipName(f.name);
          if (!parsed || parsed.date !== date) continue;
          const id = clipIdOf(parsed);
          const entry = byId.get(id) ?? { parsed };
          entry[stream] = f;
          // The main stream's flags are authoritative for triggers when both exist.
          if (stream === 'main') entry.parsed = { ...parsed, triggers: parsed.triggers.length ? parsed.triggers : entry.parsed.triggers };
          byId.set(id, entry);
        }
      }
      const events: EventClip[] = [...byId.entries()]
        .map(([id, e]) => ({
          id,
          ...clipTimes(e.parsed, time),
          triggers: e.parsed.triggers,
          sizeSub: e.sub?.size ?? null,
          sizeMain: e.main?.size ?? null,
        }))
        .sort((a, b) => (a.start < b.start ? -1 : 1));
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

  async clipFile(cameraId: string, clipId: string): Promise<string> {
    const { sub } = await this.names(cameraId, clipId);
    if (!sub) throw new RecordingError('unknown_clip', 'clip has no sub stream');
    const key = this.key(cameraId, clipId, 'mp4');
    return this.cache.fill(key, (tmp) =>
      this.gate(cameraId).run(async () => {
        const res = await this.client(cameraId).download(sub);
        await pipeline(res, createWriteStream(tmp));
      }),
    );
  }

  async thumbnail(cameraId: string, clipId: string): Promise<string> {
    const video = await this.clipFile(cameraId, clipId);
    const videoKey = this.key(cameraId, clipId, 'mp4');
    this.cache.pin(videoKey);
    try {
      return await this.cache.fill(this.key(cameraId, clipId, 'jpg'), async (tmp) => {
        try {
          await makeThumbnail(video, tmp);
        } catch {
          throw new RecordingError('thumbnail_unavailable', 'thumbnail could not be made');
        }
      });
    } finally {
      this.cache.unpin(videoKey);
    }
  }

  pinned<T>(key: string, fn: () => Promise<T>): Promise<T> {
    this.cache.pin(key);
    return fn().finally(() => this.cache.unpin(key));
  }

  videoKey(cameraId: string, clipId: string): string {
    return this.key(cameraId, clipId, 'mp4');
  }

  // Full-quality downloads stream straight through (not cached). The caller
  // must call release() once the response has ended or closed.
  async openDownload(
    cameraId: string,
    clipId: string,
    quality: 'sub' | 'main',
  ): Promise<{ stream: IncomingMessage; filename: string; release: () => void }> {
    const names = await this.names(cameraId, clipId);
    const name = quality === 'main' ? (names.main ?? names.sub) : (names.sub ?? names.main);
    if (!name) throw new RecordingError('unknown_clip', 'clip has no file');
    const date = `${clipId.slice(0, 4)}-${clipId.slice(4, 6)}-${clipId.slice(6, 8)}`;
    const t = clipId.slice(9, 15);
    const filename = `${cameraId}-${date}_${t.slice(0, 2)}-${t.slice(2, 4)}-${t.slice(4, 6)}-${quality}.mp4`;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    void this.gate(cameraId).run(async () => {
      acquired();
      await slot;
    });
    await got;
    try {
      const stream = await this.client(cameraId).download(name);
      return { stream, filename, release };
    } catch (err) {
      release();
      throw err;
    }
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
